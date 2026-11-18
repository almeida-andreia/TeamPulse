const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");
const { configuredMinimum } = require("../server/reporting");
const dimensionKeys = ["wellbeing", "workload", "stress", "teamIntegration", "psychologicalSafety"];

// Isolated aggregate-query fixtures only. This is not a PostgreSQL connection or
// production/dashboard seed. No frontend adapter serves these fixture numbers.
function fixture({ minimum = 5, smallTeam = false } = {}) {
    const users = [
        { user_id: "00000000-0000-4000-8000-000000000001", sso_subject: "employee-05", display_name: "Beatriz Sousa", role: "employee", is_active: true },
        { user_id: "00000000-0000-4000-8000-000000000101", sso_subject: "manager-platform", display_name: "Mara Duarte", role: "manager", is_active: true },
        { user_id: "00000000-0000-4000-8000-000000000201", sso_subject: "hr-marta", display_name: "Marta Pinto", role: "hr", is_active: true }
    ];
    const teams = [{ team_id: "1", name: "Platform", department_id: "1", department_name: "Engineering", manager: users[1].user_id },
        { team_id: "2", name: "Product", department_id: "1", department_name: "Engineering", manager: "another-manager" }];
    if (smallTeam) teams.push({ team_id: "3", name: "Operations", department_id: "2", department_name: "People and Operations", manager: "third-manager" });
    const calendar = Array.from({ length: 8 }, (_, i) => {
        const date = new Date("2026-09-14T12:00:00Z"); date.setUTCDate(date.getUTCDate() + i * 7);
        return { week_start: date.toISOString().slice(0, 10) };
    });
    const cohorts = calendar.flatMap(({ week_start }) => teams.map((team) => {
        const responses = team.team_id === "1" ? 12 : team.team_id === "2" ? 10 : 2;
        const means = [team.team_id === "1" ? 8 : 5, 6, 5, 7, 7.5];
        return { team_id: team.team_id, department_id: team.department_id, department_name: team.department_name,
            week_start, responses, eligible: team.team_id === "3" ? 2 : 15,
            ...Object.fromEntries(dimensionKeys.flatMap((key, i) => [[`${key}Sum`, means[i] * responses], [`${key}Count`, responses]])) };
    }));
    const factors = calendar.flatMap(({ week_start }) => teams.flatMap((team) => [
        { code: "workload", label: "Workload", selected: team.team_id === "1" ? 6 : team.team_id === "2" ? 5 : 1 },
        { code: "deadlines", label: "Deadlines", selected: 1 },
        { code: "communication", label: "Team communication", selected: team.team_id === "1" ? 11 : 1 },
        { code: "difficulty_integrating", label: "Difficulty integrating", selected: 0 },
        { code: "unclear_priorities", label: "Lack of clarity", selected: 0 },
        { code: "limited_support", label: "Lack of support", selected: 0 },
        { code: "work_life_balance", label: "Work-life balance", selected: 0 },
        { code: "organizational_changes", label: "Organizational changes", selected: 0 },
        { code: "tools_processes", label: "Tools and processes", selected: 6 }
    ].map((factor) => ({ team_id: team.team_id, week_start,
        measured: team.team_id === "1" ? 12 : team.team_id === "2" ? 10 : 2, ...factor }))));
    const departments = [...new Map(teams.map((t) => [t.department_id,
        { department_id: t.department_id, name: t.department_name }])).values()];
    const calls = [], db = { users, teams, departments, cohorts, factors, calendar, calls, failure: false, periodPeople: {}, organizationPeople: {} };
    const pool = { async query(sql, args = []) {
        calls.push({ sql, args });
        if (db.failure) throw new Error("private SQL response_id password=not-for-browser");
        const result = (rows) => ({ rows: structuredClone(rows) });
        if (sql.includes("SELECT user_id FROM identity.users")) return result(users.filter((user) => user.sso_subject === args[1]
            && user.is_active && user.role === (args[2] ?? "employee")).map((user) => ({ user_id: user.user_id })));
        if (sql.includes("SELECT user_id, display_name")) return result(users.filter((user) => user.user_id === args[0]));
        if (sql.includes("reporting:teams")) return result(teams.filter((team) => !args.length || team.manager === args[0])
            .map(({ manager, ...team }) => team));
        if (sql.includes("reporting:cohorts")) return result(cohorts.filter((row) => args[0].includes(row.team_id)));
        if (sql.includes("reporting:departments")) return result(departments);
        if (sql.includes("reporting:challenges")) return result(factors.filter((row) => args[0].includes(row.team_id)));
        if (sql.includes("reporting:organization-themes")) {
            const period = (await pool.query("/* reporting:theme-period */", args)).rows;
            return result(JSON.parse(args[4]).map(({ code, hidden_departments }) => {
                const rows = period.filter((row) => row.code === code);
                const aggregate = (cells, prefix = "") => Object.fromEntries(["measured", "selected", "participants", "selecting_participants", "nonselecting_participants"]
                    .map((key) => [prefix + key, cells.reduce((sum, row) => sum + (Number(row.measured) > 0 ? Number(row[key]) : 0), 0)]));
                // Default contributor sets are disjoint between fixture teams;
                // explicit overrides model shared contributors after transfers.
                return { code, ...aggregate(rows), ...aggregate(rows.filter((row) => hidden_departments.includes(String(row.department_id))), "residual_"),
                    ...db.organizationPeople[code] };
            }));
        }
        if (sql.includes("reporting:theme-period")) {
            const scoped = cohorts.filter((r) => args[0].includes(r.team_id) && args[3].includes(r.week_start));
            const keys = [...new Set(scoped.map((r) => `${r.team_id}/${r.department_id}`))];
            return result(keys.flatMap((key) => {
                const rows = scoped.filter((r) => `${r.team_id}/${r.department_id}` === key);
                return args[1].flatMap((code) => {
                    const cells = rows.map((row) => factors.find((f) => f.team_id === row.team_id && f.week_start === row.week_start && f.code === code));
                    if (cells.some((cell) => !cell)) return [];
                    // These are aggregate-only fixtures. Fixed contributor sets
                    // are the default; explicit overrides model rotating people.
                    const measured = cells.reduce((n, f) => n + f.measured, 0), selected = cells.reduce((n, f) => n + f.selected, 0);
                    const participants = Math.max(...rows.map((r) => r.responses));
                    return [{ team_id: rows[0].team_id, department_id: rows[0].department_id, code, label: cells[0].label,
                        measured, selected, participants, selecting_participants: Math.min(participants, Math.max(...cells.map((f) => f.selected))),
                        nonselecting_participants: Math.min(participants, Math.max(...cells.map((f) => f.measured - f.selected))),
                        ...db.periodPeople[`${key}/${code}`] }];
                });
            }));
        }
        if (sql.includes("reporting:calendar")) return result(calendar);
        if (sql.includes("team-events:list")) return result([]);
        throw new Error("Unexpected fixture query");
    } };
    db.app = createApp({ getPool: () => pool, minimumResponses: minimum, sessionSecret: "reporting-test-session-only", prototypeAccess: true });
    db.login = async (role) => {
        const agent = request.agent(db.app);
        await agent.post(`/api/prototype/${role}-session`).send({}).expect(204);
        return agent;
    };
    return db;
}
function assertNoIndividualData(value) {
    const forbidden = new Set(["user_id", "userId", "employeeId", "display_name", "response_id", "responseId", "comment", "comments", "selected", "eligible", "responses", "team_id", "department_id", "participants", "selecting_participants", "nonselecting_participants"]);
    function walk(item) {
        if (!item || typeof item !== "object") return;
        for (const [key, child] of Object.entries(item)) {
            assert(!forbidden.has(key), `Private/internal key ${key} must not reach reporting clients`);
            assert(!key.endsWith("Sum") && !key.endsWith("Count") || key === "responseCount"); walk(child);
        }
    }
    walk(value);
    assert(!JSON.stringify(value).includes("00000000-0000"));
}

test("Manager gets only their authorized team's five aggregate scores and safe challenge percentages", async () => {
    const db = fixture(), agent = await db.login("manager");
    const { body, headers } = await agent.get("/api/manager/overview").expect(200);
    assert.equal(headers["cache-control"], "no-store"); assert.equal(body.teams.length, 1);
    const team = body.teams[0]; assert.equal(team.name, "Platform"); assert.equal(team.responseCount, 12);
    assert.equal(team.departmentName, "Engineering");
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("manager", body);
    assert(html.includes('<h2>Platform</h2><p class="field-help">Engineering &middot; Team</p>'));
    assert(!html.includes("<h2>Product</h2>"), "The department label must not broaden the Manager's team scope");
    assert.deepEqual(team.scores, { wellbeing: 8, workload: 6, stress: 5, teamIntegration: 7, psychologicalSafety: 7.5, workloadBalance: 4 });
    assert.equal(team.challenges.find((c) => c.code === "workload").percentage, 50);
    for (const code of ["deadlines", "communication", "difficulty_integrating"])
        assert.equal(team.challenges.find((c) => c.code === code).percentage, null);
    assert.equal(team.weeks.length, 8); assertNoIndividualData(body);
    const query = db.calls.find((call) => call.sql.includes("reporting:cohorts"));
    assert.deepEqual(query.args, [["1"]]); assert(query.sql.includes("tw.finalized_at IS NOT NULL"));
    assert(query.sql.includes("COUNT(DISTINCT c.user_id)")); assert(query.sql.includes("SUM(r.stress_score)"));
    assert(!query.sql.includes("r.comment"));
});
test("HR receives response-weighted organization and department aggregates, never employee rows", async () => {
    const db = fixture(), agent = await db.login("hr");
    const { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.available, true); assert.equal(body.responseCount, 22); assert.equal(body.participation, 73);
    assert.equal(body.scores.wellbeing, 6.6, "Weighted (12*8 + 10*5)/22, not the unweighted mean 6.5");
    assert.equal(body.departments.length, 1); assert.equal(body.departments[0].name, "Engineering");
    assert.equal(body.departments[0].scores.wellbeing, 6.6);
    assert.equal(body.challenges.find((c) => c.code === "workload").percentage, 50);
    assertNoIndividualData(body);
});

test("decimal ties round consistently for scores, derived balance and signed monthly changes", async () => {
    const db = fixture();
    for (const row of db.cohorts.filter((r) => r.team_id === "1")) {
        const latest = row.week_start === "2026-11-02";
        row.wellbeingSum = latest ? 79.8 : 80.4; // 6.65 versus 6.7
        row.workloadSum = latest ? 40.2 : 39.6; // Balance: 6.65 versus 6.7
        row.stressSum = latest ? 80.4 : 79.8; // 6.7 versus 6.65
    }
    const agent = await db.login("manager");
    const team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
    assert.equal(team.scores.wellbeing, 6.7);
    assert.equal(team.scores.workloadBalance, 6.7);
    assert.equal(team.monthlyChange.wellbeing, -0.1);
    assert.equal(team.monthlyChange.workloadBalance, -0.1);
    assert.equal(team.monthlyChange.stress, 0.1);
    // Values genuinely below/above a tie are not snapped to the tie.
    db.cohorts.at(-2).wellbeingSum = 79.7;
    assert.equal((await agent.get("/api/manager/overview").expect(200)).body.teams[0].scores.wellbeing, 6.6);
});
test("Employee, Manager and HR authorization is enforced at each actual API boundary", async () => {
    const db = fixture(), employee = await db.login("employee"), manager = await db.login("manager"), hr = await db.login("hr");
    for (const endpoint of ["/api/manager/overview", "/api/hr/overview"])
        await request(db.app).get(endpoint).set("X-Role", "manager").set("X-User-Id", db.users[1].user_id).expect(401);
    await employee.get("/api/manager/overview").expect(403); await employee.get("/api/hr/overview").expect(403);
    await manager.get("/api/hr/overview").expect(403); await hr.get("/api/manager/overview").expect(403);
    for (const agent of [manager, hr]) {
        await agent.get("/api/employee/me").expect(403); await agent.get("/api/employee/history").expect(403);
        await agent.get("/api/employee/check-ins/current").expect(403);
        await agent.post("/api/employee/check-ins").send({}).expect(403);
    }
    await manager.get("/api/manager/overview?team_id=2").expect(400);
    await hr.get(`/api/hr/overview?user_id=${db.users[0].user_id}`).expect(400);
    await manager.post("/api/prototype/manager-session").send({ user_id: db.users[0].user_id }).expect(400);
    await manager.get("/api/manager/responses").expect(404); await hr.get("/api/hr/responses").expect(404);
});
test("roles and active status are rechecked from the database, not cached browser claims", async () => {
    const db = fixture(), agent = await db.login("manager");
    db.users[1].role = "employee"; await agent.get("/api/manager/overview").expect(403);
    db.users[1].role = "manager"; db.users[1].is_active = false; await agent.get("/api/manager/overview").expect(401);
});
test("switching Manager/HR to Employee regenerates the session and preserves role separation", async () => {
    const db = fixture(), agent = request.agent(db.app);
    for (const role of ["manager", "hr"]) {
        const reportingSession = await agent.post(`/api/prototype/${role}-session`).send({}).expect(204);
        await agent.get("/api/employee/me").expect(403);
        const employeeSession = await agent.post("/api/prototype/employee-session").send({}).expect(204);
        assert.notEqual(employeeSession.headers["set-cookie"][0], reportingSession.headers["set-cookie"][0], "Session identifiers must rotate when entering Employee access.");
        const { body } = await agent.get("/api/employee/me").expect(200);
        assert.deepEqual(body, { displayName: "Beatriz Sousa", firstName: "Beatriz", role: "employee" });
        await agent.get("/api/manager/overview").expect(403);
        await agent.get("/api/hr/overview").expect(403);
        await agent.delete("/api/prototype/employee-session").expect(204);
        await agent.get("/api/employee/me").expect(401);
        await agent.get("/api/manager/overview").expect(401);
        await agent.get("/api/hr/overview").expect(401);
    }
});
test("unset/invalid thresholds fail closed without querying response aggregates", async () => {
    for (const value of [undefined, "", "1", "0", "-1", "3.5", "no", "Infinity"]) assert.equal(configuredMinimum(value), null);
    assert.equal(configuredMinimum("3"), 3); assert.equal(configuredMinimum(7), 7);
    const db = fixture({ minimum: "" }), agent = await db.login("hr");
    const { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.reason, "privacy_not_configured"); assert.equal(body.scores, null); assert.equal(body.responseCount, null);
    assert(!db.calls.some((call) => call.sql.includes("reporting:cohorts"))); assertNoIndividualData(body);
});
test("a small leaf cohort hides itself and containing rollups; visible siblings cannot reveal it by subtraction", async () => {
    const db = fixture({ smallTeam: true }), agent = await db.login("hr");
    const { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.available, false); assert.equal(body.scores, null); assert.equal(body.responseCount, null);
    assert(body.weeks.every((week) => !week.available && week.scores === null && week.responseCount === null));
    assert.equal(body.departments.find((d) => d.name === "Engineering").available, true);
    const small = body.departments.find((d) => d.name === "People and Operations");
    assert.equal(small.available, false); assert.equal(small.participation, null); assert.equal(small.responseCount, null);
    assert.deepEqual(small.challenges, []); assertNoIndividualData(body);
});
test("small challenge selections/complements in a leaf stay suppressed in larger rollups", async () => {
    const db = fixture();
    for (const factor of db.factors.filter((f) => f.code === "workload" && f.team_id === "2")) factor.selected = 2;
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.challenges.find((c) => c.code === "workload").percentage, null,
        "A safe parent count cannot override Product's rare 2 selections alongside the published sibling");
    assert.equal(body.departments[0].challenges.find((c) => c.code === "workload").percentage, null);
});
test("missing metric answers suppress only that measure; missing/unfinalized cohorts still suppress whole releases", async () => {
    const db = fixture();
    db.cohorts.find((r) => r.team_id === "1" && r.week_start === "2026-11-02").stressCount = 2;
    const manager = await db.login("manager"), { body } = await manager.get("/api/manager/overview").expect(200);
    assert.equal(body.teams[0].available, true); assert.equal(body.teams[0].scores.wellbeing, 8);
    assert.equal(body.teams[0].scores.stress, null); assert.equal(body.teams[0].weeks.at(-1).scores.stress, null);
    assert.equal(body.teams[0].monthlyChange.stress, null); assert.equal(body.teams[0].monthlyChange.wellbeing, 0);
    db.cohorts.splice(db.cohorts.findIndex((r) => r.team_id === "2" && r.week_start === "2026-11-02"), 1);
    const hr = await db.login("hr"), result = await hr.get("/api/hr/overview").expect(200);
    assert(result.body.departments.every((d) => !d.available)); assertNoIndividualData(result.body);
});
test("monthly aggregate deltas use released response-weighted weekly means only", async () => {
    const db = fixture(); const latest = db.cohorts.find((r) => r.team_id === "1" && r.week_start === "2026-11-02");
    latest.wellbeingSum = 7 * latest.responses; latest.stressSum = 6 * latest.responses;
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    assert.equal(body.teams[0].monthlyChange.wellbeing, -1); assert.equal(body.teams[0].monthlyChange.stress, 1);
});

for (const responses of [4, 5, 6]) test(`approved threshold: ${responses} responses ${responses < 5 ? "stay hidden" : "are eligible"}`, async () => {
    const db = fixture();
    for (const row of db.cohorts.filter((r) => r.team_id === "1")) {
        row.responses = responses;
        for (const key of dimensionKeys) { row[`${key}Count`] = responses; row[`${key}Sum`] = 7.5 * responses; }
    }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const team = body.teams[0];
    assert.equal(team.available, responses >= 5);
    assert.equal(team.responseCount, responses >= 5 ? responses : null);
    assert.equal(team.scores?.wellbeing ?? null, responses >= 5 ? 7.5 : null);
    assert.equal(team.participation, responses >= 5 ? Math.round(responses / 15 * 100) : null);
    assertNoIndividualData(body);
});

test("historical missing stress leaves four metrics, participation, themes and deltas independently eligible", async () => {
    const db = fixture();
    for (const row of db.cohorts) { row.stressCount = 0; row.stressSum = null; }
    for (const row of db.factors.filter((f) => ["deadlines", "difficulty_integrating", "organizational_changes"].includes(f.code))) {
        row.measured = 0; row.selected = 0;
    }
    const manager = await db.login("manager"), { body } = await manager.get("/api/manager/overview").expect(200);
    const team = body.teams[0];
    assert.equal(team.available, true); assert.equal(team.participation, 80);
    for (const key of ["wellbeing", "workload", "teamIntegration", "psychologicalSafety", "workloadBalance"])
        assert(Number.isFinite(team.scores[key]));
    assert.equal(team.scores.stress, null); assert.equal(team.monthlyChange.stress, null);
    assert.equal(team.metricAvailability.stress, "not_measured_historically");
    assert(team.weeks.every((w) => w.scores.stress === null));
    assert.equal(team.challenges.length, 8);
    assert(!JSON.stringify(body).includes("tools_processes"));
    for (const code of ["deadlines", "difficulty_integrating", "organizational_changes"]) {
        const factor = team.challenges.find((f) => f.code === code);
        assert.equal(factor.percentage, null); assert.equal(factor.reason, "not_measured_historically");
    }
    assert.equal(team.challenges.find((f) => f.code === "workload").percentage, 50);
    const challengeQuery = db.calls.find((c) => c.sql.includes("reporting:challenges"));
    assert.equal(challengeQuery.args[1].length, 8); assert(!challengeQuery.args[1].includes("tools_processes"));
    assert(challengeQuery.sql.includes("r.stress_score IS NOT NULL"));
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("manager", body, "stress");
    assert(!html.includes("Not measured historically"));
    assert(team.sharedThemes.factors.some((f) => f.reason === "not_measured_historically"));
    const trendSection = html.match(/<section class="card report-trends">[^]*?<\/section>/)[0];
    assert(!trendSection.includes("<circle"), "Missing stress must not create chart points; theme clock icons are unrelated");
    assert(!html.includes("NaN")); assert(!html.includes("Tools and processes"));
    assert(!html.includes('value="0"')); assertNoIndividualData(body);
    const hr = await db.login("hr"), result = await hr.get("/api/hr/overview").expect(200);
    assert.equal(result.body.scores.stress, null); assert.equal(result.body.scores.wellbeing, 6.6);
    assert.equal(result.body.departments[0].scores.stress, null);
});

test("mixed questionnaire versions do not count unasked factors as negative answers", async () => {
    const db = fixture();
    for (const row of db.factors.filter((f) => f.code === "deadlines")) { row.measured = 10; row.selected = 5; }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const factor = body.teams[0].challenges.find((f) => f.code === "deadlines");
    assert.equal(factor.percentage, null); assert.equal(factor.reason, "not_measured_historically");
});

test("metric-specific parent suppression prevents reconstructing a small answered subset from siblings", async () => {
    const db = fixture();
    for (const row of db.cohorts.filter((r) => r.team_id === "2")) { row.stressCount = 4; row.stressSum = 20; }
    const hr = await db.login("hr"), { body } = await hr.get("/api/hr/overview").expect(200);
    assert.equal(body.available, true); assert.equal(body.responseCount, 22);
    assert.equal(body.scores.stress, null); assert.equal(body.departments[0].scores.stress, null);
    assert.equal(body.monthlyChange.stress, null); assert.equal(body.scores.wellbeing, 6.6);
    assert(body.weeks.every((w) => w.scores.stress === null)); assertNoIndividualData(body);
});

test("challenge selections AND complements must each reach five in every leaf", async () => {
    const db = fixture(), agent = await db.login("hr");
    const product = db.factors.filter((f) => f.code === "workload" && f.team_id === "2");
    for (const selected of [0, 4, 5, 6, 10]) {
        for (const row of product) row.selected = selected;
        const { body } = await agent.get("/api/hr/overview").expect(200);
        assert.equal(body.challenges.find((f) => f.code === "workload").percentage, selected === 5 ? 50 : null);
    }
});

test("monthly metric deltas exclude suppressed metric weeks even when other measures are released", async () => {
    const db = fixture();
    for (const row of db.cohorts.filter((r) => r.team_id === "1" && r.week_start.startsWith("2026-10"))) {
        row.stressCount = 4; row.stressSum = 40;
    }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    assert.equal(body.teams[0].scores.stress, 5); assert.equal(body.teams[0].monthlyChange.stress, null);
    assert.equal(body.teams[0].monthlyChange.wellbeing, 0);
});

test("HR department detail releases safe series and monthly changes while the containing organization stays hidden", async () => {
    const db = fixture({ smallTeam: true });
    for (const row of db.cohorts) { row.stressCount = 0; row.stressSum = null; }
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.available, false); assert(body.weeks.every((w) => !w.available));
    const safe = body.departments.find((d) => d.name === "Engineering");
    assert.equal(safe.available, true); assert.equal(safe.weeks.length, 8);
    assert(safe.weeks.every((w) => w.scores.wellbeing === 6.6 && w.scores.stress === null));
    assert.equal(safe.monthlyChange.wellbeing, 0); assert.equal(safe.monthlyChange.stress, null);
    assert.equal(safe.challenges.find((f) => f.code === "workload").percentage, 50);
    const small = body.departments.find((d) => d.name === "People and Operations");
    assert(small.weeks.every((w) => w.scores === null && w.responseCount === null));
    assert.equal(body.minimumResponses, 5); assertNoIndividualData(body);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body);
    assert(html.includes("DEPARTMENT DETAIL")); assert(html.includes('<option value="0" selected>Engineering &middot; Department</option>'));
    assert(html.includes('<h2>Engineering</h2><p class="field-help">Department</p>'));
    assert(!html.includes("<h2>Platform</h2>"), "HR continues to render departments rather than individual team metrics");
    assert(html.includes("6.6<small>/ 10</small>")); assert(html.includes("Stress tracking was introduced after these historical check-ins."));
    assert(html.includes("Organization metrics and themes are evaluated independently")); assert(html.includes("50%")); assert(html.includes("<polyline"));
    const organization = renderOverview("hr", body, "wellbeing", "organization");
    assert(organization.includes("ORGANIZATION TOTAL")); assert(!organization.includes("6.6<small>/ 10</small>"));
    assert(!organization.includes("<polyline"));
    const suppressed = renderOverview("hr", body, "wellbeing", "1");
    assert(suppressed.includes("People and Operations")); assert(!suppressed.includes("<polyline"));
    assert(!suppressed.includes("6.6<small>/ 10</small>"));
});

test("department trends keep only individually safe weeks and do not backfill the latest suppressed cohort", async () => {
    const db = fixture({ smallTeam: true });
    db.cohorts.find((r) => r.team_id === "2" && r.week_start === "2026-10-12").responses = 4;
    db.cohorts.find((r) => r.team_id === "2" && r.week_start === "2026-11-02").responses = 4;
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    const department = body.departments[0];
    assert.equal(department.available, false); assert.equal(department.scores, null);
    assert.equal(department.weeks.filter((w) => w.available).length, 6);
    assert.equal(department.weeks.at(-1).scores, null); assert.equal(department.monthlyChange, null);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body, "wellbeing", "0");
    assert(html.includes("<polyline")); assert(!html.includes("NaN")); assert(!html.includes("undefined"));
});

test("historical department membership drives each department week independently", async () => {
    const db = fixture({ smallTeam: true });
    // Product was in a different department during September. Current identity
    // membership must not rewrite its historical department totals.
    for (const row of db.cohorts.filter((r) => r.team_id === "2" && r.week_start.startsWith("2026-09"))) {
        row.department_id = "3"; row.department_name = "Historical Product Department";
    }
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    const engineering = body.departments.find((d) => d.name === "Engineering");
    assert.equal(engineering.weeks[0].scores.wellbeing, 8); assert.equal(engineering.weeks[0].responseCount, 12);
    assert.equal(engineering.weeks.at(-1).responseCount, 22);
    const old = body.departments.find((d) => d.name === "Historical Product Department");
    assert.equal(old.weeks[0].scores.wellbeing, 5); assert.equal(old.weeks[0].responseCount, 10);
    assert.equal(old.available, false); assert.equal(old.responseCount, null); assertNoIndividualData(body);
});

test("small real-sized team cohorts cannot safely release a challenge even when that factor is commonly selected", async () => {
    const db = fixture();
    for (const row of db.cohorts.filter((r) => r.team_id === "1")) {
        row.responses = 6;
        for (const key of dimensionKeys) { row[`${key}Count`] = 6; row[`${key}Sum`] = 42; }
    }
    for (const row of db.factors.filter((f) => f.team_id === "1")) {
        row.measured = ["deadlines", "difficulty_integrating", "organizational_changes"].includes(row.code) ? 0 : 6;
        row.selected = row.code === "workload" ? 6 : row.code === "unclear_priorities" ? 3 : 2;
    }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    assert.equal(body.teams[0].available, true); assert(body.teams[0].challenges.every((f) => f.percentage === null));
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("manager", body);
    assert(html.includes("at least 5 distinct participants"));
    assert(html.includes("No shared themes are available for this period yet."));
    assert(!html.includes('data-theme-state="protected"')); assert(!html.includes("Not measured historically"));
});

test("HR participation follows the selected department independently of suppressed organization totals and missing stress", async () => {
    const db = fixture({ smallTeam: true });
    for (const row of db.cohorts) { row.stressCount = 0; row.stressSum = null; }
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const card = (scope) => renderOverview("hr", body, "stress", scope).match(/<aside[^>]*><p class="eyebrow">PARTICIPATION<\/p>[^]*?<\/aside>/)?.[0];
    assert.equal(body.available, false); assert.equal(body.participation, null);
    const safe = body.departments[0]; assert.equal(safe.participation, 73); assert.equal(safe.scores.stress, null);
    assert(card(null).includes('class="report-participation">73%</strong>'));
    assert(card("0").includes("Participation in Engineering"));
    assert(card("0").includes("22 anonymous responses"));
    assert(card("organization").includes("Listening across the organization"));
    assert(card("organization").includes('class="report-participation is-unavailable">Participation unavailable</strong>'));
    assert(!card("organization").includes("22 anonymous responses"));
    assert(card("1").includes("Participation in People and Operations"));
    assert(card("1").includes('class="report-participation is-unavailable">Participation unavailable</strong>'));
});

test("participation renders numeric percentages including zero without borrowing a different scope's value", async () => {
    const { renderOverview } = await import("../public/js/reporting.mjs");
    for (const value of [0, 86, 88, 100, null, undefined, "86"]) {
        const department = { name: "Selected department", available: true, scores: { stress: null }, participation: value, responseCount: 6, weeks: [] };
        const data = { source: "postgres", available: false, participation: null, departments: [department] };
        const html = renderOverview("hr", data, "wellbeing", "0");
        assert(html.includes(`class="report-participation${Number.isFinite(value) ? "" : " is-unavailable"}">${Number.isFinite(value) ? `${value}%` : "Participation unavailable"}</strong>`));
        assert(!html.includes("null%")); assert(!html.includes("undefined%"));
    }
});

test("HR participation has its own score-independent release decision and includes every eligible constituent", async () => {
    const db = fixture({ smallTeam: true });
    // Operations is safe in this isolated case. All of its score answers are
    // unavailable, but five completed check-ins still contribute to participation.
    for (const row of db.cohorts) {
        if (row.team_id === "3") { row.responses = 5; row.eligible = 10; }
        for (const key of dimensionKeys) { row[`${key}Count`] = 0; row[`${key}Sum`] = null; }
    }
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.participation, 68, "(12+10+5)/(15+15+10), including Operations");
    assert.deepEqual(body.participationAvailability, { available: true, reason: null });
    assert(Object.values(body.scores).every((value) => value === null));
    assert(body.weeks.every((week) => week.participation === 68 && week.participationAvailability.available));
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body, "stress", "organization");
    assert(html.includes('class="report-participation">68%</strong>'));
    assert(html.includes("Stress tracking was introduced after these historical check-ins.")); assertNoIndividualData(body);
});

test("organization participation remains protected when its rate would reconstruct a small constituent's responders", async () => {
    const db = fixture({ smallTeam: true }), agent = await db.login("hr");
    const { body } = await agent.get("/api/hr/overview").expect(200);
    const numerator = db.cohorts.filter((r) => r.week_start === "2026-11-02").reduce((sum, row) => sum + row.responses, 0);
    const denominator = db.cohorts.filter((r) => r.week_start === "2026-11-02").reduce((sum, row) => sum + row.eligible, 0);
    assert.equal(numerator, 24); assert.equal(denominator, 32); assert(numerator >= 5);
    assert.deepEqual(body.participationAvailability, { available: false, reason: "protected_constituent" });
    assert.equal(body.participation, null); assert.equal(body.responseCount, null);
    assert.equal(body.departments[0].participation, 73); assert.equal(numerator - body.departments[0].responseCount, 2);
    assert.deepEqual(body.departments[1].participationAvailability, { available: false, reason: "insufficient_responses" });
    assert.equal(body.departments[1].participation, null); assertNoIndividualData(body);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body, "wellbeing", "organization");
    const panel = html.match(/<aside[^>]*><p class="eyebrow">PARTICIPATION<\/p>[^]*?<\/aside>/)[0];
    assert(panel.includes("Participation unavailable")); assert(panel.includes("by subtraction")); assert(!panel.includes("75%"));
});

test("participation rendering follows its own availability instead of wellbeing availability", async () => {
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const scope = { name: "Selected department", available: false, reason: "insufficient_responses", scores: null,
        participation: 86, participationAvailability: { available: true, reason: null }, weeks: [] };
    let html = renderOverview("hr", { source: "postgres", available: false, departments: [scope] }, "wellbeing", "0");
    assert(html.includes('class="report-participation">86%</strong>'));
    scope.available = true; scope.participationAvailability = { available: false, reason: "protected_constituent" };
    html = renderOverview("hr", { source: "postgres", available: false, departments: [scope] }, "wellbeing", "0");
    assert(!html.includes('class="report-participation">86%</strong>')); assert(html.includes("Participation unavailable"));
});

test("protected HR metrics explain privacy; global historical stress provenance never invents values", async () => {
    const db = fixture({ smallTeam: true });
    for (const row of db.cohorts) { row.stressCount = 0; row.stressSum = null; }
    const agent = await db.login("hr");
    let body = (await agent.get("/api/hr/overview").expect(200)).body;
    const { renderOverview } = await import("../public/js/reporting.mjs");
    for (const choice of ["1", "organization"]) {
        const html = renderOverview("hr", body, "stress", choice);
        const cards = html.match(/<div class="report-metrics">[^]*?<\/div>/)[0];
        assert.equal((cards.match(/Insights unavailable/g) ?? []).length, 4);
        assert.equal((cards.match(choice === "organization" ? /could reveal a protected department by subtraction\./g : /Not enough responses to protect employee privacy\./g) ?? []).length, 4);
        assert(cards.includes("Not yet available")); assert(cards.includes("Stress tracking was introduced after these historical check-ins."));
        assert(!cards.includes("0.0")); assert(html.includes("Not enough responses to calculate a privacy-safe participation rate."));
    }
    assert(body.departments[1].scores === null); assert(body.scores === null);
    assert.equal(body.departments[1].metricAvailability.stress, "not_measured_historically");
    // Once another authorized cohort has measured stress, do not reveal the
    // questionnaire version of a small protected group via a special flag.
    db.cohorts[0].stressCount = 5; db.cohorts[0].stressSum = 25;
    body = (await agent.get("/api/hr/overview").expect(200)).body;
    assert.equal(body.departments[1].metricAvailability.stress, "insufficient_responses");
    assertNoIndividualData(body);
});

test("Manager participation is explicitly labelled even when historical stress is unavailable", async () => {
    const db = fixture();
    for (const row of db.cohorts) { row.stressCount = 0; row.stressSum = null; }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("manager", body, "stress");
    assert(html.includes("Participation: 80%")); assert(html.includes("Stress tracking was introduced after these historical check-ins."));
    assert.equal(body.teams[0].participation, 80); assert.equal(body.teams[0].scores.stress, null);
});

test("the HR selector includes every model department, including unsafe departments and departments without teams", async () => {
    const db = fixture({ smallTeam: true });
    db.departments.push({ department_id: "4", name: "Research & Enablement" });
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.deepEqual(body.departments.map((d) => d.name), db.departments.map((d) => d.name));
    assert(db.calls.some((c) => c.sql.includes("reporting:departments") && c.sql.includes("FROM identity.departments")));
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body);
    const options = html.match(/<select id="report-scope"[^]*?<\/select>/)[0];
    assert.equal((options.match(/<option /g) ?? []).length, db.departments.length + 1);
    assert(options.includes("Engineering &middot; Department")); assert(options.includes("People &amp; Operations &middot; Department"));
    assert(options.includes("Research &amp; Enablement"));
    for (const department of body.departments.slice(1)) {
        assert.equal(department.available, false); assert.equal(department.participation, null);
        assert.equal(department.responseCount, null); assert.equal(department.scores, null);
    }
    const small = renderOverview("hr", body, "wellbeing", "1");
    assert(small.includes("Insights unavailable. Not enough responses to protect employee privacy."));
    assert(small.includes('class="report-participation is-unavailable">Participation unavailable</strong>'));
    assert(!small.includes('class="report-participation">0%'));
    assert.equal(body.available, false); assertNoIndividualData(body);
});

test("HR department selection is driven by catalogue names, not a hard-coded Engineering option", async () => {
    const db = fixture();
    db.departments[0].name = "Delivery";
    db.teams.forEach((t) => { t.department_name = "Delivery"; });
    db.cohorts.forEach((c) => { c.department_name = "Delivery"; });
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body, "wellbeing", "0");
    assert(html.includes('<option value="0" selected>Delivery &middot; Department</option>'));
    assert(html.includes("Participation in Delivery")); assert(!html.includes("Engineering"));
});

test("departments without teams remain represented when the organization has no reporting cohorts", async () => {
    const db = fixture(); db.teams.length = 0;
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.available, false); assert.equal(body.departments.length, 1);
    assert.equal(body.departments[0].name, db.departments[0].name);
    assert.equal(body.departments[0].participation, null); assert.deepEqual(body.departments[0].weeks, []);
    assertNoIndividualData(body);
});

test("historical stress has an explicit introduction explanation without inventing values or suppressing other measures", async () => {
    const db = fixture();
    for (const row of db.cohorts) { row.stressCount = 0; row.stressSum = null; }
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body, "stress", "0");
    assert(html.includes('class="is-unavailable">Not yet available</strong>'));
    assert(html.includes("Stress tracking was introduced after these historical check-ins."));
    assert(html.includes("Stress not yet available")); assert(!html.includes("<circle"));
    assert(html.includes("6.6<small>/ 10</small>"));
    assert(html.includes('class="report-participation">73%</strong>'));
    assert.equal(body.departments[0].scores.stress, null);
    for (const row of db.cohorts) { row.stressCount = row.responses; row.stressSum = 0; }
    const realZero = (await agent.get("/api/hr/overview").expect(200)).body;
    const zeroHtml = renderOverview("hr", realZero, "stress", "0");
    assert(zeroHtml.includes("0.0<small>/ 10</small>")); assert(zeroHtml.includes("<circle"));
    assert(!zeroHtml.includes("Stress tracking was introduced"));
});

test("recent themes render only released factors, preserving withheld/unasked reasons in the API", async () => {
    const db = fixture();
    for (const row of db.factors.filter((f) => ["deadlines", "difficulty_integrating", "organizational_changes"].includes(f.code))) {
        row.measured = 0; row.selected = 0;
    }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("manager", body);
    const tiles = [...html.matchAll(/<article class="report-theme [^]*?<\/article>/g)].map((match) => match[0]);
    assert.equal(tiles.length, 1); assert(tiles[0].includes("Workload"));
    assert(tiles[0].includes("50%")); assert(tiles[0].includes('value="50"'));
    const recent = body.teams[0].sharedThemes;
    assert.equal(recent.factors.filter((f) => f.reason === "not_measured_historically").length, 3);
    assert.equal(recent.factors.filter((f) => f.reason === "insufficient_responses").length, 4);
    assert(html.includes("What people have been experiencing recently"));
    assert(!html.includes("Not measured historically")); assert(!html.includes('data-theme-state="protected"'));
    assert(!html.includes("report-muted-bar"));
    assert(!tiles.join("").includes("Tools and processes")); assertNoIndividualData(body);
});

test("a suppressed department never renders challenge values supplied outside its released scope", async () => {
    const db = fixture({ smallTeam: true }), agent = await db.login("hr");
    const { body } = await agent.get("/api/hr/overview").expect(200);
    // The UI must keep the same fail-closed behavior even if stale challenge
    // values accidentally accompany an unavailable aggregate DTO.
    body.departments[1].challenges = [{ code: "workload", percentage: 50 }];
    body.departments[1].sharedThemes = { available: false, factors: [{ code: "workload", label: "Workload", percentage: 50, reason: null }] };
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body, "wellbeing", "1");
    const tiles = [...html.matchAll(/<article class="report-theme [^]*?<\/article>/g)].map((match) => match[0]);
    assert.equal(tiles.length, 0);
    const section = html.match(/<section class="card report-challenges">[^]*?<\/section>/)[0];
    assert(section.includes("No shared themes are available for this period yet."));
    assert(!section.includes("<progress")); assert(!/\d+%/.test(section));
});
test("recent themes use all eight finalized weeks and a response-weighted denominator, not the latest percentage or average of percentages", async () => {
    const db = fixture(), latest = db.cohorts.find((r) => r.team_id === "1" && r.week_start === "2026-11-02");
    latest.responses = 20; latest.eligible = 25;
    for (const key of dimensionKeys) { latest[`${key}Sum`] = latest[`${key}Sum`] / latest[`${key}Count`] * 20; latest[`${key}Count`] = 20; }
    for (const f of db.factors.filter((f) => f.team_id === "1" && f.week_start === latest.week_start)) {
        f.measured = 20; if (f.code === "workload") f.selected = 15;
    }
    // The SQL query already excludes these dates. Also verify that the period
    // builder only uses its authorized fixed calendar if an adapter returns extras.
    for (const date of ["2026-09-07", "2026-11-09"]) {
        db.cohorts.push({ ...latest, week_start: date });
        db.factors.push({ team_id: "1", week_start: date, code: "workload", label: "Workload", measured: 20, selected: 5 });
    }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const team = body.teams[0], recent = team.sharedThemes;
    assert.equal(team.challenges.find((f) => f.code === "workload").percentage, 75);
    assert.equal(recent.factors.find((f) => f.code === "workload").percentage, 55, "(7*6+15)/(7*12+20), rounded once");
    assert.equal(recent.startWeek, "2026-09-14"); assert.equal(recent.endWeek, "2026-11-02"); assert.equal(recent.endDate, "2026-11-08");
    const query = db.calls.find((call) => call.sql.includes("reporting:challenges"));
    assert(query.sql.includes("tw.finalized_at IS NOT NULL")); assert(query.sql.includes("- 56"));
    assert.deepEqual(query.args[0], ["1"]); assertNoIndividualData(body);
});

test("factors introduced in only some weeks exclude unasked responses from their period denominator", async () => {
    const db = fixture();
    for (const f of db.factors.filter((f) => f.code === "deadlines" && f.team_id === "1")) {
        const asked = f.week_start >= "2026-10-26";
        f.measured = asked ? 12 : 0; f.selected = !asked ? 0 : f.week_start === "2026-10-26" ? 5 : 6;
    }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const factor = body.teams[0].sharedThemes.factors.find((f) => f.code === "deadlines");
    assert.equal(factor.percentage, 46, "11 / 24 actually asked answers, not 11 / 96"); assert.equal(factor.reason, null);
    assert.equal(body.teams[0].challenges.find((f) => f.code === "deadlines").percentage, 50);
    assertNoIndividualData(body);
});

test("mixed-version periods protect the asked subset and never count unasked answers as non-selections", async () => {
    const db = fixture();
    const subset = db.factors.filter((f) => f.code === "deadlines" && f.team_id === "1");
    for (const f of subset) { f.measured = 10; f.selected = 5; }
    const agent = await db.login("manager");
    let team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
    assert.equal(team.sharedThemes.factors.find((f) => f.code === "deadlines").percentage, 50, "5/10, not 5/12");
    for (const f of subset) { f.measured = 6; f.selected = 5; }
    team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
    assert.equal(team.sharedThemes.factors.find((f) => f.code === "deadlines").percentage, null,
        "One repeatedly nonselecting person stays protected; unasked answers cannot count as complements");
});

test("recent themes distinguish never asked, newly measured but insufficient, and safely measured factors", async () => {
    const db = fixture();
    for (const f of db.factors.filter((f) => ["deadlines", "difficulty_integrating"].includes(f.code))) { f.measured = 0; f.selected = 0; }
    const few = db.factors.find((f) => f.team_id === "1" && f.code === "difficulty_integrating" && f.week_start === "2026-11-02");
    few.measured = 4; few.selected = 2;
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const recent = body.teams[0].sharedThemes;
    assert.equal(recent.factors.find((f) => f.code === "deadlines").reason, "not_measured_historically");
    assert.equal(recent.factors.find((f) => f.code === "difficulty_integrating").reason, "insufficient_responses");
    assert.equal(recent.factors.find((f) => f.code === "workload").percentage, 50); assertNoIndividualData(body);
});

test("a protected weekly factor becomes public when its period aggregate passes both privacy thresholds", async () => {
    const db = fixture(), agent = await db.login("manager");
    const first = db.factors.find((f) => f.team_id === "1" && f.code === "workload" && f.week_start === "2026-09-14");
    for (const selected of [0, 4, 8, 12]) {
        first.selected = selected;
        const team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
        assert.equal(team.sharedThemes.factors.find((f) => f.code === "workload").percentage, Math.round((42 + selected) / 96 * 100),
            "One rare weekly cell must not veto a safe eight-week release");
    }
    for (const row of db.cohorts.filter((r) => r.team_id === "1")) row.responses = 6;
    for (const f of db.factors.filter((f) => f.team_id === "1")) { f.measured = 6; f.selected = 3; }
    db.periodPeople["1/1/workload"] = { selecting_participants: 6, nonselecting_participants: 6 };
    let team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
    assert(team.challenges.every((f) => f.percentage === null), "Weekly releases remain protected");
    assert.equal(team.sharedThemes.factors.find((f) => f.code === "workload").percentage, 50, "24/48 responses and six people on both sides across the period");
    for (const row of db.cohorts.filter((r) => r.team_id === "1")) row.responses = 2;
    for (const f of db.factors.filter((f) => f.team_id === "1")) { f.measured = 2; f.selected = 1; }
    db.periodPeople = {};
    team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
    assert.equal(team.sharedThemes.available, false); assert(team.sharedThemes.factors.every((f) => f.percentage === null),
        "Sixteen repeated submissions from two people do not create a safe group");
});

test("missing factor provenance and missing/unfinalized weeks fail closed without treating them as unasked or omitting them", async () => {
    const db = fixture(), agent = await db.login("manager");
    db.factors.splice(db.factors.findIndex((f) => f.team_id === "1" && f.code === "workload" && f.week_start === "2026-09-14"), 1);
    let team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
    assert.equal(team.sharedThemes.factors.find((f) => f.code === "workload").reason, "insufficient_responses");
    db.cohorts.splice(db.cohorts.findIndex((r) => r.team_id === "1" && r.week_start === "2026-09-14"), 1);
    team = (await agent.get("/api/manager/overview").expect(200)).body.teams[0];
    assert.equal(team.available, true, "Latest weekly metrics remain unchanged");
    assert.equal(team.sharedThemes.available, false); assert(team.sharedThemes.factors.every((f) => f.percentage === null));
});

test("period themes stay independent of a small latest week while other weekly reporting remains suppressed", async () => {
    const db = fixture(), latest = db.cohorts.find((r) => r.team_id === "1" && r.week_start === "2026-11-02");
    latest.responses = 2;
    for (const f of db.factors.filter((f) => f.team_id === "1" && f.week_start === latest.week_start)) { f.measured = 2; f.selected = 1; }
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const team = body.teams[0]; assert.equal(team.available, false); assert.equal(team.scores, null);
    assert.equal(team.sharedThemes.available, true); assert.equal(team.sharedThemes.factors.find((f) => f.code === "workload").percentage, 50);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const section = renderOverview("manager", body).match(/<section class="card report-challenges">[^]*?<\/section>/)[0];
    assert(section.includes("50%")); assert(section.includes("Workload")); assertNoIndividualData(body);
});

test("period selection/complement thresholds protect rare contributors and parent/sibling subtraction", async () => {
    const db = fixture({ smallTeam: true }), hr = await db.login("hr"), manager = await db.login("manager");
    for (const counts of [{ weeklySelected: 1, selecting_participants: 4 }, { weeklySelected: 9, nonselecting_participants: 4 }]) {
        const { weeklySelected, ...people } = counts;
        for (const f of db.factors.filter((f) => f.team_id === "2" && f.code === "workload")) f.selected = weeklySelected;
        db.periodPeople["2/1/workload"] = people;
        const result = (await hr.get("/api/hr/overview").expect(200)).body;
        assert.equal(result.departments[0].sharedThemes.factors.find((f) => f.code === "workload").percentage, null);
        const organizationFactor = result.sharedThemes.factors.find((f) => f.code === "workload");
        assert.equal(organizationFactor.reason, null, "Neither department publishes this factor: the hidden residual is the whole safe organization");
        assert.equal(organizationFactor.percentage, Math.round((6 + weeklySelected + 1) / 24 * 100));
        assert.equal(result.departments[1].sharedThemes.available, false, "The small department remains protected");
        const team = (await manager.get("/api/manager/overview").expect(200)).body.teams[0];
        assert.equal(team.sharedThemes.factors.find((f) => f.code === "workload").percentage, 50);
    }
    for (const f of db.factors.filter((f) => f.team_id === "2" && f.code === "workload")) f.selected = 5;
    db.periodPeople["2/1/workload"] = { selecting_participants: 5, nonselecting_participants: 5 };
    const result = (await hr.get("/api/hr/overview").expect(200)).body;
    assert.equal(result.departments[0].sharedThemes.factors.find((f) => f.code === "workload").percentage, 50);
    assertNoIndividualData(result);
});

test("recent themes respect Manager team scope and HR historical department membership without using suppressed organization totals", async () => {
    const db = fixture({ smallTeam: true });
    // Product moves from its historical department into Engineering in October.
    db.departments.push({ department_id: "3", name: "Customer Experience" });
    for (const row of db.cohorts.filter((r) => r.team_id === "2" && r.week_start.startsWith("2026-09"))) {
        row.department_id = "3"; row.department_name = "Customer Experience";
    }
    for (const f of db.factors.filter((f) => f.code === "workload" && f.team_id === "1")) f.selected = 7;
    const manager = await db.login("manager"), hr = await db.login("hr");
    const team = (await manager.get("/api/manager/overview").expect(200)).body.teams[0];
    assert.equal(team.sharedThemes.factors.find((f) => f.code === "workload").percentage, 58);
    const { body } = await hr.get("/api/hr/overview").expect(200);
    assert.equal(body.sharedThemes.factors.find((f) => f.code === "workload").percentage, null,
        "Published Engineering and Customer Experience theme results must not isolate Operations");
    const engineering = body.departments.find((d) => d.name === "Engineering");
    assert.equal(engineering.sharedThemes.factors.find((f) => f.code === "workload").percentage, 55,
        "(8*7 + 5*5)/(8*12 + 5*10), excluding Product's September answers in the other department");
    const small = body.departments.find((d) => d.name === "People and Operations");
    assert.equal(small.sharedThemes.available, false); assert(small.sharedThemes.factors.every((f) => f.percentage === null));
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const section = (html) => html.match(/<section class="card report-challenges">[^]*?<\/section>/)[0];
    assert(section(renderOverview("hr", body, "wellbeing", "0")).includes("55%"));
    assert(!section(renderOverview("hr", body, "wellbeing", "organization")).includes('<h3>Workload</h3>'));
    assert(!section(renderOverview("hr", body, "wellbeing", "1")).includes("<progress"));
    assertNoIndividualData(body);
});

test("recent themes list sorts real released percentages and emits exactly one empty message when none are released", async () => {
    const db = fixture();
    for (const f of db.factors.filter((f) => f.code === "communication" && f.team_id === "1")) f.selected = 7;
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const section = (html) => html.match(/<section class="card report-challenges">[^]*?<\/section>/)[0];
    let html = section(renderOverview("manager", body));
    assert(html.indexOf("Team communication") < html.indexOf("Workload"));
    assert.equal((html.match(/<progress/g) ?? []).length, 2); assert(!html.includes("Insights unavailable"));
    body.teams[0].sharedThemes.factors.forEach((f) => { f.percentage = null; f.reason = "insufficient_responses"; });
    html = section(renderOverview("manager", body));
    assert.equal((html.match(/No shared themes are available for this period yet\./g) ?? []).length, 1);
    assert(!html.includes("<progress")); assert(!html.includes("<article")); assert(!/\d+%/.test(html));
});

test("empty data and database failures return honest empty/safe responses", async () => {
    const db = fixture(); db.cohorts.length = 0; db.factors.length = 0;
    const agent = await db.login("manager"), { body } = await agent.get("/api/manager/overview").expect(200);
    assert.equal(body.available, false); assert(body.teams.every((team) => team.scores === null));
    db.failure = true; const failure = await agent.get("/api/manager/overview").expect(503);
    assert(!JSON.stringify(failure.body).includes("password")); assert(!JSON.stringify(failure.body).includes("response_id"));
});
test("reporting client never fetches Employee responses or manufactures demo metrics", async () => {
    const { createReportingApi, renderOverview, emptyOverview } = await import("../public/js/reporting.mjs");
    const previous = globalThis.fetch, urls = [];
    globalThis.fetch = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => emptyOverview() }; };
    try {
        const demo = createReportingApi("demo"); const result = await demo.getOverview("manager");
        assert.equal(result.source, "demo"); assert.equal(result.available, false); assert.equal(urls.length, 0);
        const http = createReportingApi("postgres"); await http.startSession("manager"); await http.getOverview("manager");
        await http.startSession("hr"); await http.getOverview("hr");
        assert.deepEqual(urls, ["/api/prototype/manager-session", "/api/manager/overview", "/api/prototype/hr-session", "/api/hr/overview"]);
        const html = renderOverview("hr", result);
        assert(html.includes("Organization wellbeing")); assert(html.includes("No organization metrics are simulated"));
        assert(!html.includes("NaN")); assert(!html.includes("undefined")); assert(!html.includes("0%"));
        globalThis.fetch = async () => { throw new Error("database offline"); };
        await assert.rejects(http.getOverview("hr"));
    } finally { globalThis.fetch = previous; }
});

test("organization themes can be safe independently of protected scores, participation and latest-week availability", async () => {
    const db = fixture({ smallTeam: true });
    for (const row of db.cohorts) { row.stressCount = 0; row.stressSum = null; }
    for (const f of db.factors.filter((f) => f.team_id === "2" && f.code === "workload")) f.selected = 2;
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.available, false); assert.equal(body.participation, null); assert.equal(body.scores, null);
    assert.equal(body.metricAvailability.wellbeing, "protected_constituent");
    assert.equal(body.metricAvailability.stress, "not_measured_historically");
    assert.equal(body.sharedThemes.available, true);
    const workload = body.sharedThemes.factors.find((f) => f.code === "workload");
    assert.equal(workload.percentage, 38, "72/192 eligible responses, including Operations; not a mean of department percentages");
    assert.equal(workload.reason, null);
    for (const d of body.departments) assert.equal(d.sharedThemes.factors.find((f) => f.code === "workload").percentage, null);
    const query = db.calls.find((call) => call.sql.includes("reporting:organization-themes"));
    assert.deepEqual(JSON.parse(query.args[4]).find((q) => q.code === "workload").hidden_departments, ["1", "2"]);
    assert(query.sql.includes("COUNT(DISTINCT c.user_id)")); assert(query.sql.includes("tw.finalized_at IS NOT NULL"));
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const html = renderOverview("hr", body, "wellbeing", "organization");
    assert(html.includes("38% of responses selected this as a challenge."));
    assert(!html.includes("No shared themes are available for this period yet."));
    assert(html.includes("Wellbeing insights protected"));
    assert(html.includes("Monthly changes are protected"));
    assert(html.includes("Each metric and theme is checked separately"));
    assertNoIndividualData(body);
});

test("organization theme minima protect distinct selectors and nonselectors, including the hidden residual", async () => {
    const db = fixture({ smallTeam: true });
    for (const f of db.factors.filter((f) => f.team_id === "2" && f.code === "workload")) f.selected = 2;
    const agent = await db.login("hr");
    for (const key of ["participants", "selecting_participants", "nonselecting_participants", "residual_participants", "residual_selecting_participants", "residual_nonselecting_participants"]) {
        db.organizationPeople.workload = { [key]: 4 };
        const { body } = await agent.get("/api/hr/overview").expect(200);
        assert.equal(body.sharedThemes.factors.find((f) => f.code === "workload").percentage, null, key);
        assertNoIndividualData(body);
    }
});

test("organization theme subtraction checks the released factor, not the department's overall availability", async () => {
    const db = fixture({ smallTeam: true }), agent = await db.login("hr");
    let body = (await agent.get("/api/hr/overview").expect(200)).body;
    assert.equal(body.departments[0].sharedThemes.factors.find((f) => f.code === "workload").percentage, 50);
    assert.equal(body.sharedThemes.factors.find((f) => f.code === "workload").reason, "protected_constituent");
    // Workload becomes protected in Engineering while another theme remains
    // public there. The organization residual for workload is now two groups.
    for (const f of db.factors.filter((f) => f.team_id === "2" && f.code === "workload")) f.selected = 2;
    body = (await agent.get("/api/hr/overview").expect(200)).body;
    assert.equal(body.departments[0].available, true);
    assert.equal(body.sharedThemes.factors.find((f) => f.code === "workload").percentage, 38);
    assert.equal(body.departments[1].sharedThemes.available, false);
    assertNoIndividualData(body);
});

test("organization weekly scores are metric-specific and safe weeks alone enter trends and monthly changes", async () => {
    const db = fixture({ smallTeam: true });
    db.departments.push({ department_id: "3", name: "Customer Experience" });
    db.teams.find((t) => t.team_id === "2").department_id = "3";
    for (const row of db.cohorts.filter((r) => r.team_id === "2")) {
        row.department_id = "3"; row.department_name = "Customer Experience";
        row.stressCount = 4; row.stressSum = 20;
    }
    const latest = db.cohorts.find((r) => r.team_id === "2" && r.week_start === "2026-11-02");
    latest.wellbeingCount = 4; latest.wellbeingSum = 20;
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.available, true); assert.equal(body.responseCount, null); assert.equal(body.participation, null);
    assert.equal(body.scores.stress, 5, "The two hidden stress subsets form a residual of six people");
    assert.equal(body.scores.wellbeing, 7, "(12*8 + 4*5 + 2*5)/18, weighted from answers");
    assert.equal(body.scores.teamIntegration, null); assert.equal(body.metricAvailability.teamIntegration, "protected_constituent");
    assert.equal(body.weeks.filter((w) => Number.isFinite(w.scores?.wellbeing)).length, 1);
    assert.equal(body.weeks.filter((w) => Number.isFinite(w.scores?.stress)).length, 8);
    assert.equal(body.monthlyChange.wellbeing, null); assert.equal(body.monthlyChange.stress, 0);
    assert(body.departments.filter((d) => d.departmentId !== "1").every((d) => !Number.isFinite(d.scores?.stress)));
    const { renderOverview } = await import("../public/js/reporting.mjs");
    assert(renderOverview("hr", body, "stress", "organization").includes("<polyline"));
    assertNoIndividualData(body);
    for (const row of db.cohorts.filter((r) => r.week_start === "2026-11-02")) row.stressSum += row.stressCount;
    const changed = (await agent.get("/api/hr/overview").expect(200)).body;
    assert.equal(changed.scores.stress, 6); assert.equal(changed.monthlyChange.stress, 1);
    const focus = renderOverview("hr", changed, "stress", "organization");
    assert(focus.includes("<h3>Stress</h3><p>Increased"), "A real released adverse organization change appears normally");
    for (const extreme of [0, 10]) {
        for (const row of db.cohorts.filter((r) => r.team_id !== "1")) row.stressSum = extreme * row.stressCount;
        const protectedMean = (await agent.get("/api/hr/overview").expect(200)).body;
        assert.equal(protectedMean.scores.stress, null, "An extreme residual mean would reveal every hidden contributor's score");
        assert.equal(protectedMean.metricAvailability.stress, "protected_constituent");
        assert.equal(protectedMean.monthlyChange.stress, null);
    }
});

test("a safe organization theme still withholds an unsafe residual after subtracting a visible department", async () => {
    const db = fixture({ smallTeam: true });
    db.departments.push({ department_id: "3", name: "Customer Experience" });
    db.teams.find((t) => t.team_id === "2").department_id = "3";
    for (const row of db.cohorts.filter((r) => r.team_id === "2")) row.department_id = "3";
    for (const f of db.factors.filter((f) => f.team_id === "2" && f.code === "workload")) f.selected = 2;
    const agent = await db.login("hr");
    let body = (await agent.get("/api/hr/overview").expect(200)).body;
    assert.equal(body.departments[0].sharedThemes.factors.find((f) => f.code === "workload").percentage, 50);
    assert.equal(body.sharedThemes.factors.find((f) => f.code === "workload").reason, "protected_constituent",
        "Nine selectors overall are insufficient when the hidden residual has only three distinct selectors");
    db.periodPeople["2/3/workload"] = { selecting_participants: 3 };
    db.periodPeople["3/2/workload"] = { selecting_participants: 2, nonselecting_participants: 2 };
    body = (await agent.get("/api/hr/overview").expect(200)).body;
    assert.equal(body.sharedThemes.factors.find((f) => f.code === "workload").percentage, 38,
        "The residual now has five distinct selectors and enough nonselectors, without releasing either hidden department");
    assert(body.departments.filter((d) => d.departmentId !== "1").every((d) =>
        d.sharedThemes.factors.find((f) => f.code === "workload").percentage === null));
    assertNoIndividualData(body);
});

test("organization participation uses all counts when multiple protected departments form a safe residual", async () => {
    const db = fixture({ smallTeam: true });
    db.departments.push({ department_id: "3", name: "Customer Experience" });
    db.teams.find((t) => t.team_id === "2").department_id = "3";
    for (const row of db.cohorts.filter((r) => r.team_id === "2")) {
        row.department_id = "3"; row.responses = 3;
        for (const key of dimensionKeys) { row[`${key}Count`] = 3; row[`${key}Sum`] = 15; }
    }
    const agent = await db.login("hr"), { body } = await agent.get("/api/hr/overview").expect(200);
    assert.equal(body.responseCount, 17); assert.equal(body.participation, 53, "17/(15+15+2), including both protected departments");
    assert.deepEqual(body.participationAvailability, { available: true, reason: null });
    assert(body.departments.filter((d) => d.departmentId !== "1").every((d) => d.participation === null));
    assertNoIndividualData(body);
    for (const row of db.cohorts.filter((r) => r.team_id === "2")) row.responses = 4;
    const constrained = (await agent.get("/api/hr/overview").expect(200)).body;
    assert.equal(constrained.participation, null, "Residual 6, with protected maxima 4+2, uniquely determines both counts");
    assert.equal(constrained.responseCount, null);
    assert.equal(constrained.participationAvailability.reason, "protected_constituent");
});

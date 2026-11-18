const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");
const M = "00000000-0000-4000-8000-000000000101";
const raw = (overrides = {}) => ({ teamId: "1", title: "Review team workload allocation", area: "workloadBalance",
    description: "Agree shared priorities and capacity for the next delivery cycle.", owner: "team_manager", targetDate: "2026-12-04", ...overrides });
function noPrivateData(value) {
    for (const [key, child] of Object.entries(value ?? {})) {
        assert(!["user_id", "userId", "employeeId", "owner_user_id", "created_by_user_id", "response_id", "responseId", "comment", "comments", "history", "responses"].includes(key));
        if (child && typeof child === "object") noPrivateData(child);
    }
    assert(!JSON.stringify(value).includes("00000000-0000"));
}
function fixture() {
    const users = [{ user_id: M, sso_subject: "manager-platform", display_name: "Manager", role: "manager", is_active: true },
        { user_id: "00000000-0000-4000-8000-000000000001", sso_subject: "employee-05", display_name: "Employee", role: "employee", is_active: true },
        { user_id: "00000000-0000-4000-8000-000000000201", sso_subject: "hr-marta", display_name: "HR", role: "hr", is_active: true }];
    const teams = [{ team_id: "1", name: "Platform", department_id: "1", department_name: "Engineering", manager: M },
        { team_id: "2", name: "Product", department_id: "1", department_name: "Engineering", manager: "other-manager" }];
    const action = (id, teamId) => ({ team_action_id: id, team_id: teamId, team_name: teams.find((t) => t.team_id === teamId).name,
        title: "Existing team plan", description: null, insight_topic: "workload", owner_role: "manager", target_date: "2026-12-01", status: "planned" });
    const db = { users, teams, actions: [action("1", "1"), action("2", "2")], calls: [], released: true, improving: false, fail: false };
    let snapshot;
    const result = (rows) => ({ rows: structuredClone(rows) });
    const query = async (sql, args = []) => {
        db.calls.push({ sql, args });
        const scoped = (a, manager) => teams.some((t) => t.team_id === a.team_id && t.manager === manager);
        if (sql === "BEGIN") { snapshot = structuredClone(db.actions); return result([]); }
        if (sql === "COMMIT") return result([]);
        if (sql === "ROLLBACK") { db.actions = snapshot; return result([]); }
        if (sql.includes("SELECT user_id FROM identity.users")) return result(users.filter((u) => u.sso_subject === args[1] && u.role === (args[2] ?? "employee") && u.is_active));
        if (sql.includes("SELECT user_id, display_name")) return result(users.filter((u) => u.user_id === args[0]));
        if (sql.includes("actions:teams") || sql.includes("reporting:teams")) return result(teams.filter((t) => t.manager === args[0]));
        if (sql.includes("actions:rows")) return result(db.actions.filter((a) => scoped(a, args[0]) && (!args[1] || a.team_action_id === String(args[1]))));
        if (sql.includes("actions:authorize")) return result(teams.filter((t) => t.manager === args[0] && t.team_id === args[1]));
        if (sql.includes("actions:create")) {
            if (db.fail) throw new Error("private SQL diagnostic");
            const id = String(Math.max(...db.actions.map((a) => Number(a.team_action_id))) + 1);
            db.actions.push({ ...action(id, args[1]), insight_week_start: args[2], insight_topic: args[3], title: args[4], description: args[5], target_date: args[6], status: args[7] });
            return result([{ team_action_id: id }]);
        }
        if (sql.includes("actions:lock")) return result(db.actions.filter((a) => a.team_action_id === args[1] && scoped(a, args[0])));
        if (sql.includes("actions:status")) { db.actions.find((a) => a.team_action_id === args[0]).status = args[1]; return result([]); }
        if (sql.includes("reporting:calendar")) return result([{ week_start: "2026-10-26" }, { week_start: "2026-11-02" }]);
        if (sql.includes("reporting:challenges")) return result([]);
        if (sql.includes("reporting:theme-period")) return result([]);
        if (sql.includes("reporting:cohorts")) return result(["2026-10-26", "2026-11-02"].map((date, i) => {
            const n = db.released ? 6 : 2;
            const means = { wellbeing: i ? (db.improving ? 8 : 5.4) : 6.5, workload: i ? 7.6 : 6.4, stress: null, teamIntegration: 7, psychologicalSafety: 7 };
            return { team_id: "1", department_id: "1", department_name: "Engineering", week_start: date, eligible: 7, responses: n,
                ...Object.fromEntries(Object.entries(means).flatMap(([key, mean]) => [[`${key}Sum`, mean === null ? null : mean * n], [`${key}Count`, mean === null ? 0 : n]])) };
        }));
        throw new Error("Unexpected action fixture query");
    };
    const pool = { query, async connect() { return { query, release() {} }; } };
    db.app = createApp({ getPool: () => pool, minimumResponses: 5, prototypeAccess: true, sessionSecret: "action-tests" });
    db.login = async (role = "manager") => { const agent = request.agent(db.app); await agent.post(`/api/prototype/${role}-session`).send({}).expect(204); return agent; };
    return db;
}

test("Manager lists only assigned team plans with no employee identifiers or private wellbeing data", async () => {
    const db = fixture(), agent = await db.login();
    const { body, headers } = await agent.get("/api/manager/actions").expect(200);
    assert.equal(headers["cache-control"], "no-store"); assert.equal(body.actions.length, 1);
    assert.equal(body.teams[0].name, "Platform"); assert.equal(body.actions[0].owner, "Team Manager"); noPrivateData(body);
    await agent.get("/api/manager/actions?teamId=2").expect(400);
});
test("Manager creates a general action and persists Planned -> In progress -> Completed", async () => {
    const db = fixture(), agent = await db.login();
    const { body } = await agent.post("/api/manager/actions").send(raw()).expect(201);
    assert.equal(body.status, "planned"); assert.equal(body.description, raw().description); assert.equal(body.area, "workloadBalance");
    assert.equal(db.actions.at(-1).insight_week_start, null); noPrivateData(body);
    for (const status of ["in_progress", "completed"]) {
        await agent.patch(`/api/manager/actions/${body.id}/status`).send({ status }).expect(200);
        const reloaded = (await agent.get("/api/manager/actions").expect(200)).body.actions.find((a) => a.id === body.id);
        assert.equal(reloaded.status, status);
    }
    assert(!db.calls.some((c) => /(?:INSERT INTO|UPDATE|DELETE FROM) (?:wellbeing|private)\./i.test(c.sql)));
});
test("safe adverse aggregate insights can seed actions, while unavailable, stale or non-adverse insights cannot", async () => {
    const db = fixture(), agent = await db.login();
    await agent.post("/api/manager/actions").send(raw({ sourceWeek: "2026-11-02" })).expect(201);
    assert.equal(db.actions.at(-1).insight_week_start, "2026-11-02");
    await agent.post("/api/manager/actions").send(raw({ sourceWeek: "2026-10-26" })).expect(409);
    db.released = false;
    await agent.post("/api/manager/actions").send(raw({ sourceWeek: "2026-11-02" })).expect(409);
    await agent.post("/api/manager/actions").send(raw()).expect(201);
    assert.equal(db.actions.at(-1).insight_week_start, null, "A small cohort can still have a general team action");
    db.released = true; db.improving = true;
    await agent.post("/api/manager/actions").send(raw({ area: "wellbeing", sourceWeek: "2026-11-02" })).expect(409);
});
test("Manager cannot create or modify another team's plans", async () => {
    const db = fixture(), agent = await db.login();
    await agent.post("/api/manager/actions").send(raw({ teamId: "2" })).expect(403);
    await agent.patch("/api/manager/actions/2/status").send({ status: "completed" }).expect(404);
    assert.equal(db.actions[1].status, "planned"); assert.equal(db.actions.length, 2);
});
for (const role of [null, "employee", "hr"]) test(`${role ?? "Unauthenticated"} action-plan access is denied at every endpoint`, async () => {
    const db = fixture(), agent = role ? await db.login(role) : request.agent(db.app), status = role ? 403 : 401;
    await agent.get("/api/manager/actions").expect(status);
    await agent.post("/api/manager/actions").send(raw()).expect(status);
    await agent.patch("/api/manager/actions/1/status").send({ status: "completed" }).expect(status);
});
test("required action fields, supported areas, dates, owner and status are validated before writes", async () => {
    const db = fixture(), agent = await db.login();
    for (const field of ["teamId", "title", "description", "area", "owner", "targetDate"]) {
        const input = raw(); delete input[field]; await agent.post("/api/manager/actions").send(input).expect(400);
    }
    for (const change of [{ title: " " }, { description: " " }, { area: "stress" }, { targetDate: "2026-02-30" },
        { status: "closed" }, { owner: "employee" }, { owner_user_id: M }, { comment: "private" }, { sourceWeek: "2026-11-03" },
        { title: "x".repeat(181) }, { description: "x".repeat(2001) }, { teamId: "1 OR true" }])
        await agent.post("/api/manager/actions").send(raw(change)).expect(400);
    for (const input of [{ status: "invalid" }, {}, { status: "completed", title: "tamper" }])
        await agent.patch("/api/manager/actions/1/status").send(input).expect(400);
    assert(!db.calls.some((c) => c.sql.includes("actions:create") || c.sql.includes("actions:status")));
});
test("failed writes roll back and do not expose driver diagnostics", async () => {
    const db = fixture(), agent = await db.login(); db.fail = true;
    const { body } = await agent.post("/api/manager/actions").send(raw()).expect(503);
    assert(!JSON.stringify(body).includes("private SQL")); assert(db.calls.some((c) => c.sql === "ROLLBACK"));
    assert.equal(db.actions.length, 2);
});
test("Action Plans UI escapes text, limits creation areas and offers no fake persistence", async () => {
    const { renderActionPlans, renderActionForm, createActionsApi, ACTION_AREAS } = await import("../public/js/actions.mjs");
    const db = fixture(), agent = await db.login(), data = (await agent.get("/api/manager/actions")).body;
    data.actions[0].title = '<script>alert("x")</script>';
    const html = renderActionPlans(data); assert(!html.includes("<script>")); assert(html.includes("&lt;script&gt;"));
    const form = renderActionForm(data, { teamId: "1", area: "workloadBalance", sourceWeek: "2026-11-02" });
    assert(form.includes('value="workloadBalance" selected')); assert(form.includes('name="sourceWeek"'));
    assert.equal(ACTION_AREAS.length, 4); assert(!form.includes('value="stress"'));
    await assert.rejects(createActionsApi("demo").list(), /PostgreSQL/);
});
test("Overview links only available adverse supported areas, and never adds Manager links to HR", async () => {
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const team = { name: "Platform", teamId: "1", available: true, weekStart: "2026-11-02", responseCount: 6,
        scores: { workloadBalance: 2.4, stress: 7 }, monthlyChange: { workloadBalance: -1.2, stress: 1 }, weeks: [] };
    const manager = renderOverview("manager", { source: "postgres", available: true, teams: [team] });
    assert(manager.includes('data-action-insight="workloadBalance"')); assert(!manager.includes('data-action-insight="stress"'));
    assert(!renderOverview("hr", { source: "postgres", ...team, departments: [] }).includes("data-action-insight"));
    assert(!renderOverview("manager", { teams: [{ ...team, available: false }] }).includes("data-action-insight"));
});

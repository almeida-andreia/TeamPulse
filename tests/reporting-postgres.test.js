const { isolatedDatabase } = require("./helpers/postgres-fixture.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");
const { createReporting } = require("../server/reporting");

// SELECT-only verification after provisioning a disposable fixed-clock demo.
test("PostgreSQL: approved reporting privacy, legacy questionnaire and real role boundaries (SELECT only)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1 with the local demo database." : false }, async () => {
        const pool = await isolatedDatabase();
        const readOnly = { query(sql, args) {
            assert.match(sql, /^\s*(?:\/\*[^]*?\*\/\s*)?SELECT\b/i, "Reporting verification must remain read-only");
            return pool.query(sql, args);
        } };
        const fingerprint = async () => (await readOnly.query(`SELECT count(*) AS responses,
            count(*) FILTER (WHERE stress_score IS NULL) AS legacy,
            md5(string_agg(to_jsonb(r)::text, '|' ORDER BY response_id)) AS fingerprint
            FROM wellbeing.wellbeing_responses r`)).rows[0];
        const noIndividualData = (data) => {
            for (const [key, value] of Object.entries(data ?? {})) {
                assert(!["user_id", "userId", "employeeId", "response_id", "responseId", "comment", "comments",
                    "display_name", "team_id", "department_id", "selected", "measured", "eligible", "responses",
                    "participants", "selecting_participants", "nonselecting_participants"].includes(key));
                assert(!key.endsWith("Sum") && !key.endsWith("Count") || key === "responseCount");
                if (value && typeof value === "object") noIndividualData(value);
            }
        };
        try {
            const before = await fingerprint();
            const stressColumn = (await readOnly.query(`SELECT is_nullable FROM information_schema.columns
                WHERE table_schema='wellbeing' AND table_name='wellbeing_responses' AND column_name='stress_score'`)).rows[0];
            // The existing migrated demo retains unasked historical stress.
            // A fresh schema instead requires five independently seeded scores.
            if (stressColumn.is_nullable === "YES") assert(Number(before.legacy) > 0);
            else assert.equal(Number(before.legacy), 0);
            assert.equal(process.env.MIN_RESPONSES, "5", "Use the explicitly approved deployment threshold");
            const app = createApp({ getPool: () => readOnly, prototypeAccess: true, sessionSecret: "readonly-reporting-verification" });
            const login = async (role) => {
                const agent = request.agent(app);
                await agent.post(`/api/prototype/${role}-session`).send({}).expect(204);
                return agent;
            };
            const manager = await login("manager"), hr = await login("hr"), employee = await login("employee");
            const expansion = require("../db/expand-demo.cjs");
            const expanded = (await readOnly.query("SELECT count(*)::int AS people FROM identity.users WHERE sso_issuer=$1", [expansion.ISSUER])).rows[0].people;
            if (expanded) {
                assert.equal(expanded, 28);
                const snapshot = await expansion.captureSnapshot(readOnly);
                if (process.env.TEAMPULSE_DEMO_BASELINE) expansion.verifyPreserved(
                    JSON.parse(require("node:fs").readFileSync(process.env.TEAMPULSE_DEMO_BASELINE, "utf8")), snapshot);
                const generated = (await readOnly.query(`SELECT count(r.response_id)::int AS responses,count(r.stress_score)::int AS stress,
                    count(DISTINCT r.week_start)::int AS weeks FROM wellbeing.wellbeing_responses r
                    JOIN private.employee_weekly_checkins c USING(response_id) JOIN identity.users u USING(user_id) WHERE u.sso_issuer=$1`, [expansion.ISSUER])).rows[0];
                assert.deepEqual(generated, { responses: 192, stress: 192, weeks: 8 });
                const actual = await expansion.demoReport(readOnly);
                const managerResult = (await manager.get("/api/manager/overview").expect(200)).body;
                const organization = (await hr.get("/api/hr/overview").expect(200)).body;
                assert(organization.available); assert(managerResult.available); noIndividualData(organization); noIndividualData(managerResult);
                // JSON serialization represents -0 as 0; compare the HTTP DTO.
                assert.deepEqual(organization, JSON.parse(JSON.stringify(actual.organization)));
                const { renderOverview } = await import("../public/js/reporting.mjs");
                for (const [index, scope] of [["organization", organization], ...organization.departments.map((d, i) => [String(i), d])]) {
                    const sql = (await readOnly.query(`SELECT count(c.user_id)::int AS eligible,count(r.response_id)::int AS completed,
                        round(avg(r.wellbeing_score),1)::float AS wellbeing,round(avg(r.workload_score),1)::float AS workload,
                        round(10-avg(r.workload_score),1)::float AS balance,round(avg(r.stress_score),1)::float AS stress,
                        round(avg(r.team_integration_score),1)::float AS connection,round(avg(r.psychological_safety_score),1)::float AS safety
                        FROM wellbeing.team_weeks tw LEFT JOIN private.employee_weekly_checkins c USING(team_id,week_start)
                        LEFT JOIN wellbeing.wellbeing_responses r ON r.response_id=c.response_id AND r.team_id=tw.team_id AND r.week_start=tw.week_start
                        WHERE tw.finalized_at IS NOT NULL AND tw.week_start=$1::date AND ($2::bigint IS NULL OR tw.department_id=$2)`,
                    [scope.weekStart, scope.departmentId ?? null])).rows[0];
                    assert.equal(scope.participation, Math.round(sql.completed/sql.eligible*100));
                    assert.deepEqual(scope.scores, { wellbeing: sql.wellbeing, workload: sql.workload, workloadBalance: sql.balance,
                        stress: sql.stress, teamIntegration: sql.connection, psychologicalSafety: sql.safety });
                    assert.equal(scope.weeks.length, 8); assert(new Set(scope.weeks.map((w) => w.scores.stress)).size > 1);
                    assert(scope.sharedThemes.factors.filter((f) => f.reason === null).length >= 2);
                    const html = renderOverview("hr", organization, "stress", index);
                    assert(html.includes("<polyline")); assert(html.includes(`${scope.participation}%</strong>`));
                    assert(!html.includes("Stress tracking was introduced after"));
                    assert(html.includes("of responses selected this as a challenge."));
                }
                assert.equal(organization.departments.find((d) => d.name === "People and Operations").participation, 90);
                for (const team of managerResult.teams) {
                    assert(Number.isFinite(team.scores.stress)); assert(team.weeks.every((w) => Number.isFinite(w.scores.stress)));
                    assert(!JSON.stringify(team).includes("tools_processes"));
                }
                for (const endpoint of ["/api/manager/overview", "/api/hr/overview"]) {
                    await request(app).get(endpoint).expect(401); await employee.get(endpoint).expect(403);
                }
                await manager.get("/api/hr/overview").expect(403); await hr.get("/api/manager/overview").expect(403);
                for (const agent of [manager, hr]) {
                    await agent.get("/api/employee/history").expect(403); await agent.get("/api/employee/check-ins/current").expect(403);
                    await agent.post("/api/employee/check-ins").send({}).expect(403);
                }
                await manager.get("/api/manager/actions").expect(200); await hr.get("/api/hr/activities").expect(200);
                const support = (await employee.get("/api/employee/activities").expect(200)).body;
                assert(support.length > 0); assert(support.every((a) => a.demo === false && !("source" in a)));
                await employee.get("/api/employee/history").expect(200);
                await employee.delete("/api/prototype/employee-session").expect(204); await employee.get("/api/employee/history").expect(401);
                assert.deepEqual(await fingerprint(), before);
                return;
            }
            const managerResult = (await manager.get("/api/manager/overview").expect(200)).body;
            assert.equal(managerResult.source, "postgres"); assert.equal(managerResult.available, true);
            for (const team of managerResult.teams.filter((t) => t.available)) {
                assert(team.responseCount >= 5); assert.equal(team.scores.stress, null);
                for (const key of ["wellbeing", "workloadBalance", "teamIntegration", "psychologicalSafety"])
                    assert(Number.isFinite(team.scores[key]));
                assert.equal(team.challenges.length, 8);
                for (const code of ["deadlines", "difficulty_integrating", "organizational_changes"]) {
                    const factor = team.challenges.find((f) => f.code === code);
                    assert.equal(factor.percentage, null); assert.equal(factor.reason, "not_measured_historically");
                }
                assert(!JSON.stringify(team).includes("tools_processes"));
            }
            const organization = (await hr.get("/api/hr/overview").expect(200)).body;
            assert.equal(organization.source, "postgres"); assert.equal(organization.available, false);
            assert.equal(organization.scores, null); assert.equal(organization.participation, null);
            assert.equal(organization.responseCount, null);
            assert.deepEqual(organization.participationAvailability, { available: false, reason: "protected_constituent" });
            assert(organization.departments.some((d) => d.available));
            assert(organization.departments.some((d) => !d.available && d.responseCount === null));
            const catalogue = (await readOnly.query("SELECT name FROM identity.departments ORDER BY department_id")).rows;
            assert.deepEqual(organization.departments.map((d) => d.name), catalogue.map((d) => d.name));
            for (const department of organization.departments.filter((d) => d.available)) {
                assert.equal(department.weeks.length, 8);
                assert(department.weeks.some((w) => w.available && Number.isFinite(w.scores.wellbeing)));
                assert.equal(department.scores.stress, null); assert.equal(department.monthlyChange.stress, null);
                for (const key of ["wellbeing", "workloadBalance", "teamIntegration", "psychologicalSafety"])
                    assert(Number.isFinite(department.scores[key]));
                for (const code of ["deadlines", "difficulty_integrating", "organizational_changes"])
                    assert.equal(department.challenges.find((f) => f.code === code).reason, "not_measured_historically");
            }
            const { renderOverview } = await import("../public/js/reporting.mjs");
            const hrHtml = renderOverview("hr", organization);
            assert(hrHtml.includes("DEPARTMENT DETAIL")); assert(hrHtml.includes("Stress tracking was introduced after these historical check-ins."));
            assert(hrHtml.includes("<polyline")); assert(!hrHtml.includes("Not measured historically"));
            assert(hrHtml.includes('data-theme-state="available"'));
            const platform = managerResult.teams.find((t) => t.name === "Platform");
            assert.equal(platform.available, true); assert.equal(platform.participation, 86);
            assert.equal(platform.reason ?? null, null);
            assert(renderOverview("manager", managerResult).includes("Participation: 86%"));
            for (const [name, expected] of [["Engineering", 86], ["Customer Experience", 88]]) {
                const index = organization.departments.findIndex((d) => d.name === name);
                const department = organization.departments[index];
                assert.equal(department.available, true); assert.equal(department.participation, expected);
                assert.equal(department.reason ?? null, null); assert.equal(department.scores.stress, null);
                assert.deepEqual(department.participationAvailability, { available: true, reason: null });
                const html = renderOverview("hr", organization, "stress", String(index));
                assert(html.includes(`Participation in ${name}`));
                assert(html.includes(`class="report-participation">${expected}%</strong>`));
                assert(html.includes("Stress tracking was introduced after these historical check-ins."));
                assert(html.includes('class="is-unavailable">Not yet available</strong>'));
            }
            const operationsIndex = organization.departments.findIndex((d) => d.name === "People and Operations");
            assert(operationsIndex >= 0);
            const operations = organization.departments[operationsIndex];
            assert.equal(operations.available, false); assert.equal(operations.participation, null);
            assert.equal(operations.scores, null); assert.equal(operations.responseCount, null);
            assert.deepEqual(operations.participationAvailability, { available: false, reason: "insufficient_responses" });
            assert.equal(operations.metricAvailability.stress, "not_measured_historically");
            const operationsHtml = renderOverview("hr", organization, "wellbeing", String(operationsIndex));
            assert(operationsHtml.includes("Not enough responses to protect employee privacy."));
            assert(operationsHtml.includes('class="report-participation is-unavailable">Participation unavailable</strong>'));
            assert(operationsHtml.includes("Not enough responses to calculate a privacy-safe participation rate."));
            const protectedCards = operationsHtml.match(/<div class="report-metrics">[^]*?<\/div>/)[0];
            assert.equal((protectedCards.match(/Insights unavailable/g) ?? []).length, 4);
            assert(protectedCards.includes("Not yet available"));
            // Every core organization measure would currently isolate Operations
            // by subtraction. Themes have a different, independent release.
            assert.equal(organization.sharedThemes.available, true);
            assert.equal(organization.sharedThemes.privacyBasis, "organization_with_complementary_suppression");
            for (const key of ["wellbeing", "workloadBalance", "teamIntegration", "psychologicalSafety"])
                assert(organization.weeks.every((week) => week.metricAvailability[key] === "protected_constituent"));
            assert(organization.weeks.every((week) => week.metricAvailability.stress === "not_measured_historically"));
            const organizationHtml = renderOverview("hr", organization, "wellbeing", "organization");
            assert(organizationHtml.includes("19% of responses selected this as a challenge."));
            assert(organizationHtml.includes("17% of responses selected this as a challenge."));
            assert(organizationHtml.includes("Wellbeing insights protected"));
            assert(organizationHtml.includes("Monthly changes are protected"));
            assert(!organizationHtml.includes("No shared themes are available for this period yet."));
            const start = organization.weeks[0].weekStart, last = organization.weeks.at(-1).weekStart;
            // Independent source diagnostics. Numerators/denominators for unsafe
            // groups stay test-local and are never added to the API payload.
            const diagnostic = async (firstWeek, lastWeek) => (await readOnly.query(`SELECT
                CASE WHEN GROUPING(d.name)=1 THEN 'All departments' ELSE d.name END AS scope,
                COUNT(DISTINCT tw.week_start)::int AS weeks, COUNT(r.response_id)::int AS completed,
                COUNT(c.user_id)::int AS eligible, COUNT(DISTINCT c.user_id) FILTER(WHERE r.response_id IS NOT NULL)::int AS people,
                COUNT(r.wellbeing_score)::int AS wellbeing, COUNT(r.workload_score)::int AS workload,
                COUNT(r.team_integration_score)::int AS connection, COUNT(r.psychological_safety_score)::int AS safety,
                COUNT(r.stress_score)::int AS stress
                FROM wellbeing.team_weeks tw JOIN identity.departments d USING(department_id)
                LEFT JOIN private.employee_weekly_checkins c ON c.team_id=tw.team_id AND c.week_start=tw.week_start
                LEFT JOIN wellbeing.wellbeing_responses r ON r.response_id=c.response_id AND r.team_id=tw.team_id AND r.week_start=tw.week_start
                WHERE tw.finalized_at IS NOT NULL AND tw.week_start BETWEEN $1::date AND $2::date
                GROUP BY GROUPING SETS((d.name),())`, [firstWeek, lastWeek])).rows;
            const latestDiagnostics = await diagnostic(last, last);
            for (const [name, numerator, denominator] of [["Engineering", 12, 14], ["Customer Experience", 7, 8],
                ["People and Operations", 2, 2], ["All departments", 21, 24]]) {
                const actual = latestDiagnostics.find((row) => row.scope === name); assert(actual);
                assert.equal(actual.completed, numerator); assert.equal(actual.eligible, denominator); assert.equal(actual.stress, 0);
                const scope = name === "All departments" ? organization : organization.departments.find((d) => d.name === name);
                if (scope.participationAvailability.available) assert.equal(scope.participation, Math.round(numerator / denominator * 100));
                else { assert.equal(scope.participation, null); assert.equal(scope.responseCount, null); }
            }
            const total = latestDiagnostics.find((row) => row.scope === "All departments");
            assert.equal(total.completed, 21, "Operations is included in the organization numerator");
            assert.equal(total.eligible, 24, "Operations is included in the organization denominator");
            assert.equal(total.completed - 12 - 7, 2, "A released total would identify the two protected Operations respondents");
            const periodDiagnostics = await diagnostic(start, last);
            for (const [name, numerator, denominator, people] of [["Engineering", 97, 112, 14], ["Customer Experience", 55, 64, 8],
                ["People and Operations", 14, 16, 2], ["All departments", 166, 192, 24]]) {
                const actual = periodDiagnostics.find((row) => row.scope === name);
                assert.equal(actual.weeks, 8); assert.equal(actual.completed, numerator); assert.equal(actual.eligible, denominator);
                assert.equal(actual.people, people); assert.equal(actual.stress, 0);
                for (const key of ["wellbeing", "workload", "connection", "safety"]) assert.equal(actual[key], numerator);
            }
            const perWeek = (await readOnly.query(`SELECT to_char(tw.week_start,'YYYY-MM-DD') AS week,
                COUNT(c.user_id)::int AS eligible,COUNT(r.response_id)::int AS completed
                FROM wellbeing.team_weeks tw JOIN identity.departments d USING(department_id)
                LEFT JOIN private.employee_weekly_checkins c ON c.team_id=tw.team_id AND c.week_start=tw.week_start
                LEFT JOIN wellbeing.wellbeing_responses r ON r.response_id=c.response_id AND r.team_id=tw.team_id AND r.week_start=tw.week_start
                WHERE d.name='People and Operations' AND tw.finalized_at IS NOT NULL AND tw.week_start BETWEEN $1::date AND $2::date
                GROUP BY tw.week_start ORDER BY tw.week_start`, [start, last])).rows;
            assert.equal(perWeek.length, 8); assert.deepEqual(perWeek.map((row) => row.completed), [2,2,2,2,1,1,2,2]);
            assert(perWeek.every((row) => row.eligible === 2));
            // Every historical team has fewer than 10 responses. With k=5,
            // no factor can simultaneously have 5 selections and 5 complements.
            for (const team of managerResult.teams.filter((t) => t.available))
                assert(team.challenges.every((f) => f.percentage === null));
            for (const scope of [...managerResult.teams, ...organization.departments, organization]) {
                const recent = scope.sharedThemes;
                assert(recent);
                assert.equal(recent.startWeek, scope.weeks[0].weekStart);
                assert.equal(recent.endWeek, scope.weeks.at(-1).weekStart);
                if (scope.available) {
                    for (const code of ["deadlines", "difficulty_integrating", "organizational_changes"])
                        assert.equal(recent.factors.find((f) => f.code === code).reason, "not_measured_historically");
                    assert(recent.factors.some((f) => Number.isFinite(f.percentage)));
                } else if (scope !== organization) {
                    assert(recent.factors.every((f) => f.percentage === null));
                }
            }
            // Independently count the FULL organization population and each
            // factor's hidden residual. These debug counts stay test-local.
            // DISTINCT protects transfers and repeated weekly contributors.
            for (const factor of organization.sharedThemes.factors) {
                const hidden = organization.departments.filter((department) => {
                    const f = department.sharedThemes.factors.find((item) => item.code === factor.code);
                    return !Number.isFinite(f.percentage) && f.reason !== "not_measured_historically";
                }).map((d) => d.departmentId);
                const counts = (await readOnly.query(`SELECT
                    COUNT(*)::int AS measured,COUNT(rc.response_id)::int AS chosen,
                    COUNT(DISTINCT c.user_id) FILTER(WHERE rc.response_id IS NOT NULL)::int AS yes_people,
                    COUNT(DISTINCT c.user_id) FILTER(WHERE rc.response_id IS NULL)::int AS no_people,
                    COUNT(DISTINCT c.user_id) FILTER(WHERE tw.department_id=ANY($4::bigint[]) AND rc.response_id IS NOT NULL)::int AS hidden_yes,
                    COUNT(DISTINCT c.user_id) FILTER(WHERE tw.department_id=ANY($4::bigint[]) AND rc.response_id IS NULL)::int AS hidden_no
                    FROM wellbeing.team_weeks tw JOIN private.employee_weekly_checkins c USING(team_id,week_start)
                    JOIN wellbeing.wellbeing_responses r ON r.response_id=c.response_id AND r.team_id=tw.team_id AND r.week_start=tw.week_start
                    JOIN wellbeing.challenge_factors f ON f.code=$1
                    LEFT JOIN wellbeing.response_challenges rc ON rc.response_id=r.response_id AND rc.challenge_factor_id=f.challenge_factor_id
                    WHERE tw.finalized_at IS NOT NULL AND tw.week_start BETWEEN $2::date AND $3::date
                    AND (f.code NOT IN ('deadlines','difficulty_integrating','organizational_changes') OR r.stress_score IS NOT NULL)`,
                [factor.code, start, last, hidden])).rows[0];
                if (counts.measured === 0) assert.equal(factor.reason, "not_measured_historically");
                else if (counts.yes_people < 5 || counts.no_people < 5) {
                    assert.equal(factor.percentage, null); assert.equal(factor.reason, "insufficient_responses");
                } else if (hidden.length === 1 || (hidden.length > 1 && (counts.hidden_yes < 5 || counts.hidden_no < 5))) {
                    assert.equal(factor.percentage, null); assert.equal(factor.reason, "protected_constituent");
                } else {
                    assert.equal(factor.reason, null); assert.equal(factor.percentage, Math.round(counts.chosen/counts.measured*100));
                    assert.equal(counts.measured, 166, "Operations remains in the organization denominator");
                }
            }
            assert.deepEqual(organization.sharedThemes.factors.filter((f) => f.reason === null).map((f) => [f.code, f.percentage]),
                [["workload", 19], ["unclear_priorities", 17]]);
            // Independently recalculate each authorized scope in SQL from the
            // source relationships. These debug counts are test-local only;
            // none are added to Manager/HR payloads.
            const verifyScope = async (scope, teamIds, departmentId) => {
                const { rows } = await readOnly.query(`SELECT code, SUM(measured)::int AS eligible_answers, SUM(chosen)::int AS selections,
                    BOOL_AND(people >= $5 AND (measured = 0 OR (chosen >= $5 AND measured-chosen >= $5
                        AND choosing_people >= $5 AND other_people >= $5))) AS safe
                    FROM (SELECT f.code,tw.team_id,tw.department_id, COUNT(DISTINCT c.user_id) AS people,
                        COUNT(r.response_id) FILTER (WHERE f.code NOT IN ('deadlines','difficulty_integrating','organizational_changes') OR r.stress_score IS NOT NULL) AS measured,
                        COUNT(rc.response_id) FILTER (WHERE f.code NOT IN ('deadlines','difficulty_integrating','organizational_changes') OR r.stress_score IS NOT NULL) AS chosen,
                        COUNT(DISTINCT c.user_id) FILTER (WHERE rc.response_id IS NOT NULL
                            AND (f.code NOT IN ('deadlines','difficulty_integrating','organizational_changes') OR r.stress_score IS NOT NULL)) AS choosing_people,
                        COUNT(DISTINCT c.user_id) FILTER (WHERE rc.response_id IS NULL
                            AND (f.code NOT IN ('deadlines','difficulty_integrating','organizational_changes') OR r.stress_score IS NOT NULL)) AS other_people
                        FROM wellbeing.team_weeks tw JOIN private.employee_weekly_checkins c USING(team_id,week_start)
                        JOIN wellbeing.wellbeing_responses r ON r.response_id=c.response_id AND r.team_id=tw.team_id AND r.week_start=tw.week_start
                        CROSS JOIN wellbeing.challenge_factors f LEFT JOIN wellbeing.response_challenges rc
                            ON rc.response_id=r.response_id AND rc.challenge_factor_id=f.challenge_factor_id
                        WHERE tw.finalized_at IS NOT NULL AND tw.week_start BETWEEN $3::date AND $4::date
                            AND (($1::bigint[] IS NOT NULL AND tw.team_id=ANY($1::bigint[])) OR ($2::bigint IS NOT NULL AND tw.department_id=$2))
                            AND f.code <> 'tools_processes'
                        GROUP BY f.code,tw.team_id,tw.department_id) AS period_cells GROUP BY code`,
                [teamIds, departmentId, scope.sharedThemes.startWeek, scope.sharedThemes.endWeek, 5]);
                for (const row of rows) {
                    const factor = scope.sharedThemes.factors.find((f) => f.code === row.code); assert(factor);
                    const expected = row.safe && row.eligible_answers > 0 ? Math.round(row.selections / row.eligible_answers * 100) : null;
                    assert.equal(factor.percentage, expected, `${scope.name}: ${row.code} = ${row.selections}/${row.eligible_answers}`);
                }
            };
            for (const team of managerResult.teams) await verifyScope(team, [team.teamId], null);
            for (const department of organization.departments) await verifyScope(department, null, department.departmentId);
            assert.equal(platform.sharedThemes.factors.find((f) => f.code === "workload").percentage, 60);
            assert.equal(platform.sharedThemes.factors.find((f) => f.code === "communication").percentage, 36);
            assert.equal(platform.sharedThemes.factors.find((f) => f.code === "work_life_balance").percentage, 28);
            noIndividualData(managerResult); noIndividualData(organization);
            for (const path of ["/api/manager/overview", "/api/hr/overview"]) {
                await request(app).get(path).expect(401); await employee.get(path).expect(403);
            }
            await manager.get("/api/hr/overview").expect(403); await hr.get("/api/manager/overview").expect(403);
            for (const agent of [manager, hr]) {
                await agent.get("/api/employee/history").expect(403);
                await agent.get("/api/employee/check-ins/current").expect(403);
                await agent.post("/api/employee/check-ins").send({}).expect(403);
            }
            const service = createReporting(() => readOnly);
            const managers = (await readOnly.query("SELECT user_id FROM identity.users WHERE role = 'manager' AND is_active")).rows;
            const results = await Promise.all(managers.map((m) => service.overview("manager", m.user_id)));
            assert(results.some((r) => r.teams.some((t) => !t.available)), "The small Operations team stays suppressed");
            results.forEach(noIndividualData);
            const factors = (await readOnly.query("SELECT code FROM wellbeing.challenge_factors WHERE code = 'tools_processes'")).rows;
            assert.equal(factors.length, 1, "Legacy catalogue entry stays stored");
            await employee.get("/api/employee/history").expect(200);
            await employee.delete("/api/prototype/employee-session").expect(204);
            await employee.get("/api/employee/history").expect(401);
            assert.deepEqual(await fingerprint(), before, "No persisted response changed during verification");
        } finally { await pool.end(); }
    });

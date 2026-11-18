const { isolatedDatabase } = require("./helpers/postgres-fixture.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");

test("PostgreSQL: Manager action creation, insight source, status persistence and privacy (rollback only)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1 with the local schema update applied." : false }, async () => {
        const pool = await isolatedDatabase(); const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const fingerprint = async () => (await client.query(`SELECT count(*) AS count,
                md5(string_agg(to_jsonb(r)::text, '|' ORDER BY response_id)) AS hash FROM wellbeing.wellbeing_responses r`)).rows[0];
            const before = await fingerprint();
            const nested = { query: (...args) => client.query(...args), async connect() { return {
                async query(sql, args) {
                    if (sql === "BEGIN") return client.query("SAVEPOINT action_test");
                    if (sql === "COMMIT") { await client.query("SET CONSTRAINTS ALL IMMEDIATE"); return client.query("RELEASE SAVEPOINT action_test"); }
                    if (sql === "ROLLBACK") { await client.query("ROLLBACK TO SAVEPOINT action_test"); return client.query("RELEASE SAVEPOINT action_test"); }
                    return client.query(sql, args);
                }, release() {}
            }; } };
            const app = createApp({ getPool: () => nested, minimumResponses: 5, prototypeAccess: true, sessionSecret: "real-action-test" });
            const manager = request.agent(app); await manager.post("/api/prototype/manager-session").send({}).expect(204);
            const overview = (await manager.get("/api/manager/overview").expect(200)).body;
            const team = overview.teams.find((t) => t.name === "Platform");
            const input = { teamId: team.teamId, title: "Transaction-only action plan", area: "workloadBalance",
                description: "Agree team capacity and review shared priorities.", targetDate: "2026-12-04", owner: "team_manager", sourceWeek: team.weekStart };
            const action = (await manager.post("/api/manager/actions").send(input).expect(201)).body;
            assert.equal(action.status, "planned"); assert.equal(action.owner, "Team Manager");
            const { rows: [stored] } = await client.query(`SELECT insight_week_start::text, insight_topic, description
                FROM operations.team_actions WHERE team_action_id = $1`, [action.id]);
            assert.equal(stored.insight_week_start, team.weekStart); assert.equal(stored.insight_topic, "workload");
            assert.equal(stored.description, input.description);
            for (const status of ["in_progress", "completed"]) {
                await manager.patch(`/api/manager/actions/${action.id}/status`).send({ status }).expect(200);
                const list = (await manager.get("/api/manager/actions").expect(200)).body;
                assert.equal(list.actions.find((a) => a.id === action.id).status, status);
                assert(!JSON.stringify(list).includes("owner_user_id")); assert(!JSON.stringify(list).includes("00000000-0000"));
            }
            const { sourceWeek, ...general } = input;
            const manual = (await manager.post("/api/manager/actions").send(general).expect(201)).body;
            assert.equal((await client.query("SELECT insight_week_start FROM operations.team_actions WHERE team_action_id=$1", [manual.id])).rows[0].insight_week_start, null);
            for (const role of ["employee", "hr"]) {
                const other = request.agent(app); await other.post(`/api/prototype/${role}-session`).send({}).expect(204);
                await other.get("/api/manager/actions").expect(403);
                await other.post("/api/manager/actions").send(input).expect(403);
                await other.patch(`/api/manager/actions/${action.id}/status`).send({ status: "completed" }).expect(403);
            }
            await request(app).get("/api/manager/actions").expect(401);
            await manager.patch(`/api/manager/actions/${action.id}/status`).send({ status: "invalid" }).expect(400);
            assert.deepEqual(await fingerprint(), before);
        } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
    });

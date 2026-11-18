const { isolatedDatabase } = require("./helpers/postgres-fixture.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { finalizeWeeks } = require("../db/finalize-weeks.cjs");

test("weekly finalization is atomic, releases its client and rolls back safely on failure", async () => {
    const calls = []; let released = false;
    const pool = { async connect() { return { async query(sql) {
        calls.push(sql); if (sql.includes("UPDATE")) throw Error("private database diagnostics");
    }, release() { released = true; } }; } };
    await assert.rejects(finalizeWeeks(pool), /private database diagnostics/);
    assert.equal(calls[0], "BEGIN"); assert.equal(calls.at(-1), "ROLLBACK"); assert(released);
});

test("PostgreSQL finalization closes only elapsed Lisbon weeks, is idempotent and preserves all data (rollback)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1." : false }, async () => {
        const pool = await isolatedDatabase(), client = await pool.connect();
        const { captureSnapshot } = require("../db/expand-demo.cjs");
        const before = await captureSnapshot(client);
        try {
            await client.query("BEGIN");
            const { rows: [closed] } = await client.query(`INSERT INTO wellbeing.team_weeks(team_id,department_id,week_start)
                SELECT team_id,department_id,(SELECT min(week_start)-7 FROM wellbeing.team_weeks)
                FROM identity.teams ORDER BY team_id LIMIT 1 RETURNING team_id,week_start`);
            const snapshot = await captureSnapshot(client); let n = 0;
            const nested = { async connect() { const name = 'finalize_' + (++n); return { async query(sql, args) {
                if (sql === "BEGIN") return client.query('SAVEPOINT ' + name);
                if (sql === "COMMIT") return client.query('RELEASE SAVEPOINT ' + name);
                if (sql === "ROLLBACK") { await client.query('ROLLBACK TO SAVEPOINT ' + name); return client.query('RELEASE SAVEPOINT ' + name); }
                return client.query(sql, args);
            }, release() {} }; } };
            const result = await finalizeWeeks(nested); assert.equal(result.finalized, 1);
            assert.deepEqual(await finalizeWeeks(nested), { finalized: 0 });
            const after = await captureSnapshot(client);
            for (const [table, rows] of Object.entries(snapshot.tables)) {
                if (table !== "wellbeing.team_weeks") assert.deepEqual(after.tables[table], rows, table);
            }
            const originalWeeks = before.tables["wellbeing.team_weeks"];
            for (const row of originalWeeks) assert(after.tables["wellbeing.team_weeks"].some((r) => JSON.stringify(r) === JSON.stringify(row)));
            assert((await client.query("SELECT finalized_at FROM wellbeing.team_weeks WHERE team_id=$1 AND week_start=$2", [closed.team_id, closed.week_start])).rows[0].finalized_at);
            // Still-open current and future weeks cannot be finalized early.
            assert.equal((await client.query(`SELECT count(*)::int AS count FROM wellbeing.team_weeks WHERE finalized_at IS NOT NULL
                AND week_start>=date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date`)).rows[0].count, 0);
        } finally {
            await client.query("ROLLBACK");
            const after = await captureSnapshot(client); assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.definitions, before.definitions);
            client.release(); await pool.end();
        }
    });

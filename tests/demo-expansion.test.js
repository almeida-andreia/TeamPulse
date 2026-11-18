const { isolatedDatabase } = require("./helpers/postgres-fixture.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { ISSUER, GROUPS, buildDataset, captureSnapshot, verifyPreserved, importDefinition, expandDemo } = require("../db/expand-demo.cjs");

test("fictional expansion is reproducible, has rotating eligibility and five stress answers per team/week", async () => {
    const plan = await buildDataset("2026-11-09");
    assert.deepEqual(plan, await buildDataset("2026-11-09"));
    assert.equal(plan.people.length, 28); assert.equal(plan.entries.length, 224);
    assert.equal(plan.entries.filter((entry) => entry.submitted).length, 192);
    assert(plan.people.every((person) => person.name.includes("(fictional)")));
    assert.equal(new Set(plan.entries.map((entry) => entry.subject + "/" + entry.week)).size, 224);
    for (const group of GROUPS) {
        const rows = plan.entries.filter((entry) => entry.team === group.team);
        const counts = [...new Set(rows.map((entry) => entry.week))].map((week) => rows.filter((entry) => entry.week === week && entry.submitted).length);
        assert(counts.every((count) => count >= 5)); assert(new Set(counts).size > 1);
        assert(rows.some((entry) => !entry.submitted));
    }
});

test("new synthetic answers use the canonical mappings and only the eight approved factors", async () => {
    const { ANSWER_OPTIONS, RATING_SCORES, CHALLENGES } = await import("../public/js/checkin.mjs");
    const plan = await buildDataset("2026-11-09");
    for (const { scores } of plan.entries.filter((entry) => entry.submitted)) {
        for (const key of ["wellbeing", "workload", "teamIntegration"]) assert(ANSWER_OPTIONS[key].some((option) => option.score === scores[key]));
        for (const key of ["stress", "psychologicalSafety"]) assert(Object.values(RATING_SCORES).includes(scores[key]));
        assert(scores.challenges.every((code) => CHALLENGES.some((factor) => factor.id === code)));
        assert.equal(new Set(scores.challenges).size, scores.challenges.length);
    }
    assert(plan.entries.some((entry) => entry.scores?.challenges.length > 1));
    const submitted = plan.entries.filter((entry) => entry.submitted);
    const average = (weeks, key) => { const rows = submitted.filter((entry) => weeks.includes(entry.week)); return rows.reduce((sum, entry) => sum + entry.scores[key], 0) / rows.length; };
    assert(average(["2026-10-12", "2026-10-19"], "stress") > average(["2026-09-14", "2026-09-21"], "stress"));
    assert(average(["2026-10-12", "2026-10-19"], "workload") > average(["2026-09-14", "2026-09-21"], "workload"));
});

test("preservation checks accept additions but reject rewriting or deleting any original row", () => {
    const before = { tables: { "identity.users": [{ id: 1, name: "Original" }], "operations.activities": [{ id: 2 }] }, functions: { guard: "original" } };
    const after = structuredClone(before); after.tables["identity.users"].push({ id: 3 }); verifyPreserved(before, after);
    for (const change of [(copy) => copy.tables["identity.users"].shift(), (copy) => copy.tables["identity.users"][0].name = "Changed",
        (copy) => copy.tables["operations.activities"].push({ id: 4 }), (copy) => copy.functions.guard = "weakened"]) {
        const invalid = structuredClone(after); change(invalid); assert.throws(() => verifyPreserved(before, invalid));
    }
});

test("maintenance exception is manifest-scoped and insert-only; unexpected guards fail closed", () => {
    const original = "BEGIN IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'immutable'; END IF; AND week_start = NEW.week_start AND finalized_at IS NULL FOR SHARE; END;";
    const definition = importDefinition(original, "m.response_id=NEW.response_id");
    assert(definition.includes("TG_OP = 'INSERT'")); assert(definition.includes("pg_temp.teampulse_demo_manifest"));
    assert(definition.includes("IF TG_OP <> 'INSERT'")); assert(!definition.includes("DISABLE TRIGGER"));
    assert.throws(() => importDefinition("unexpected definition", "true"));
});

test("PostgreSQL: additive demo dry-run preserves originals and restores every function (rollback)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1 for the local demo." : false }, async () => {
        const pool = await isolatedDatabase();
        try {
            const before = await captureSnapshot(pool);
            const result = await expandDemo(pool, { apply: false, baselinePath: process.env.TEAMPULSE_DEMO_BASELINE || null });
            const after = await captureSnapshot(pool);
            assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.definitions, before.definitions);
            assert.equal(result.applied, false); assert.equal(result.originalRecordsUnchanged, true);
            const exists = before.tables["identity.users"].some((user) => user.sso_issuer === ISSUER);
            assert.equal(result.newResponses, exists ? 0 : 192); assert.equal(result.newEmployees, exists ? 0 : 28);
            for (const scope of [result.organization, ...result.organization.departments, ...result.teams]) {
                assert.equal(scope.weeks.length, 8); assert(Number.isFinite(scope.scores.stress));
                assert(scope.sharedThemes.available); assert(scope.participation >= 80 && scope.participation <= 95);
            }
            if (process.env.TEAMPULSE_DEMO_BASELINE) {
                const baseline = JSON.parse(fs.readFileSync(process.env.TEAMPULSE_DEMO_BASELINE, "utf8"));
                verifyPreserved(baseline, after);
                assert.equal(baseline.tables["wellbeing.wellbeing_responses"].length, 167);
            }
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const week = (await client.query(`SELECT to_char(week_start,'YYYY-MM-DD') AS week_start,team_id
                    FROM wellbeing.team_weeks WHERE finalized_at IS NOT NULL ORDER BY week_start DESC,team_id LIMIT 1`)).rows[0];
                await client.query("SAVEPOINT closed_period");
                await assert.rejects(client.query(`INSERT INTO wellbeing.wellbeing_responses(team_id,week_start,
                    wellbeing_score,workload_score,stress_score,team_integration_score,psychological_safety_score)
                    VALUES($1,$2,5,5,5,5,5)`, [week.team_id, week.week_start]), /open reporting cohort/);
                await client.query("ROLLBACK TO SAVEPOINT closed_period");
                const original = before.tables["wellbeing.wellbeing_responses"][0];
                await assert.rejects(client.query("UPDATE wellbeing.wellbeing_responses SET stress_score=0 WHERE response_id=$1", [original.response_id]), /cannot be edited or deleted/);
                await client.query("ROLLBACK TO SAVEPOINT closed_period");
                assert.equal((await client.query("SELECT to_regclass('pg_temp.teampulse_demo_manifest') AS manifest")).rows[0].manifest, null);
            } finally { await client.query("ROLLBACK"); client.release(); }
        } finally { await pool.end(); }
    });

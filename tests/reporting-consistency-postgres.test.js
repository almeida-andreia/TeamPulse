const { isolatedDatabase } = require("./helpers/postgres-fixture.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createReporting } = require("../server/reporting");

// Independent, SELECT-only oracle for the isolated, fixed-clock demo. It reads the
// underlying rows, rather than reusing reporting's grouped sums or formulas.
test("PostgreSQL: released team/department/organization metrics match underlying records", {
    skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1 for the local demo." : false
}, async (t) => {
    const pool = await isolatedDatabase();
    const db = { query(sql, args) { assert.match(sql, /^\s*(?:\/\*[^]*?\*\/\s*)?SELECT\b/i); return pool.query(sql, args); } };
    const fields = { wellbeing: "wellbeing_score", workload: "workload_score", stress: "stress_score",
        teamIntegration: "team_integration_score", psychologicalSafety: "psychological_safety_score" };
    // Exact integer arithmetic in tenths: independent of reporting's floating
    // point formatting. Half a tenth rounds away from zero, as numeric SQL does.
    const decimal = ({ n, d }) => {
        const value = Math.floor((2 * Math.abs(n) + d) / (2 * d)) / 10;
        return value === 0 ? 0 : n < 0 ? -value : value;
    };
    const mean = (rows, key) => {
        const scores = rows.map((r) => r[fields[key]]).filter((v) => v !== null);
        return { n: scores.reduce((sum, v) => sum + Math.round(Number(v) * 10), 0), d: scores.length };
    };
    try {
        const report = createReporting(() => db);
        const manager = await report.overview("manager", await report.prototypeAccount("manager"));
        const hr = await report.overview("hr", await report.prototypeAccount("hr"));
        const { rows } = await db.query(`SELECT to_char(w.week_start,'YYYY-MM-DD') AS week,
            w.team_id,w.department_id,c.response_id,r.wellbeing_score,r.workload_score,r.stress_score,
            r.team_integration_score,r.psychological_safety_score
            FROM wellbeing.team_weeks w JOIN private.employee_weekly_checkins c USING(team_id,week_start)
            LEFT JOIN wellbeing.wellbeing_responses r ON r.response_id=c.response_id
            WHERE w.finalized_at IS NOT NULL
                AND w.week_start >= date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date-56
                AND w.week_start < date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date`);
        const { CHALLENGES } = await import("../public/js/checkin.mjs");
        const { rows: choices } = await db.query(`SELECT rc.response_id,f.code FROM wellbeing.response_challenges rc
            JOIN wellbeing.challenge_factors f USING(challenge_factor_id)`);
        const selections = new Set(choices.map((r) => `${r.response_id}/${r.code}`));
        const scopes = [
            ...manager.teams.map((data) => ({ name: data.name, data, filter: (r) => String(r.team_id) === data.teamId })),
            ...hr.departments.map((data) => ({ name: data.name, data, filter: (r) => String(r.department_id) === data.departmentId })),
            { name: "Organization", data: hr, filter: () => true }
        ];
        for (const { name, data, filter } of scopes) await t.test(name, () => {
            assert(data.available, "The approved synthetic demo scope should be available");
            assert.equal(data.weeks.length, 8);
            const scoped = rows.filter(filter);
            for (const week of data.weeks) {
                const eligible = scoped.filter((r) => r.week === week.weekStart);
                const answered = eligible.filter((r) => r.response_id !== null);
                assert.equal(week.responseCount, answered.length);
                assert.equal(week.participation, Math.round(answered.length / eligible.length * 100));
                for (const key of Object.keys(fields)) {
                    assert.equal(week.scores[key], decimal(mean(answered, key)), `${week.weekStart}: ${key}`);
                    assert(week.scores[key] >= 0 && week.scores[key] <= 10);
                }
                const pressure = mean(answered, "workload");
                assert.equal(week.scores.workloadBalance, decimal({ n: 100 * pressure.d - pressure.n, d: pressure.d }));
            }
            assert.deepEqual(data.scores, data.weeks.at(-1).scores);
            assert.equal(data.participation, data.weeks.at(-1).participation);
            const month = data.weekStart.slice(0, 7), previous = new Date(`${month}-01T12:00:00Z`);
            previous.setUTCMonth(previous.getUTCMonth() - 1);
            const previousMonth = previous.toISOString().slice(0, 7);
            const answers = scoped.filter((r) => r.response_id !== null);
            for (const key of Object.keys(fields)) {
                const after = mean(answers.filter((r) => r.week.startsWith(month)), key);
                const before = mean(answers.filter((r) => r.week.startsWith(previousMonth)), key);
                assert.equal(data.monthlyChange[key], decimal({ n: after.n * before.d - before.n * after.d, d: after.d * before.d }), `Monthly ${key}`);
            }
            const beforePressure = mean(answers.filter((r) => r.week.startsWith(previousMonth)), "workload");
            const afterPressure = mean(answers.filter((r) => r.week.startsWith(month)), "workload");
            assert.equal(data.monthlyChange.workloadBalance, decimal({ n: beforePressure.n * afterPressure.d - afterPressure.n * beforePressure.d,
                d: beforePressure.d * afterPressure.d }));
            assert.equal(data.sharedThemes.factors.length, CHALLENGES.length);
            for (const factor of data.sharedThemes.factors.filter((f) => Number.isFinite(f.percentage))) {
                const measured = answers.filter((r) => !["deadlines", "difficulty_integrating", "organizational_changes"].includes(factor.code) || r.stress_score !== null);
                const chosen = measured.filter((r) => selections.has(`${r.response_id}/${factor.code}`));
                assert.equal(factor.percentage, Math.round(chosen.length / measured.length * 100), factor.code);
                assert(factor.percentage >= 0 && factor.percentage <= 100);
            }
        });
    } finally { await pool.end(); }
});

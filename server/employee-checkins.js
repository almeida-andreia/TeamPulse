// Employee-only persistence. Identity comes from the server session, never from
// submitted answers. Reuse the browser's pure canonical validator/normalizer.
const canonical = import("../public/js/checkin.mjs");
const wellbeing = import("../public/js/wellbeing.mjs");
const problem = (status, message) => Object.assign(new Error(message), { status });
const addDays = (key, days) => {
    const date = new Date(`${key}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
};
const currentWeekSql = `SELECT
    to_char(date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon'), 'YYYY-MM-DD') AS week_start,
    to_char(date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon') + interval '7 days', 'YYYY-MM-DD') AS next_week,
    to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD') AS today`;

// Reuse the database's Lisbon Monday cohort and local date. Friday opens at
// 00:00 Lisbon; the window ends when that same calendar advances on Monday.
function weeklyAvailability(week) {
    const opensOn = addDays(week.week_start, 4);
    return { opensOn, nextOpensOn: addDays(week.next_week, 4), available: week.today >= opensOn && week.today < week.next_week };
}

function createEmployeeCheckins(getPool) {
    async function account(userId, client = getPool(), lock = false) {
        const { rows } = await client.query(`SELECT user_id, display_name, role, team_id, is_active
            FROM identity.users WHERE user_id = $1${lock ? " FOR SHARE" : ""}`, [userId]);
        const user = rows[0];
        if (!user?.is_active) throw problem(401, "Please sign in again to continue.");
        return user;
    }
    async function employee(userId, client = getPool(), lock = false) {
        const user = await account(userId, client, lock);
        if (user.role !== "employee") throw problem(403, "This service is available to Employees only.");
        return user;
    }

    async function prototypeEmployee() {
        // Fixed existing fictional presentation account: Platform Employee with
        // private history and an existing appointment. Never caller-selected.
        // Real SSO must replace prototype access before deployment.
        const { rows } = await getPool().query(`SELECT user_id FROM identity.users
            WHERE sso_issuer = $1 AND sso_subject = $2 AND role = 'employee' AND is_active`,
        ["https://sso.example.invalid", "employee-05"]);
        if (!rows[0]) throw problem(503, "The local demo Employee is unavailable.");
        return rows[0].user_id;
    }

    async function status(userId) {
        await employee(userId);
        const { rows: [week] } = await getPool().query(currentWeekSql);
        const { rows } = await getPool().query(`SELECT c.response_id, w.finalized_at
            FROM private.employee_weekly_checkins c
            JOIN wellbeing.team_weeks w USING (team_id, week_start)
            WHERE c.user_id = $1 AND c.week_start = $2`, [userId, week.week_start]);
        if (rows[0]?.finalized_at) throw problem(409, "This check-in period is closed.");
        const submitted = Boolean(rows[0]?.response_id);
        const schedule = weeklyAvailability(week);
        return { weekStart: week.week_start, nextWeek: week.next_week, ...schedule, submitted,
            available: !submitted && schedule.available };
    }

    async function submit(userId, answers) {
        const { normalizeCheckin } = await canonical;
        const normalized = normalizeCheckin(answers); // strict raw-answer whitelist
        const client = await getPool().connect();
        let transaction = false;
        let discardConnection;
        try {
            await client.query("BEGIN"); transaction = true;
            const user = await employee(userId, client, true);
            const { rows: [week] } = await client.query(currentWeekSql);
            if (!weeklyAvailability(week).available) throw problem(409, "Your weekly check-in opens on Friday. Please come back then.");
            const lockEligibility = () => client.query(`SELECT c.team_id, c.response_id, w.finalized_at
                FROM private.employee_weekly_checkins c
                JOIN wellbeing.team_weeks w USING (team_id, week_start)
                WHERE c.user_id = $1 AND c.week_start = $2 FOR UPDATE OF c`, [userId, week.week_start]);
            let { rows: [eligibility] } = await lockEligibility();
            if (!eligibility) {
                // New weeks need the existing cohort/eligibility model, not new
                // tables. Snapshot the department and ALL current team members,
                // including nonrespondents. Never replace prior weekly snapshots.
                await client.query(`INSERT INTO wellbeing.team_weeks (team_id, week_start, department_id)
                    SELECT team_id, $2::date, department_id FROM identity.teams WHERE team_id = $1
                    ON CONFLICT (team_id, week_start) DO NOTHING`, [user.team_id, week.week_start]);
                const { rows: [cohort] } = await client.query(`SELECT finalized_at FROM wellbeing.team_weeks
                    WHERE team_id = $1 AND week_start = $2 FOR SHARE`, [user.team_id, week.week_start]);
                if (!cohort || cohort.finalized_at) throw problem(409, "This check-in period is unavailable.");
                await client.query(`INSERT INTO private.employee_weekly_checkins (user_id, week_start, team_id)
                    SELECT user_id, $2::date, team_id FROM identity.users
                    WHERE team_id = $1 AND role = 'employee' AND is_active ORDER BY user_id
                    ON CONFLICT (user_id, week_start) DO NOTHING`, [user.team_id, week.week_start]);
                ({ rows: [eligibility] } = await lockEligibility());
            }
            if (!eligibility || eligibility.finalized_at) throw problem(409, "This check-in period is unavailable.");
            if (eligibility.response_id) throw problem(409, "You've already checked in this week. Thank you.");
            const { rows: factors } = await client.query(`SELECT challenge_factor_id, code
                FROM wellbeing.challenge_factors WHERE code = ANY($1::text[]) FOR SHARE`, [normalized.challenges]);
            if (factors.length !== normalized.challenges.length)
                throw problem(400, "One or more challenge choices are unavailable. Please review your answers.");
            // No identity is inserted here. Ownership is attached ONLY through
            // the protected private link after all challenge selections are saved.
            const { rows: [response] } = await client.query(`INSERT INTO wellbeing.wellbeing_responses
                (team_id, week_start, wellbeing_score, workload_score, stress_score,
                 team_integration_score, psychological_safety_score, comment)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING response_id`,
            [eligibility.team_id, week.week_start, normalized.wellbeing, normalized.workload, normalized.stress,
                normalized.teamIntegration, normalized.psychologicalSafety, normalized.comment || null]);
            for (const factor of factors) {
                await client.query(`INSERT INTO wellbeing.response_challenges (response_id, challenge_factor_id)
                    VALUES ($1, $2)`, [response.response_id, factor.challenge_factor_id]);
            }
            const attached = await client.query(`UPDATE private.employee_weekly_checkins SET response_id = $3
                WHERE user_id = $1 AND week_start = $2 AND response_id IS NULL`, [userId, week.week_start, response.response_id]);
            if (attached.rowCount !== 1) throw problem(409, "This check-in has already been submitted.");
            // Reciprocal deferred FKs validate the one-to-one private ownership
            // at COMMIT; the existing (user_id, week_start) PK + row lock prevents
            // duplicates even across tabs, concurrent requests and team transfers.
            await client.query("COMMIT"); transaction = false;
            return { weekStart: week.week_start };
        } catch (error) {
            if (transaction) { try { await client.query("ROLLBACK"); } catch (rollbackError) { discardConnection = rollbackError; } }
            throw error;
        } finally { client.release(discardConnection); }
    }

    async function history(userId, period = "30days") {
        if (!["30days", "quarter", "year"].includes(period)) throw problem(400, "Please choose a supported period.");
        await employee(userId);
        const { rows: [week] } = await getPool().query(currentWeekSql);
        // Only session-owned history: no arbitrary user/team query parameter.
        // Historical membership comes from the private link, not current users.team_id.
        const { rows } = await getPool().query(`SELECT to_char(r.week_start, 'YYYY-MM-DD') AS week_start,
            r.wellbeing_score, r.workload_score, r.stress_score,
            r.team_integration_score, r.psychological_safety_score
            FROM private.employee_weekly_checkins c
            JOIN wellbeing.wellbeing_responses r ON r.response_id = c.response_id
                AND r.team_id = c.team_id AND r.week_start = c.week_start
            WHERE c.user_id = $1 AND c.week_start <= $2::date ORDER BY c.week_start`, [userId, week.today]);
        const { SCORE_FIELDS } = await canonical;
        const fields = ["wellbeing_score", "workload_score", "stress_score", "team_integration_score", "psychological_safety_score"];
        const entries = rows.map((row) => ({ weekStart: row.week_start,
            ...Object.fromEntries(SCORE_FIELDS.map((key, i) => [key, row[fields[i]] == null ? null : Number(row[fields[i]])])) }));
        const latest = entries.at(-1) ?? null;
        const today = week.today, month = Number(today.slice(5, 7));
        const start = period === "year" ? `${today.slice(0, 4)}-01-01`
            : period === "quarter" ? `${today.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`
                : addDays(today, -29);
        const priorMonth = latest ? addDays(`${latest.weekStart.slice(0, 7)}-01`, -1).slice(0, 7) : null;
        const average = (prefix, key) => {
            const values = entries.filter((entry) => entry.weekStart.startsWith(prefix)).map((entry) => entry[key]).filter(Number.isFinite);
            return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        };
        const monthlyChange = Object.fromEntries(SCORE_FIELDS.map((key) => {
            const before = latest ? average(priorMonth, key) : null;
            const after = latest ? average(latest.weekStart.slice(0, 7), key) : null;
            return [key, before === null || after === null ? null : after - before];
        }));
        // DTO deliberately excludes response/user/team IDs, comments and challenges.
        const { monthlyCompletion } = await wellbeing;
        return { entries: entries.filter((entry) => entry.weekStart >= start), latest, monthlyChange,
            monthlyCompletion: monthlyCompletion(entries, today) };
    }
    return { account, employee, prototypeEmployee, status, submit, history };
}
module.exports = { createEmployeeCheckins };

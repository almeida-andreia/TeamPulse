// Fixed finalized releases: weekly metrics and an 8-week shared-themes window.
// No live counts, arbitrary date/team
// filters, comments, ownership identifiers or response rows leave this service.
// MIN_RESPONSES is deployment configuration, not an Assignment 1 constant.
const dimensions = [
    ["wellbeing", "wellbeing_score"], ["workload", "workload_score"], ["stress", "stress_score"],
    ["teamIntegration", "team_integration_score"], ["psychologicalSafety", "psychological_safety_score"]
];
// Current questionnaire only. Legacy tools_processes selections stay in the DB
// and are never folded into one of these eight factors.
const currentFactors = ["workload", "deadlines", "communication", "difficulty_integrating",
    "unclear_priorities", "limited_support", "work_life_balance", "organizational_changes"];
const newFactors = ["deadlines", "difficulty_integrating", "organizational_changes"];
const unavailable = (reason) => ({ available: false, reason, responseCount: null, participation: null,
    scores: null, monthlyChange: null, challenges: [] });
const error = (status, message) => Object.assign(new Error(message), { status });
// Match PostgreSQL numeric rounding (nearest tenth, ties away from zero).
// Compensate only binary arithmetic noise at a tie, e.g. 79.8 / 12 becomes
// 6.649999999999999. Unrounded means, weights and release decisions stay intact.
const scoreDecimal = (value) => {
    const rounded = Math.round((Math.abs(value) + Number.EPSILON * Math.max(1, Math.abs(value)) * 16) * 10) / 10;
    return rounded === 0 ? 0 : value < 0 ? -rounded : rounded;
};
function configuredMinimum(value) {
    // A single person's answer can never be an aggregate, even if misconfigured.
    return /^\d+$/.test(String(value ?? "")) && Number.isSafeInteger(Number(value)) && Number(value) >= 2 ? Number(value) : null;
}

function createReporting(getPool, { minimumResponses = () => process.env.MIN_RESPONSES } = {}) {
    async function prototypeAccount(role) {
        const subject = { manager: "manager-platform", hr: "hr-marta" }[role];
        if (!subject) throw error(403, "This prototype role is unavailable.");
        const { rows } = await getPool().query(`SELECT user_id FROM identity.users
            WHERE sso_issuer = $1 AND sso_subject = $2 AND role = $3 AND is_active`,
        ["https://sso.example.invalid", subject, role]);
        if (!rows[0]) throw error(503, "The local prototype account is unavailable.");
        return rows[0].user_id;
    }

    async function overview(role, userId) {
        const manager = role === "manager";
        if (!manager && role !== "hr") throw error(403, "This reporting space is unavailable.");
        // Scope is resolved exclusively from the authenticated database account.
        const { rows: teams } = await getPool().query(`/* reporting:teams */
            SELECT t.team_id, t.name, t.department_id, d.name AS department_name
            FROM identity.teams t JOIN identity.departments d USING (department_id)
            ${manager ? "WHERE t.manager_user_id = $1" : ""} ORDER BY t.team_id`, manager ? [userId] : []);
        const minimum = configuredMinimum(typeof minimumResponses === "function" ? minimumResponses() : minimumResponses);
        const base = { source: "postgres", role, minimumResponses: minimum,
            period: "Latest 8 completed weeks · finalized cohorts only" };
        if (!minimum) return { ...base, ...unavailable("privacy_not_configured"), teams: [], departments: [], weeks: [] };
        // Include every real department, even one without a team or historical
        // cohort. Availability never determines membership in the HR selector.
        const { rows: departmentCatalogue } = manager ? { rows: [] } : await getPool().query(`/* reporting:departments */
            SELECT department_id, name FROM identity.departments ORDER BY department_id`);
        if (!teams.length) return { ...base, ...unavailable("no_data"), teams: [],
            departments: departmentCatalogue.map((d) => ({ departmentId: String(d.department_id), name: d.name, ...unavailable("no_data"), weeks: [] })), weeks: [] };
        const ids = teams.map((team) => team.team_id);
        const scoreSql = dimensions.map(([key, column]) => `SUM(r.${column}) AS "${key}Sum", COUNT(r.${column}) AS "${key}Count"`).join(",\n");
        // One row per TEAM/WEEK, containing sums/counts only. Challenge joins are
        // separate so multiple selections cannot inflate averages/participation.
        const { rows: cohorts } = await getPool().query(`/* reporting:cohorts */
            SELECT tw.team_id, tw.department_id, d.name AS department_name,
                to_char(tw.week_start, 'YYYY-MM-DD') AS week_start,
                COUNT(c.user_id) AS eligible, COUNT(DISTINCT c.user_id) FILTER (WHERE c.response_id IS NOT NULL) AS responses,
                ${scoreSql}
            FROM wellbeing.team_weeks tw JOIN identity.departments d ON d.department_id = tw.department_id
            LEFT JOIN private.employee_weekly_checkins c ON c.team_id = tw.team_id AND c.week_start = tw.week_start
            LEFT JOIN wellbeing.wellbeing_responses r ON r.response_id = c.response_id
                AND r.team_id = tw.team_id AND r.week_start = tw.week_start
            WHERE tw.team_id = ANY($1::bigint[]) AND tw.finalized_at IS NOT NULL
                AND tw.week_start >= date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date - 56
                AND tw.week_start < date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date
            GROUP BY tw.team_id, tw.department_id, d.name, tw.week_start
            ORDER BY tw.week_start, tw.team_id`, [ids]);
        const { rows: factors } = await getPool().query(`/* reporting:challenges */
            SELECT tw.team_id, to_char(tw.week_start, 'YYYY-MM-DD') AS week_start,
                f.code, f.label,
                COUNT(r.response_id) FILTER (WHERE NOT (f.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AS measured,
                COUNT(rc.response_id) FILTER (WHERE NOT (f.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AS selected
            FROM wellbeing.team_weeks tw CROSS JOIN wellbeing.challenge_factors f
            LEFT JOIN wellbeing.wellbeing_responses r ON r.team_id = tw.team_id AND r.week_start = tw.week_start
            LEFT JOIN wellbeing.response_challenges rc ON rc.response_id = r.response_id AND rc.challenge_factor_id = f.challenge_factor_id
            WHERE tw.team_id = ANY($1::bigint[]) AND f.code = ANY($2::text[]) AND tw.finalized_at IS NOT NULL
                AND tw.week_start >= date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date - 56
                AND tw.week_start < date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date
            GROUP BY tw.team_id, tw.week_start, f.code, f.label`, [ids, currentFactors, newFactors]);
        // Compatibility policy for this verified dataset: the legacy four-score
        // questionnaire did not ask the three new factors. Non-null stress marks
        // the current five-answer contract (required for all new submissions).
        // This is catalogue provenance, never an estimate of a missing score.
        // Weekly releases still withhold mixed-version new-factor percentages.
        // Recent themes use only actually measured answers, protecting that
        // subset independently; unasked answers never become negative selections.
        // Include missing/unfinalized cohorts as gaps. Never substitute an older
        // safe week as if it were the latest week, or publish a changing live set.
        const { rows: calendar } = await getPool().query(`/* reporting:calendar */ SELECT
            to_char(date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date - n * 7, 'YYYY-MM-DD') AS week_start
            FROM generate_series(8, 1, -1) AS n`);
        // Aggregate FIRST for Shared Themes. Only aggregate counts leave SQL;
        // ownership identifiers are used internally to avoid counting the same
        // person's repeated submissions as several people for privacy purposes.
        // Historical department membership comes from each finalized team_week.
        const { rows: periodFactors } = await getPool().query(`/* reporting:theme-period */ SELECT
            tw.team_id, tw.department_id, f.code, f.label,
            COUNT(DISTINCT c.user_id) FILTER (WHERE r.response_id IS NOT NULL) AS participants,
            COUNT(r.response_id) FILTER (WHERE NOT (f.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AS measured,
            COUNT(rc.response_id) FILTER (WHERE NOT (f.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AS selected,
            COUNT(DISTINCT c.user_id) FILTER (WHERE (NOT (f.code = ANY($3::text[])) OR r.stress_score IS NOT NULL)
                AND rc.response_id IS NOT NULL) AS selecting_participants,
            COUNT(DISTINCT c.user_id) FILTER (WHERE (NOT (f.code = ANY($3::text[])) OR r.stress_score IS NOT NULL)
                AND r.response_id IS NOT NULL AND rc.response_id IS NULL) AS nonselecting_participants
            FROM wellbeing.team_weeks tw CROSS JOIN wellbeing.challenge_factors f
            LEFT JOIN private.employee_weekly_checkins c ON c.team_id = tw.team_id AND c.week_start = tw.week_start AND c.response_id IS NOT NULL
            LEFT JOIN wellbeing.wellbeing_responses r ON r.response_id = c.response_id AND r.team_id = tw.team_id AND r.week_start = tw.week_start
            LEFT JOIN wellbeing.response_challenges rc ON rc.response_id = r.response_id AND rc.challenge_factor_id = f.challenge_factor_id
            WHERE tw.team_id = ANY($1::bigint[]) AND f.code = ANY($2::text[]) AND tw.finalized_at IS NOT NULL
                AND tw.week_start = ANY($4::date[])
            GROUP BY tw.team_id, tw.department_id, f.code, f.label`,
        [ids, currentFactors, newFactors, calendar.map((week) => week.week_start)]);
        const cohortSafe = (row) => Number(row.responses) >= minimum;
        const selectionSafe = (selected, measured) => selected >= minimum && measured - selected >= minimum;
        const cohortReleaseSafe = (rows, expectedTeams) => expectedTeams.length > 0
            && rows.length === expectedTeams.length && rows.every(cohortSafe);
        // Organization releases have their own minimum, then a complementary
        // disclosure check against the department results this HR user receives.
        // A single hidden department must never be recovered by subtraction.
        // Multiple hidden departments may form a safe residual population, but
        // repeated answers still must not be counted as different people.
        const organizationReason = (complete, people, hiddenDepartments, residualPeople) => !complete || !Number.isSafeInteger(people) || people < minimum
            ? "insufficient_responses" : hiddenDepartments.length === 0 ? null
                : hiddenDepartments.length > 1 && Number.isSafeInteger(residualPeople) && residualPeople >= minimum ? null : "protected_constituent";
        const completeOrganization = (rows, expectedTeams) => expectedTeams.length > 0 && rows.length === expectedTeams.length
            && expectedTeams.every((id) => rows.some((row) => String(row.team_id) === String(id)));
        const participationMetadata = (result) => manager ? {} : {
            participationAvailability: { available: result.available, reason: result.reason }
        };
        function releaseParticipation(rows, expectedTeams, departments, date) {
            // Participation is evaluated from completed/eligible check-ins ONLY.
            // Missing stress or other scores cannot affect this decision.
            // The existing count/rate policy still protects every constituent:
            // a total minus released siblings must not reveal a small group.
            if (departments) {
                const hidden = [...new Set(rows.map((row) => String(row.department_id)))].filter((id) =>
                    !departments.find((department) => department.departmentId === id)?.weeks
                        .find((week) => week.weekStart === date)?.participationAvailability?.available);
                const numerator = rows.reduce((sum, row) => sum + Number(row.responses), 0);
                const denominator = rows.reduce((sum, row) => sum + Number(row.eligible), 0);
                const residual = rows.filter((row) => hidden.includes(String(row.department_id)))
                    .reduce((sum, row) => sum + Number(row.responses), 0);
                // Weekly uniqueness makes these response counts distinct people
                // within this single week. Never average department percentages.
                let reason = organizationReason(completeOrganization(rows, expectedTeams), numerator, hidden, residual);
                if (!reason && hidden.length) {
                    // Counts need an additional integer-bound check. A pooled
                    // k alone is insufficient: if two protected single-team
                    // departments can have at most 4 and 2 responses, releasing
                    // their combined 6 would disclose BOTH exact counts.
                    // A protected department has at least one below-k team.
                    // Use known eligibility + that public suppression rule to
                    // bound its possible count, without publishing the bounds.
                    const bounds = hidden.map((id) => {
                        const cells = rows.filter((row) => String(row.department_id) === id);
                        const eligible = cells.reduce((sum, row) => sum + Number(row.eligible), 0);
                        return eligible - Math.min(...cells.map((row) => Math.max(0, Number(row.eligible) - minimum + 1)));
                    });
                    const maximum = bounds.reduce((sum, bound) => sum + bound, 0);
                    if (bounds.some((bound) => Math.max(0, residual - (maximum - bound)) === Math.min(bound, residual)))
                        reason = "protected_constituent";
                }
                return reason || denominator <= 0 ? { available: false, reason: reason ?? "no_data", value: null }
                    : { available: true, reason: null, value: Math.round(numerator / denominator * 100) };
            }
            if (!cohortReleaseSafe(rows, expectedTeams)) {
                const protectedConstituent = rows.length === expectedTeams.length && rows.length > 1
                    && rows.reduce((sum, row) => sum + Number(row.responses), 0) >= minimum;
                return { available: false, reason: protectedConstituent ? "protected_constituent" : "insufficient_responses", value: null };
            }
            const numerator = rows.reduce((sum, row) => sum + Number(row.responses), 0);
            const denominator = rows.reduce((sum, row) => sum + Number(row.eligible), 0);
            return denominator > 0 ? { available: true, reason: null, value: Math.round(numerator / denominator * 100) }
                : { available: false, reason: "no_data", value: null };
        }
        // Shared historical questionnaire provenance, not a protected group's
        // individual answers: use this only if the ENTIRE authorized HR window
        // has no stress answers. Never expose a small group's differing version.
        const historicalHrStress = !manager && cohorts.length > 0 && cohorts.every((row) => Number(row.stressCount) === 0);

        // Weekly releases keep the existing per-week rule. Period releases below
        // use the same k and complement test AFTER aggregating all eligible weeks.
        function releaseChallenges(rows, complete) {
            return currentFactors.map((code) => {
                const cells = rows.map((row) => ({ row, matches: factors.filter((factor) => factor.code === code
                    && factor.week_start === row.week_start && String(factor.team_id) === String(row.team_id)) }));
                let safe = complete && rows.length > 0, known = true, measured = 0, selected = 0, allAsked = true;
                for (const { row, matches } of cells) {
                    const factor = matches[0], answered = Number(factor?.measured), chosen = Number(factor?.selected);
                    const valid = matches.length === 1 && Number.isInteger(answered) && Number.isInteger(chosen)
                        && answered >= 0 && chosen >= 0 && chosen <= answered && answered <= Number(row.responses);
                    if (!valid) { safe = false; known = false; continue; }
                    measured += answered; selected += chosen;
                    allAsked &&= answered === Number(row.responses);
                    // Unasked responses never enter the denominator. A factor
                    // not yet introduced in a week is not a negative answer.
                    safe &&= selectionSafe(chosen, answered);
                }
                const asked = allAsked;
                const publish = safe && asked && selectionSafe(selected, measured);
                return { code, label: factors.find((f) => f.code === code)?.label ?? code,
                    percentage: publish ? Math.round(selected / measured * 100) : null,
                    reason: !complete || !known ? "insufficient_responses" : !asked ? "not_measured_historically"
                        : !publish ? "insufficient_responses" : null };
            });
        }
        function recentThemes(rows, complete) {
            const keys = [...new Set(rows.map((r) => `${r.team_id}/${r.department_id}`))];
            const leaves = periodFactors.filter((f) => keys.includes(`${f.team_id}/${f.department_id}`));
            const available = complete && keys.length > 0
                && keys.every((key) => leaves.some((f) => `${f.team_id}/${f.department_id}` === key && Number(f.participants) >= minimum));
            return { available, factors: currentFactors.map((code) => {
                const cells = keys.map((key) => leaves.filter((f) => f.code === code && `${f.team_id}/${f.department_id}` === key));
                let safe = available, known = true, selected = 0, measured = 0;
                for (const matches of cells) {
                    const f = matches[0], n = Number(f?.measured), yes = Number(f?.selected);
                    const yesPeople = Number(f?.selecting_participants), noPeople = Number(f?.nonselecting_participants);
                    if (matches.length !== 1 || ![n, yes, yesPeople, noPeople].every(Number.isInteger)
                        || n < 0 || yes < 0 || yes > n || yesPeople < 0 || yesPeople > yes || noPeople < 0 || noPeople > n - yes) {
                        safe = false; known = false; continue;
                    }
                    selected += yes; measured += n;
                    if (n === 0) continue; // not asked in this constituent period
                    // Protect both sides and small constituent groups at the
                    // PERIOD level, so parent/sibling subtraction stays safe.
                    // Five repeated answers from one person are not five people.
                    safe &&= selectionSafe(yes, n) && yesPeople >= minimum && noPeople >= minimum;
                }
                const publish = safe && known && measured > 0 && selectionSafe(selected, measured);
                return { code, label: leaves.find((f) => f.code === code)?.label ?? factors.find((f) => f.code === code)?.label ?? code,
                    percentage: publish ? Math.round(selected / measured * 100) : null,
                    reason: !available || !known ? "insufficient_responses" : measured === 0 ? "not_measured_historically"
                        : !publish ? "insufficient_responses" : null };
            }) };
        }

        function release(rows, expectedTeams, date, departments) {
            const participation = releaseParticipation(rows, expectedTeams, departments, date);
            if (departments) {
                const complete = completeOrganization(rows, expectedTeams), metricAvailability = {};
                const scores = Object.fromEntries(dimensions.map(([key]) => {
                    const count = rows.reduce((sum, row) => sum + Number(row[`${key}Count`]), 0);
                    const hidden = [...new Set(rows.map((row) => String(row.department_id)))].filter((id) => {
                        const week = departments.find((department) => department.departmentId === id)?.weeks.find((item) => item.weekStart === date);
                        return !Number.isFinite(week?.scores?.[key]) && week?.metricAvailability?.[key] !== "not_measured_historically";
                    });
                    const residual = rows.filter((row) => hidden.includes(String(row.department_id)))
                        .reduce((sum, row) => sum + Number(row[`${key}Count`]), 0);
                    let reason = complete && count === 0 ? "not_measured_historically"
                        : organizationReason(complete, count, hidden, residual);
                    const residualSum = rows.filter((row) => hidden.includes(String(row.department_id)))
                        .reduce((sum, row) => sum + Number(row[`${key}Sum`]), 0);
                    // A bounded mean at 0 or 10 would reveal every hidden
                    // contributor's answer, even across multiple departments.
                    if (!reason && hidden.length && (residualSum <= 0 || residualSum >= 10 * residual)) reason = "protected_constituent";
                    metricAvailability[key] = reason;
                    const sum = rows.reduce((total, row) => total + Number(row[`${key}Sum`]), 0);
                    return [key, reason ? null : scoreDecimal(sum / count)];
                }));
                // Derive from the unrounded pressure mean, as in other scopes.
                const workloadCount = rows.reduce((sum, row) => sum + Number(row.workloadCount), 0);
                scores.workloadBalance = metricAvailability.workload ? null : scoreDecimal(10 - rows.reduce((sum, row) => sum + Number(row.workloadSum), 0) / workloadCount);
                metricAvailability.workloadBalance = metricAvailability.workload;
                const anyScore = Object.values(scores).some(Number.isFinite);
                return { weekStart: date, available: anyScore || participation.available,
                    ...(!anyScore && !participation.available ? { reason: "insufficient_responses" } : {}),
                    responseCount: participation.available ? rows.reduce((sum, row) => sum + Number(row.responses), 0) : null,
                    participation: participation.value, ...participationMetadata(participation),
                    scores: anyScore || participation.available ? scores : null, metricAvailability,
                    // Retain the existing weekly challenge release policy. The
                    // eight-week themes below are evaluated independently.
                    challenges: cohortReleaseSafe(rows, expectedTeams) ? releaseChallenges(rows, true) : [] };
            }
            // A small/missing leaf is NOT silently excluded from a larger group.
            // Withhold that entire rollup, preventing subtraction of a published
            // total and its visible subgroups to reconstruct the hidden team.
            if (!cohortReleaseSafe(rows, expectedTeams))
                return { weekStart: date, ...unavailable("insufficient_responses"), ...participationMetadata(participation),
                    ...(!manager && rows.length > 0 ? { metricAvailability: {
                        ...Object.fromEntries([...dimensions.map(([key]) => key), "workloadBalance"].map((key) => [key, "insufficient_responses"])),
                        ...(historicalHrStress ? { stress: "not_measured_historically" } : {})
                    } } : {}) };
            const count = rows.reduce((sum, row) => sum + Number(row.responses), 0);
            const metricAvailability = {};
            const averages = Object.fromEntries(dimensions.map(([key]) => {
                // Every constituent must independently meet this metric's k.
                // Missing stress must not suppress the four historical measures.
                const safe = rows.every((row) => Number(row[`${key}Count`]) >= minimum);
                metricAvailability[key] = safe ? null : rows.every((row) => Number(row[`${key}Count`]) === 0)
                    ? "not_measured_historically" : "insufficient_responses";
                const sum = rows.reduce((total, row) => total + Number(row[`${key}Sum`]), 0);
                const answered = rows.reduce((total, row) => total + Number(row[`${key}Count`]), 0);
                return [key, safe ? sum / answered : null];
            }));
            const scores = Object.fromEntries(Object.entries(averages).map(([key, value]) => [key, value === null ? null : scoreDecimal(value)]));
            // Workload Balance is a derived presentation value, never stored.
            scores.workloadBalance = averages.workload === null ? null : scoreDecimal(10 - averages.workload);
            metricAvailability.workloadBalance = metricAvailability.workload;
            return { weekStart: date, available: true, responseCount: count,
                participation: participation.value, ...participationMetadata(participation), scores, metricAvailability,
                challenges: releaseChallenges(rows, true) };
        }
        function series(rows, expectedTeams, departments = null) {
            const weeks = calendar.map(({ week_start }) => {
                const expected = typeof expectedTeams === "function" ? expectedTeams(week_start) : expectedTeams;
                return expected?.length ? release(rows.filter((row) => row.week_start === week_start), expected, week_start, departments)
                    : { weekStart: week_start, ...unavailable("insufficient_responses"),
                        ...participationMetadata({ available: false, reason: "insufficient_responses" }) };
            });
            const latest = weeks.at(-1) ?? unavailable("no_data");
            // Monthly deltas use only released weeks. Thus the delta cannot leak
            // a suppressed week. Weight by answered responses, not team means.
            const monthlyChange = latest.available ? Object.fromEntries([...dimensions.map(([key]) => key), "workloadBalance"].map((key) => {
                const month = latest.weekStart.slice(0, 7);
                const date = new Date(`${month}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth() - 1);
                const previous = date.toISOString().slice(0, 7);
                // Each metric has its own released dates. Never derive a delta
                // from a hidden metric/week or replace an unavailable latest one.
                if (!Number.isFinite(latest.scores?.[key])) return [key, null];
                const safeDates = new Set(weeks.filter((week) => week.available && Number.isFinite(week.scores?.[key])).map((week) => week.weekStart));
                const average = (prefix) => {
                    const safe = rows.filter((row) => safeDates.has(row.week_start) && row.week_start.startsWith(prefix));
                    const field = key === "workloadBalance" ? "workload" : key;
                    const count = safe.reduce((sum, row) => sum + Number(row[`${field}Count`]), 0);
                    const value = count ? safe.reduce((sum, row) => sum + Number(row[`${field}Sum`]), 0) / count : null;
                    return value === null ? null : key === "workloadBalance" ? 10 - value : value;
                };
                const before = average(previous), after = average(month);
                return [key, before === null || after === null ? null : scoreDecimal(after - before)];
            })) : null;
            // Reuse the fixed reporting calendar, authorization and historical
            // department snapshots. Weekly sample sizes do NOT veto period
            // themes. Missing/unfinalized snapshots still fail closed.
            const windowRows = [];
            let complete = calendar.length > 0;
            for (const { week_start } of calendar) {
                const expected = typeof expectedTeams === "function" ? expectedTeams(week_start) : expectedTeams;
                const present = rows.filter((row) => row.week_start === week_start);
                complete &&= expected !== null && expected !== undefined && present.length === expected.length
                    && present.every((row) => expected.map(String).includes(String(row.team_id)));
                windowRows.push(...present);
            }
            const startWeek = calendar[0]?.week_start ?? null, endWeek = calendar.at(-1)?.week_start ?? null;
            const end = endWeek ? new Date(`${endWeek}T12:00:00Z`) : null;
            if (end) end.setUTCDate(end.getUTCDate() + 6);
            const sharedThemes = { ...(departments ? { available: false, factors: [] } : recentThemes(windowRows, complete)),
                startWeek, endWeek, endDate: end?.toISOString().slice(0, 10) ?? null };
            return { ...latest, monthlyChange, weeks, sharedThemes };
        }
        if (manager) {
            // Team identifiers scope action-plan links; never employee identifiers.
            const released = teams.map((team) => ({ teamId: String(team.team_id), name: team.name, departmentName: team.department_name,
                ...series(cohorts.filter((row) => String(row.team_id) === String(team.team_id)), [team.team_id]) }));
            return { ...base, available: released.some((team) => team.available), teams: released };
        }
        // Department membership is taken from EACH historical team_week, never
        // from a team's current department. Only fixed department rollups exist.
        const departmentIds = [...new Set([...departmentCatalogue.map((d) => String(d.department_id)),
            ...teams.map((t) => String(t.department_id)), ...cohorts.map((c) => String(c.department_id))])];
        const departments = departmentIds.map((id) => {
            const rows = cohorts.filter((row) => String(row.department_id) === id);
            // Resolve membership separately for every historical week, including
            // transfers. A SMALL sibling department never gates this release.
            // A MISSING snapshot still makes membership unknown: fail closed
            // rather than infer history from the team's current department.
            const expected = (date) => {
                const snapshots = cohorts.filter((c) => c.week_start === date);
                return snapshots.length === teams.length
                    ? snapshots.filter((c) => String(c.department_id) === id).map((c) => c.team_id) : null;
            };
            const name = departmentCatalogue.find((d) => String(d.department_id) === id)?.name
                ?? rows[0]?.department_name ?? teams.find((t) => String(t.department_id) === id)?.department_name;
            // Department trends/deltas/themes are released independently from
            // the organization, under the SAME leaf and metric privacy checks.
            return { departmentId: id, name, ...series(rows, expected) };
        });
        const organization = series(cohorts, ids, departments);
        // Themes use their own eight-week population, not latest.available or
        // the score-card release. Resolve the hidden residual separately for
        // EVERY factor, since different department factors are already public.
        const completePeriod = calendar.length > 0 && calendar.every(({ week_start }) =>
            completeOrganization(cohorts.filter((row) => row.week_start === week_start), ids));
        const requests = currentFactors.map((code) => ({ code, hidden_departments: departments.filter((department) => {
            if (!cohorts.some((row) => String(row.department_id) === department.departmentId && calendar.some((week) => week.week_start === row.week_start))) return false;
            const factor = department.sharedThemes.factors.find((item) => item.code === code);
            return !Number.isFinite(factor?.percentage) && factor?.reason !== "not_measured_historically";
        }).map((department) => department.departmentId) }));
        // Count DISTINCT contributors in PostgreSQL across teams/transfers and
        // weeks. Neither identifiers nor these internal residual counts leave
        // this service. Unasked answers never count as negative selections.
        const { rows: organizationFactors } = completePeriod ? await getPool().query(`/* reporting:organization-themes */ SELECT q.code,
            COUNT(r.response_id) FILTER (WHERE NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AS measured,
            COUNT(rc.response_id) FILTER (WHERE NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AS selected,
            COUNT(DISTINCT c.user_id) FILTER (WHERE NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AS participants,
            COUNT(DISTINCT c.user_id) FILTER (WHERE (NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AND rc.response_id IS NOT NULL) AS selecting_participants,
            COUNT(DISTINCT c.user_id) FILTER (WHERE (NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AND rc.response_id IS NULL) AS nonselecting_participants,
            COUNT(r.response_id) FILTER (WHERE tw.department_id = ANY(q.hidden_departments) AND (NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL)) AS residual_measured,
            COUNT(rc.response_id) FILTER (WHERE tw.department_id = ANY(q.hidden_departments) AND (NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL)) AS residual_selected,
            COUNT(DISTINCT c.user_id) FILTER (WHERE tw.department_id = ANY(q.hidden_departments) AND (NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL)) AS residual_participants,
            COUNT(DISTINCT c.user_id) FILTER (WHERE tw.department_id = ANY(q.hidden_departments) AND (NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AND rc.response_id IS NOT NULL) AS residual_selecting_participants,
            COUNT(DISTINCT c.user_id) FILTER (WHERE tw.department_id = ANY(q.hidden_departments) AND (NOT (q.code = ANY($3::text[])) OR r.stress_score IS NOT NULL) AND rc.response_id IS NULL) AS residual_nonselecting_participants
            FROM jsonb_to_recordset($5::jsonb) AS q(code text, hidden_departments bigint[])
            JOIN wellbeing.challenge_factors f ON f.code = q.code
            JOIN wellbeing.team_weeks tw ON tw.team_id = ANY($1::bigint[]) AND tw.finalized_at IS NOT NULL AND tw.week_start = ANY($4::date[])
            JOIN private.employee_weekly_checkins c ON c.team_id = tw.team_id AND c.week_start = tw.week_start AND c.response_id IS NOT NULL
            JOIN wellbeing.wellbeing_responses r ON r.response_id = c.response_id AND r.team_id = tw.team_id AND r.week_start = tw.week_start
            LEFT JOIN wellbeing.response_challenges rc ON rc.response_id = r.response_id AND rc.challenge_factor_id = f.challenge_factor_id
            WHERE q.code = ANY($2::text[]) GROUP BY q.code`,
        [ids, currentFactors, newFactors, calendar.map((week) => week.week_start), JSON.stringify(requests)]) : { rows: [] };
        const themeFactors = currentFactors.map((code) => {
            const row = organizationFactors.find((item) => item.code === code);
            const hidden = requests.find((item) => item.code === code).hidden_departments;
            const valid = row && ["measured", "selected", "participants", "selecting_participants", "nonselecting_participants",
                "residual_measured", "residual_selected", "residual_participants", "residual_selecting_participants", "residual_nonselecting_participants"]
                .every((key) => Number.isInteger(Number(row[key])) && Number(row[key]) >= 0);
            let reason = !completePeriod || !valid ? "insufficient_responses" : Number(row.measured) === 0 ? "not_measured_historically"
                : organizationReason(true, Number(row.participants), hidden, Number(row.residual_participants));
            const sidesSafe = (prefix = "") => selectionSafe(Number(row[`${prefix}selected`]), Number(row[`${prefix}measured`]))
                && Number(row[`${prefix}selecting_participants`]) >= minimum && Number(row[`${prefix}nonselecting_participants`]) >= minimum;
            if (!reason && !sidesSafe()) reason = "insufficient_responses";
            if (!reason && hidden.length && !sidesSafe("residual_")) reason = "protected_constituent";
            return { code, label: periodFactors.find((item) => item.code === code)?.label ?? code,
                percentage: reason ? null : Math.round(Number(row.selected) / Number(row.measured) * 100), reason };
        });
        organization.sharedThemes = { ...organization.sharedThemes, available: themeFactors.some((factor) => factor.reason === null),
            factors: themeFactors, privacyBasis: "organization_with_complementary_suppression" };
        return { ...base, ...organization, departments };
    }
    return { prototypeAccount, overview };
}
module.exports = { createReporting, configuredMinimum };

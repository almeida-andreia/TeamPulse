const { createReporting } = require("./reporting");
const canonical = import("../public/js/actions.mjs");
const problem = (status, message) => Object.assign(new Error(message), { status });
const identifier = (value) => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;

function createTeamActions(getPool, { minimumResponses = () => process.env.MIN_RESPONSES } = {}) {
    const select = `/* actions:rows */ SELECT a.team_action_id, a.team_id, t.name AS team_name,
        a.title, a.description, a.insight_topic, owner.role AS owner_role,
        to_char(a.deadline, 'YYYY-MM-DD') AS target_date, a.status
        FROM operations.team_actions a JOIN identity.teams t USING (team_id)
        JOIN identity.users owner ON owner.user_id = a.owner_user_id
        WHERE t.manager_user_id = $1`;
    const dto = (row, areas) => ({ id: String(row.team_action_id), teamId: String(row.team_id), teamName: row.team_name,
        title: row.title, description: row.description, area: areas.find((a) => a.topic === row.insight_topic)?.key ?? "legacy",
        areaLabel: areas.find((a) => a.topic === row.insight_topic)?.label
            ?? (row.insight_topic === "stress" ? "Stress (existing plan)" : "Team challenge (existing plan)"),
        owner: row.owner_role === "manager" ? "Team Manager" : "Team owner",
        targetDate: row.target_date, status: row.status });
    async function list(managerId) {
        const { ACTION_AREAS } = await canonical;
        const { rows: teams } = await getPool().query(`/* actions:teams */ SELECT team_id, name
            FROM identity.teams WHERE manager_user_id = $1 ORDER BY team_id`, [managerId]);
        const { rows } = await getPool().query(`${select} ORDER BY a.deadline, a.team_action_id`, [managerId]);
        return { source: "postgres", teams: teams.map((t) => ({ id: String(t.team_id), name: t.name })),
            actions: rows.map((r) => dto(r, ACTION_AREAS)) };
    }
    async function transaction(work) {
        const client = await getPool().connect();
        let begun = false, discard;
        try { await client.query("BEGIN"); begun = true; const result = await work(client); await client.query("COMMIT"); begun = false; return result; }
        catch (error) { if (begun) { try { await client.query("ROLLBACK"); } catch (failure) { discard = failure; } } throw error; }
        finally { client.release(discard); }
    }
    async function create(managerId, input) {
        const { validateAction, ACTION_AREAS } = await canonical;
        const action = validateAction(input);
        if (!identifier(action.teamId)) throw problem(400, "Choose a valid team.");
        return transaction(async (client) => {
            // Lock authorization through COMMIT. The form cannot choose an
            // employee/owner identity or create an action for another team.
            const { rows: teams } = await client.query(`/* actions:authorize */ SELECT t.team_id FROM identity.teams t
                JOIN identity.users u ON u.user_id = t.manager_user_id
                WHERE t.team_id = $2 AND t.manager_user_id = $1 AND u.role = 'manager' AND u.is_active
                FOR SHARE OF t, u`, [managerId, action.teamId]);
            if (!teams.length) throw problem(403, "This team is not available to your role.");
            if (action.sourceWeek) {
                // Reuse the existing release/delta rules, inside this transaction.
                // Never trust a browser's claim that an insight was available.
                const reporting = createReporting(() => client, { minimumResponses });
                const report = await reporting.overview("manager", managerId);
                const team = report.teams.find((t) => t.teamId === action.teamId);
                if (!team?.available || team.weekStart !== action.sourceWeek
                    || !Number.isFinite(team.scores?.[action.area])
                    || !Number.isFinite(team.monthlyChange?.[action.area]) || team.monthlyChange[action.area] >= 0)
                    throw problem(409, "This aggregate insight is no longer available. You can create a general team action instead.");
            }
            const { rows: [saved] } = await client.query(`/* actions:create */ INSERT INTO operations.team_actions
                (team_id, insight_week_start, insight_topic, title, description, owner_user_id, deadline, status, created_by_user_id)
                VALUES ($2, $3, $4, $5, $6, $1, $7, $8, $1) RETURNING team_action_id`,
            [managerId, action.teamId, action.sourceWeek ?? null, ACTION_AREAS.find((a) => a.key === action.area).topic,
                action.title, action.description, action.targetDate, action.status]);
            const { rows: [row] } = await client.query(`${select} AND a.team_action_id = $2`, [managerId, saved.team_action_id]);
            return dto(row, ACTION_AREAS);
        });
    }
    async function updateStatus(managerId, id, input) {
        const { ACTION_STATUSES } = await canonical;
        if (!identifier(id) || !input || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).length !== 1 || !ACTION_STATUSES.some((s) => s.key === input.status))
            throw problem(400, "Choose a valid action and status.");
        return transaction(async (client) => {
            const { rows } = await client.query(`/* actions:lock */ SELECT a.team_action_id FROM operations.team_actions a
                JOIN identity.teams t USING (team_id) JOIN identity.users u ON u.user_id = t.manager_user_id
                WHERE a.team_action_id = $2 AND t.manager_user_id = $1 AND u.role = 'manager' AND u.is_active
                FOR UPDATE OF a FOR SHARE OF t, u`, [managerId, id]);
            if (!rows.length) throw problem(404, "This action plan is unavailable.");
            await client.query(`/* actions:status */ UPDATE operations.team_actions SET status = $2 WHERE team_action_id = $1`, [id, input.status]);
            const { ACTION_AREAS } = await canonical;
            const { rows: [row] } = await client.query(`${select} AND a.team_action_id = $2`, [managerId, id]);
            return dto(row, ACTION_AREAS);
        });
    }
    return { list, create, updateStatus };
}
module.exports = { createTeamActions };

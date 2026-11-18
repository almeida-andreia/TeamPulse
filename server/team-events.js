// Team context only. Events never participate in score/insight calculations.
const problem = (status, message) => Object.assign(new Error(message), { status });
const id = (value) => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
const projection = `e.team_event_id, e.team_id, e.title,
    to_char(e.event_date, 'YYYY-MM-DD') AS event_date,
    to_char(date_trunc('week', e.event_date::timestamp), 'YYYY-MM-DD') AS week_start`;
const dto = (row) => ({ id: String(row.team_event_id), teamId: String(row.team_id),
    title: row.title, date: row.event_date, weekStart: row.week_start });
function createTeamEvents(getPool) {
    async function list(managerId) {
        const { rows } = await getPool().query(`/* team-events:list */ SELECT ${projection}
            FROM operations.team_events e JOIN identity.teams t USING (team_id)
            WHERE t.manager_user_id=$1
                AND e.event_date >= date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date-56
                AND e.event_date < date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date
            ORDER BY e.event_date,e.team_event_id`, [managerId]);
        return rows.map(dto);
    }
    async function create(managerId, input) {
        if (!input || typeof input !== "object" || Array.isArray(input)
            || Object.keys(input).some((key) => !["teamId", "title", "date"].includes(key))
            || !id(input.teamId) || typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 160
            || typeof input.date !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(input.date)
            || Number.isNaN(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0, 10) !== input.date)
            throw problem(400, "Provide a team, a valid date and an event title of up to 160 characters.");
        // One statement checks and locks authorization, then stores the event.
        // Creator identity comes from the session and never appears in the DTO.
        const { rows } = await getPool().query(`/* team-events:create */ WITH authorized AS (
            SELECT t.team_id FROM identity.teams t JOIN identity.users u ON u.user_id=t.manager_user_id
            WHERE t.team_id=$2 AND t.manager_user_id=$1 AND u.role='manager' AND u.is_active FOR SHARE OF t,u
        ), saved AS (
            INSERT INTO operations.team_events(team_id,event_date,title,created_by_user_id)
            SELECT team_id,$3::date,$4,$1 FROM authorized RETURNING *
        ) SELECT ${projection} FROM saved e`, [managerId, input.teamId, input.date, input.title.trim()]);
        if (!rows.length) throw problem(403, "This team is not available to your role.");
        return dto(rows[0]);
    }
    return { list, create };
}
module.exports = { createTeamEvents };

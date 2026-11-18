const { createEmployeeCheckins } = require("./employee-checkins");
const canonical = import("../public/js/hr-activities.mjs");
const problem = (status, message) => Object.assign(new Error(message), { status });
function createActivitySupport(getPool) {
    const accounts = createEmployeeCheckins(getPool);
    // Employee availability is a query filter, never deletion of HR history or registrations.
    const visible = `a.published_at IS NOT NULL AND a.published_at <= CURRENT_TIMESTAMP
        AND a.starts_at > CURRENT_TIMESTAMP
        AND (a.department_id IS NULL OR a.target_audience = 'All employees' OR a.department_id = (
            SELECT t.department_id FROM identity.users u JOIN identity.teams t USING (team_id) WHERE u.user_id=$1))`;
    async function list(userId) {
        const { activityTypeLabel } = await canonical;
        // Never SELECT the HR source, creator, private answers or other attendees.
        const { rows } = await getPool().query(`/* activity-support:list */ SELECT a.activity_id,a.title,a.description,a.activity_type,
            a.starts_at,a.duration_minutes,a.format,a.target_audience,a.is_featured,
            CASE WHEN a.starts_at > CURRENT_TIMESTAMP THEN 'upcoming'
                WHEN a.starts_at + a.duration_minutes * interval '1 minute' > CURRENT_TIMESTAMP THEN 'in_progress'
                ELSE 'completed' END AS activity_status,
            a.starts_at > CURRENT_TIMESTAMP AS registration_open,
            EXISTS (SELECT 1 FROM private.activity_registrations r WHERE r.activity_id=a.activity_id AND r.user_id=$1) AS registered
            FROM operations.activities a WHERE ${visible} ORDER BY a.starts_at,a.activity_id`, [userId]);
        return rows.map((a) => ({ id: String(a.activity_id), title: a.title, description: a.description, type: activityTypeLabel(a.activity_type),
            startsAt: new Date(a.starts_at).toISOString(), duration: a.duration_minutes, format: a.format === "online" ? "Online" : "In person",
            audience: a.target_audience, featured: a.is_featured, registered: a.registered,
            status: a.activity_status, registrationOpen: a.registration_open, recommended: false, demo: false }));
    }
    async function register(userId, id, body) {
        const { validId } = await canonical;
        if (!validId(id) || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
            throw problem(400, "Choose an activity without additional registration fields.");
        const client = await getPool().connect(); let begun = false, discard;
        try {
            await client.query("BEGIN"); begun = true;
            await accounts.employee(userId, client, true);
            const { rows } = await client.query(`/* activity-support:available */ SELECT a.activity_id FROM operations.activities a
                WHERE ${visible} AND a.activity_id=$2 FOR SHARE OF a`, [userId, id]);
            if (!rows.length) throw problem(409, "This activity is no longer available for registration.");
            // The existing composite primary key serializes concurrent requests.
            // A conflict preserves the original row and returns 409, not fake success.
            const { rowCount } = await client.query(`/* activity-support:register */ INSERT INTO private.activity_registrations(activity_id,user_id)
                VALUES ($2,$1) ON CONFLICT (activity_id,user_id) DO NOTHING RETURNING activity_id`, [userId, id]);
            if (!rowCount) throw problem(409, "You are already registered for this activity.");
            await client.query("COMMIT"); begun = false; return { activityId: id, registered: true };
        } catch (error) { if (begun) { try { await client.query("ROLLBACK"); } catch (failure) { discard = failure; } } throw error; }
        finally { client.release(discard); }
    }
    async function cancel(userId, id, body) {
        const { validId } = await canonical;
        if (!validId(id) || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
            throw problem(400, "Choose a registration without additional fields.");
        const client = await getPool().connect(); let begun = false, discard;
        try {
            await client.query("BEGIN"); begun = true;
            await accounts.employee(userId, client, true);
            // Lock the schedule while cancelling. Expired registrations remain
            // historical; only the session owner's upcoming registration can go.
            const { rows } = await client.query(`/* activity-support:cancel-available */ SELECT activity_id FROM operations.activities
                WHERE activity_id=$1 AND starts_at>clock_timestamp() FOR SHARE`, [id]);
            if (!rows.length) throw problem(409, "This registration can no longer be cancelled.");
            const { rowCount } = await client.query(`/* activity-support:cancel */ DELETE FROM private.activity_registrations
                WHERE user_id=$1 AND activity_id=$2
                AND EXISTS (SELECT 1 FROM operations.activities a WHERE a.activity_id=$2 AND a.starts_at>clock_timestamp())
                RETURNING activity_id`, [userId, id]);
            if (!rowCount) throw problem(409, "You are not registered for this activity.");
            await client.query("COMMIT"); begun = false;
            return { activityId: id, registered: false };
        } catch (error) { if (begun) { try { await client.query("ROLLBACK"); } catch (failure) { discard = failure; } } throw error; }
        finally { client.release(discard); }
    }
    return { list, register, cancel };
}
module.exports = { createActivitySupport };

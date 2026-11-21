const { createReporting } = require("./reporting");
const canonical = import("../public/js/hr-activities.mjs");
const problem = (status, message) => Object.assign(new Error(message), { status });

function createHrActivities(getPool, { minimumResponses = () => process.env.MIN_RESPONSES } = {}) {
    // One organization in this MVP. Active HR manages its real catalogue;
    // there is no caller-controlled organization or employee scope.
    const select = `/* hr-activities:rows */ SELECT a.*, d.name AS department_name,
        to_char(a.source_week_start, 'YYYY-MM-DD') AS source_week,
        (SELECT count(*) FROM private.activity_registrations r WHERE r.activity_id=a.activity_id) AS registration_count,
        a.published_at IS NOT NULL AND a.published_at <= CURRENT_TIMESTAMP
            AND a.starts_at > CURRENT_TIMESTAMP AS registration_open,
        CASE WHEN a.published_at IS NULL THEN 'draft'
            WHEN a.starts_at > CURRENT_TIMESTAMP THEN 'upcoming'
            WHEN a.starts_at + a.duration_minutes * interval '1 minute' > CURRENT_TIMESTAMP THEN 'in_progress'
            ELSE 'completed' END AS activity_status
        FROM operations.activities a LEFT JOIN identity.departments d USING (department_id)`;
    const dto = (a) => ({ id: String(a.activity_id), title: a.title, description: a.description, type: a.activity_type,
        departmentId: a.department_id === null ? null : String(a.department_id), departmentName: a.department_name,
        area: a.related_area, startsAt: new Date(a.starts_at).toISOString(), duration: a.duration_minutes, format: a.format,
        targetAudience: a.target_audience, audience: a.target_audience === "All employees" ? "all_employees"
            : a.department_name && a.target_audience === a.department_name ? "department" : "existing",
        publication: a.published_at === null ? "draft" : "published", status: a.activity_status,
        // Operational attendance totals only: no attendee identities or wellbeing joins.
        registrationCount: Number(a.registration_count), registrationOpen: a.registration_open,
        createdAt: new Date(a.created_at).toISOString(),
        source: a.source_week ? { week: a.source_week, value: Number(a.source_value), change: Number(a.source_change) } : null });
    async function insights(db, hrId) {
        const { safeActivityInsights } = await canonical;
        return safeActivityInsights(await createReporting(() => db, { minimumResponses }).overview("hr", hrId));
    }
    async function list(hrId) {
        const db = getPool();
        const { rows: departments } = await db.query(`/* hr-activities:departments */ SELECT department_id, name FROM identity.departments ORDER BY department_id`);
        const { rows } = await db.query(`${select} ORDER BY a.starts_at DESC, a.activity_id DESC`);
        return { source: "postgres", departments: departments.map((d) => ({ id: String(d.department_id), name: d.name })),
            insights: await insights(db, hrId), activities: rows.map(dto) };
    }
    async function transaction(hrId, work) {
        const client = await getPool().connect(); let begun = false, discard;
        try {
            await client.query("BEGIN"); begun = true;
            const { rows } = await client.query(`/* hr-activities:authorize */ SELECT user_id FROM identity.users
                WHERE user_id=$1 AND role='hr' AND is_active FOR SHARE`, [hrId]);
            if (!rows.length) throw problem(403, "Activity management is available only to HR.");
            const result = await work(client); await client.query("COMMIT"); begun = false; return result;
        } catch (error) { if (begun) { try { await client.query("ROLLBACK"); } catch (failure) { discard = failure; } } throw error; }
        finally { client.release(discard); }
    }
    async function save(hrId, input, id) {
        const { validateActivity, validId } = await canonical;
        const activity = validateActivity(input);
        if (id !== undefined && !validId(id)) throw problem(400, "Choose a valid activity.");
        return transaction(hrId, async (client) => {
            const existing = id ? (await client.query(`${select} WHERE a.activity_id=$1 FOR UPDATE OF a`, [id])).rows[0] : null;
            if (id && !existing) throw problem(404, "This activity is unavailable.");
            if (!id && (activity.area === null || activity.audience === "existing")) throw problem(400, "Choose a related area and target audience.");
            const { rows: departments } = activity.departmentId === null ? { rows: [] } : await client.query(`/* hr-activities:department */
                SELECT department_id, name FROM identity.departments WHERE department_id=$1 FOR SHARE`, [activity.departmentId]);
            if (activity.departmentId !== null && !departments.length) throw problem(400, "Choose an existing department.");
            let source = null;
            if (existing) {
                // Editing does not reassign an established source, or invent one
                // for an existing general activity. Preserve legacy NULL fields.
                if ((existing.source_week ?? undefined) !== activity.sourceWeek || (existing.source_week &&
                    (String(existing.department_id) !== activity.departmentId || existing.related_area !== activity.area)))
                    throw problem(409, "An activity's saved aggregate source cannot be reassigned.");
            } else if (activity.sourceWeek) {
                source = (await insights(client, hrId)).find((i) => i.departmentId === activity.departmentId && i.area === activity.area && i.sourceWeek === activity.sourceWeek);
                if (!source) throw problem(409, "This aggregate insight is unavailable. You can create a general wellbeing activity instead.");
            }
            // Reuse starts_at/publication rather than adding target dates or a
            // second action-status system. Publishing past draft events is closed.
            const { rows: [clock] } = await client.query("/* hr-activities:clock */ SELECT CURRENT_TIMESTAMP AS now");
            if (new Date(activity.startsAt) <= new Date(clock.now)
                && (!existing || activity.startsAt !== new Date(existing.starts_at).toISOString() || existing.published_at === null && activity.publication === "published"))
                throw problem(400, "Choose a future activity date and time.");
            const audience = activity.audience === "existing" ? existing.target_audience
                : activity.audience === "department" ? departments[0].name : "All employees";
            const params = [activity.title, activity.description, activity.type, activity.startsAt, activity.duration, activity.format,
                audience, activity.departmentId, activity.area, activity.publication];
            let savedId = id;
            if (existing) await client.query(`/* hr-activities:update */ UPDATE operations.activities SET title=$1,description=$2,activity_type=$3,
                starts_at=$4,duration_minutes=$5,format=$6,target_audience=$7,department_id=$8,related_area=$9,
                published_at=CASE WHEN $10='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE NULL END
                WHERE activity_id=$11`, [...params, id]);
            else {
                const { rows: [saved] } = await client.query(`/* hr-activities:create */ INSERT INTO operations.activities
                    (title,description,activity_type,starts_at,duration_minutes,format,target_audience,department_id,related_area,published_at,
                        source_week_start,source_value,source_change,created_by_user_id)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10='published' THEN CURRENT_TIMESTAMP ELSE NULL END,$11,$12,$13,$14) RETURNING activity_id`,
                [...params, source?.sourceWeek ?? null, source?.value ?? null, source?.change ?? null, hrId]);
                savedId = saved.activity_id;
            }
            const { rows: [row] } = await client.query(`${select} WHERE a.activity_id=$1`, [savedId]); return dto(row);
        });
    }
    return { list, create: (id, input) => save(id, input), update: (id, activityId, input) => save(id, input, activityId) };
}
module.exports = { createHrActivities };

const { createEmployeeCheckins } = require("./employee-checkins");
const canonical = import("../public/js/hr-activities.mjs");
const problem = (status, message) => Object.assign(new Error(message), { status });
const bookingId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
// PostgreSQL booking and management share one confidential source of truth.
// No browser-demo records are imported or used as fallback.
// Ownership is resolved from the protected Employee session by the router.
function createEmployeeAppointments(getPool) {
    const accounts = createEmployeeCheckins(getPool);
    async function upcoming(userId) {
        const { rows } = await getPool().query(`/* employee-appointments:upcoming */
            SELECT b.booking_id,s.starts_at,s.format,s.location
            FROM private.psychologist_bookings b
            JOIN operations.psychologist_slots s USING (slot_id)
            WHERE b.user_id=$1 AND b.status='booked' AND s.starts_at > CURRENT_TIMESTAMP
            ORDER BY s.starts_at,b.booking_id`, [userId]);
        // Do not return clinician identities, video links or booking reasons.
        return rows.map((row) => ({ id: row.booking_id, startsAt: new Date(row.starts_at).toISOString(),
            format: row.format === "online" ? "Online" : "In person", location: row.location,
            status: "booked" }));
    }
    async function slots() {
        const { rows } = await getPool().query(`/* employee-appointments:slots */ SELECT s.slot_id,s.starts_at,s.ends_at,s.format,s.location
            FROM operations.psychologist_slots s WHERE s.starts_at>clock_timestamp()
            AND NOT EXISTS (SELECT 1 FROM private.psychologist_bookings b WHERE b.slot_id=s.slot_id AND b.status='booked')
            ORDER BY s.starts_at,s.slot_id`);
        return rows.map((s) => ({ id: String(s.slot_id), startsAt: new Date(s.starts_at).toISOString(),
            duration: (new Date(s.ends_at) - new Date(s.starts_at)) / 60000,
            format: s.format === "online" ? "Online" : "In person", location: s.location }));
    }
    const details = (row) => ({ id: row.booking_id, slotId: String(row.slot_id), psychologist: row.display_name,
        startsAt: new Date(row.starts_at).toISOString(), duration: (new Date(row.ends_at) - new Date(row.starts_at)) / 60000,
        format: row.format === "online" ? "Online" : "In person", location: row.location,
        videoUrl: row.video_url, status: row.status, canChange: row.can_change, demo: false });
    async function bookings(userId, client = getPool()) {
        const { rows } = await client.query(`/* employee-appointments:bookings */
            SELECT b.booking_id,b.slot_id,b.status,s.starts_at,s.ends_at,s.format,s.location,s.video_url,p.display_name,
                b.status='booked' AND clock_timestamp() <= s.starts_at-interval '2 hours' AS can_change
            FROM private.psychologist_bookings b JOIN operations.psychologist_slots s USING(slot_id)
            JOIN operations.psychologists p USING(psychologist_id)
            WHERE b.user_id=$1 ORDER BY s.starts_at,b.booking_id`, [userId]);
        // Confirmation/video links are returned only to the session owner.
        return rows.map(details);
    }
    async function sessions() {
        const { rows } = await getPool().query(`/* employee-appointments:sessions */
            SELECT s.slot_id,s.starts_at,s.ends_at,s.format,s.location,p.display_name
            FROM operations.psychologist_slots s JOIN operations.psychologists p USING(psychologist_id)
            WHERE s.starts_at>clock_timestamp() AND NOT EXISTS
                (SELECT 1 FROM private.psychologist_bookings b WHERE b.slot_id=s.slot_id AND b.status='booked')
            ORDER BY s.starts_at,s.slot_id`);
        // Availability never includes booking owners or private video links.
        return rows.map((s) => ({ id: String(s.slot_id), psychologist: s.display_name,
            startsAt: new Date(s.starts_at).toISOString(), duration: (new Date(s.ends_at) - new Date(s.starts_at)) / 60000,
            format: s.format === "online" ? "Online" : "In person", location: s.location, available: true }));
    }
    async function book(userId, body) {
        const { validId } = await canonical;
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !validId(body.slotId))
            throw problem(400, "Choose an available slot without additional fields.");
        const client = await getPool().connect(); let begun = false, discard;
        try {
            await client.query("BEGIN"); begun = true;
            await accounts.employee(userId, client, true);
            const { rows } = await client.query(`/* employee-appointments:book-available */
                SELECT s.slot_id FROM operations.psychologist_slots s WHERE s.slot_id=$1 AND s.starts_at>clock_timestamp()
                AND NOT EXISTS (SELECT 1 FROM private.psychologist_bookings b WHERE b.slot_id=s.slot_id AND b.status='booked') FOR SHARE OF s`, [body.slotId]);
            if (!rows.length) throw problem(409, "That slot is no longer available. Please choose another.");
            const { rows: [saved] } = await client.query(`/* employee-appointments:book */
                INSERT INTO private.psychologist_bookings(user_id,slot_id) VALUES($1,$2) RETURNING booking_id`, [userId, body.slotId]);
            const booking = (await bookings(userId, client)).find((b) => b.id === saved.booking_id);
            await client.query("COMMIT"); begun = false; return booking;
        } catch (error) {
            if (begun) { try { await client.query("ROLLBACK"); } catch (failure) { discard = failure; } }
            if (["23505", "40P01", "40001", "P0001"].includes(error.code)) throw problem(409, "That slot is no longer available. Please choose another.");
            throw error;
        } finally { client.release(discard); }
    }
    async function change(userId, id, body, cancel = false) {
        const { validId } = await canonical;
        if (!bookingId(id) || !body || typeof body !== "object" || Array.isArray(body)
            || (cancel ? Object.keys(body).length !== 0 : Object.keys(body).length !== 1 || !validId(body.slotId)))
            throw problem(400, "Choose an appointment and a valid slot without additional fields.");
        const client = await getPool().connect(); let begun = false, discard;
        try {
            await client.query("BEGIN"); begun = true;
            await accounts.employee(userId, client, true);
            const { rows: [booking] } = await client.query(`/* employee-appointments:lock */ SELECT b.slot_id,b.status,
                clock_timestamp() <= s.starts_at-interval '2 hours' AS can_change
                FROM private.psychologist_bookings b JOIN operations.psychologist_slots s USING(slot_id)
                WHERE b.user_id=$1 AND b.booking_id=$2 FOR UPDATE OF b`, [userId, id]);
            if (!booking) throw problem(404, "This appointment is unavailable.");
            if (booking.status !== "booked") throw problem(409, "This appointment is no longer scheduled.");
            if (!booking.can_change) throw problem(409, "Changes require at least two hours before the appointment.");
            if (cancel) {
                // Preserve the booking ID, owner, original booking time and slot.
                await client.query(`/* employee-appointments:cancel */ UPDATE private.psychologist_bookings SET status='cancelled'
                    WHERE user_id=$1 AND booking_id=$2`, [userId, id]);
            } else {
                if (String(booking.slot_id) === body.slotId) throw problem(409, "Choose a different appointment slot.");
                const { rows } = await client.query(`/* employee-appointments:available */ SELECT s.slot_id FROM operations.psychologist_slots s
                    WHERE s.slot_id=$1 AND s.starts_at>clock_timestamp()
                    AND NOT EXISTS (SELECT 1 FROM private.psychologist_bookings b WHERE b.slot_id=s.slot_id AND b.status='booked') FOR SHARE OF s`, [body.slotId]);
                if (!rows.length) throw problem(409, "That slot is no longer available. Please choose another.");
                // Update the same booking; the existing partial unique index is
                // the final concurrency guard against two Employees taking a slot.
                await client.query(`/* employee-appointments:reschedule */ UPDATE private.psychologist_bookings SET slot_id=$3
                    WHERE user_id=$1 AND booking_id=$2`, [userId, id, body.slotId]);
            }
            await client.query("COMMIT"); begun = false;
            return { id, status: cancel ? "cancelled" : "booked" };
        } catch (error) {
            if (begun) { try { await client.query("ROLLBACK"); } catch (failure) { discard = failure; } }
            if (["23505", "40P01", "40001", "P0001"].includes(error.code))
                throw problem(409, "This appointment or slot has changed. Please refresh and try again.");
            throw error;
        } finally { client.release(discard); }
    }
    return { upcoming, slots, sessions, bookings, book, reschedule: (userId, id, body) => change(userId, id, body),
        cancel: (userId, id, body) => change(userId, id, body, true) };
}
module.exports = { createEmployeeAppointments };

const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");

test("PostgreSQL Employee registration and appointment management lifecycle (all changes rolled back)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1." : false }, async (t) => {
        const { pool } = require("../server/db"), client = await pool.connect();
        const { captureSnapshot } = require("../db/expand-demo.cjs");
        const before = await captureSnapshot(client);
        let sequence = 0, race = false;
        try {
            await client.query("BEGIN");
            const query = (sql, args) => {
                if (race && sql.includes("employee-appointments:reschedule")) throw Object.assign(new Error("private race diagnostic"), { code: "23505" });
                return client.query(sql, args);
            };
            const nested = { query, async connect() { const name = `manage_${++sequence}`; return { async query(sql, args) {
                if (sql === "BEGIN") return client.query(`SAVEPOINT ${name}`);
                if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT ${name}`);
                if (sql === "ROLLBACK") { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); return client.query(`RELEASE SAVEPOINT ${name}`); }
                return query(sql, args);
            }, release() {} }; } };
            const options = { getPool: () => nested, minimumResponses: 5, prototypeAccess: true, sessionSecret: "employee-management-tests" };
            const app = createApp(options), employee = request.agent(app), hr = request.agent(app), manager = request.agent(app);
            await employee.post("/api/prototype/employee-session").send({}).expect(204);
            await hr.post("/api/prototype/hr-session").send({}).expect(204);
            await manager.post("/api/prototype/manager-session").send({}).expect(204);
            const users = (await client.query("SELECT user_id,sso_subject FROM identity.users WHERE sso_issuer=$1 AND sso_subject IN ('employee-05','employee-02') ORDER BY (sso_subject='employee-05') DESC", ["https://sso.example.invalid"])).rows;
            assert.equal(users.length, 2);
            const otherDb = { ...nested, query(sql, args) { return query(sql, sql.includes("WHERE sso_issuer = $1 AND sso_subject = $2 AND role = 'employee'") ? [args[0], users[1].sso_subject] : args); } };
            const other = request.agent(createApp({ ...options, getPool: () => otherDb }));
            await other.post("/api/prototype/employee-session").send({}).expect(204);
            const start = new Date(Date.now() + 4 * 86400000); start.setUTCSeconds(0, 0);
            const activity = (await hr.post("/api/hr/activities").send({ departmentId: null, area: "wellbeing", type: "workshop", title: "Rollback-only management activity",
                description: "Shared supportive routines.", startsAt: start.toISOString(), duration: 45, format: "online", audience: "all_employees", publication: "published" }).expect(201)).body;
            const registrationPath = `/api/employee/activities/${activity.id}/registrations`;
            await employee.post(registrationPath).send({}).expect(200); await other.post(registrationPath).send({}).expect(200);
            const count = async () => (await hr.get("/api/hr/activities").expect(200)).body.activities.find((a) => a.id === activity.id).registrationCount;
            await t.test("registration cancellation persists, updates HR totals, preserves eligibility and allows protected re-registration", async () => {
                assert.equal(await count(), 2);
                const otherBefore = (await client.query("SELECT * FROM private.activity_registrations WHERE activity_id=$1 AND user_id=$2", [activity.id, users[1].user_id])).rows;
                await employee.delete(registrationPath).send({ userId: users[1].user_id }).expect(400);
                await employee.delete(registrationPath).send({}).expect(200);
                assert.equal(await count(), 1);
                const visible = (await employee.get("/api/employee/activities").expect(200)).body.find((a) => a.id === activity.id);
                assert(visible); assert.equal(visible.registered, false); assert.equal(visible.registrationOpen, true);
                const { renderRegistrationNotices } = await import("../public/js/ui.mjs");
                assert.equal(renderRegistrationNotices([visible]), "");
                await employee.delete(registrationPath).send({}).expect(409);
                await employee.delete("/api/prototype/employee-session").expect(204);
                await employee.post("/api/prototype/employee-session").send({}).expect(204);
                assert.equal((await employee.get("/api/employee/activities")).body.find((a) => a.id === activity.id).registered, false);
                assert.deepEqual((await client.query("SELECT * FROM private.activity_registrations WHERE activity_id=$1 AND user_id=$2", [activity.id, users[1].user_id])).rows, otherBefore);
                await employee.post(registrationPath).send({}).expect(200); await employee.post(registrationPath).send({}).expect(409);
                assert.equal(await count(), 2);
                await client.query("UPDATE operations.activities SET published_at=CURRENT_TIMESTAMP-interval '2 days',starts_at=CURRENT_TIMESTAMP-interval '1 day' WHERE activity_id=$1", [activity.id]);
                await employee.delete(registrationPath).send({}).expect(409);
                assert.equal(await count(), 2);
            });

            // Isolated transaction-only fixtures for cutoff, occupied and past
            // slot cases. No clinical/demo fixtures survive the outer rollback.
            const provider = (await client.query("INSERT INTO operations.psychologists(display_name) VALUES ('Rollback-only provider') RETURNING psychologist_id")).rows[0].psychologist_id;
            const slots = [];
            for (const minutes of [43200, 43320, 43440, 43560, 90, -1440]) {
                slots.push((await client.query(`INSERT INTO operations.psychologist_slots(psychologist_id,starts_at,ends_at,format,location)
                    VALUES($1,clock_timestamp()+$2*interval '1 minute',clock_timestamp()+($2+50)*interval '1 minute','in_person','Rollback-only room') RETURNING slot_id`, [provider, minutes])).rows[0].slot_id);
            }
            const book = async (user, slot) => (await client.query("INSERT INTO private.psychologist_bookings(user_id,slot_id) VALUES($1,$2) RETURNING *", [user, slot])).rows[0];
            const own = await book(users[0].user_id, slots[0]), occupied = await book(users[1].user_id, slots[2]), close = await book(users[0].user_id, slots[4]);
            const path = `/api/employee/appointments/${own.booking_id}`;
            const stored = async (id = own.booking_id) => (await client.query("SELECT * FROM private.psychologist_bookings WHERE booking_id=$1", [id])).rows[0];
            await t.test("only the owner can manage an appointment; slot DTO contains no attendee, clinician or video identifiers", async () => {
                for (const op of [() => other.patch(path).send({ slotId: String(slots[1]) }), () => other.delete(path).send({})]) await op().expect(404);
                await employee.patch(`/api/employee/appointments/${occupied.booking_id}`).send({ slotId: String(slots[1]) }).expect(404);
                for (const extra of [{ slotId: String(slots[1]), userId: users[1].user_id }, { slotId: "x" }, {}]) await employee.patch(path).send(extra).expect(400);
                await employee.delete(path).send({ user_id: users[1].user_id }).expect(400);
                const available = (await employee.get("/api/employee/appointment-slots").expect(200)).body;
                assert(available.some((s) => s.id === String(slots[1]))); assert(!available.some((s) => [slots[0], slots[2], slots[5]].map(String).includes(s.id)));
                for (const s of available) assert(Object.keys(s).every((k) => ["id", "startsAt", "duration", "format", "location"].includes(k)));
            });
            await t.test("reschedule keeps the original booking identity and releases the old slot; occupied/past slots and races fail atomically", async () => {
                await employee.patch(path).send({ slotId: String(slots[2]) }).expect(409);
                await employee.patch(path).send({ slotId: String(slots[5]) }).expect(409);
                assert.deepEqual(await stored(), own);
                race = true; const conflict = await employee.patch(path).send({ slotId: String(slots[1]) }).expect(409); race = false;
                assert(!JSON.stringify(conflict.body).includes("diagnostic")); assert.deepEqual(await stored(), own);
                await employee.patch(path).send({ slotId: String(slots[1]) }).expect(200);
                const saved = await stored();
                assert.equal(saved.slot_id, slots[1]); assert.equal(saved.booking_id, own.booking_id); assert.equal(saved.user_id, own.user_id);
                assert.deepEqual(saved.booked_at, own.booked_at); assert.equal(saved.status, "booked");
                assert.equal((await client.query("SELECT count(*)::int AS count FROM private.psychologist_bookings WHERE booking_id=$1", [own.booking_id])).rows[0].count, 1);
                const reminders = (await employee.get("/api/employee/appointment-reminders").expect(200)).body;
                assert.equal(reminders.find((b) => b.id === own.booking_id).startsAt, (await client.query("SELECT starts_at FROM operations.psychologist_slots WHERE slot_id=$1", [slots[1]])).rows[0].starts_at.toISOString());
                const available = (await employee.get("/api/employee/appointment-slots")).body;
                assert(available.some((s) => s.id === String(slots[0]))); assert(!available.some((s) => s.id === String(slots[1])));
                await client.query("SAVEPOINT unique_guard");
                await assert.rejects(client.query("UPDATE private.psychologist_bookings SET slot_id=$1 WHERE booking_id=$2", [slots[1], occupied.booking_id]), { code: "23505" });
                await client.query("ROLLBACK TO SAVEPOINT unique_guard"); await client.query("RELEASE SAVEPOINT unique_guard");
            });
            await t.test("cancellation preserves appointment history, frees its slot and survives a regenerated login", async () => {
                const prior = await stored(); await employee.delete(path).send({}).expect(200);
                const cancelled = await stored(); assert.equal(cancelled.status, "cancelled");
                for (const key of ["booking_id", "user_id", "slot_id", "booked_at"]) assert.deepEqual(cancelled[key], prior[key]);
                await employee.delete(path).send({}).expect(409);
                await employee.patch(path).send({ slotId: String(slots[3]) }).expect(409);
                await employee.delete("/api/prototype/employee-session").expect(204); await employee.post("/api/prototype/employee-session").send({}).expect(204);
                assert(!(await employee.get("/api/employee/appointment-reminders")).body.some((b) => b.id === own.booking_id));
                assert((await employee.get("/api/employee/appointment-slots")).body.some((s) => s.id === String(slots[1])));
            });
            await t.test("the existing two-hour cutoff, role boundaries and same-origin write protection remain enforced", async () => {
                for (const op of [() => employee.delete(`/api/employee/appointments/${close.booking_id}`).send({}),
                    () => employee.patch(`/api/employee/appointments/${close.booking_id}`).send({ slotId: String(slots[3]) })]) await op().expect(409);
                assert.deepEqual(await stored(close.booking_id), close);
                for (const agent of [manager, hr, request.agent(app)]) {
                    const status = agent === manager || agent === hr ? 403 : 401;
                    await agent.get("/api/employee/appointment-slots").expect(status);
                    await agent.patch(path).send({ slotId: String(slots[3]) }).expect(status);
                    await agent.delete(path).send({}).expect(status);
                    await agent.delete(registrationPath).send({}).expect(status);
                }
                await employee.delete(path).set("Origin", "https://evil.invalid").send({}).expect(403);
                await employee.delete(registrationPath).set("Origin", "https://evil.invalid").send({}).expect(403);
            });
            await t.test("Support booking uses the same PostgreSQL appointments as Home, with private confirmations and persistent management", async () => {
                const slot = (await client.query(`INSERT INTO operations.psychologist_slots(psychologist_id,starts_at,ends_at,format,video_url)
                    VALUES($1,clock_timestamp()+interval '60 days',clock_timestamp()+interval '60 days 50 minutes','online','https://sessions.example.invalid/private-qa') RETURNING slot_id`, [provider])).rows[0];
                const slotId = String(slot.slot_id);
                const available = (await employee.get("/api/employee/psychologist-slots").expect(200)).body;
                assert(available.some((s) => s.id === slotId));
                for (const item of available) assert(Object.keys(item).every((key) => ["id", "psychologist", "startsAt", "duration", "format", "location", "available"].includes(key)));
                await employee.get("/api/employee/bookings?userId=another").expect(400);
                await employee.post("/api/employee/bookings").send({ slotId, userId: users[1].user_id }).expect(400);
                const saved = (await employee.post("/api/employee/bookings").send({ slotId }).expect(201)).body;
                assert.equal(saved.demo, false); assert.equal(saved.videoUrl, "https://sessions.example.invalid/private-qa");
                assert.equal(saved.psychologist, "Rollback-only provider"); assert.equal(saved.canChange, true);
                const persisted = await stored(saved.id); assert.equal(persisted.user_id, users[0].user_id);
                await employee.post("/api/employee/bookings").send({ slotId }).expect(409);
                await other.post("/api/employee/bookings").send({ slotId }).expect(409);
                assert(!(await other.get("/api/employee/bookings")).body.some((b) => b.id === saved.id));
                await other.patch(`/api/employee/bookings/${saved.id}`).send({ slotId: String(slots[3]) }).expect(404);
                await other.delete(`/api/employee/bookings/${saved.id}`).expect(404);
                assert((await employee.get("/api/employee/appointment-reminders")).body.some((b) => b.id === saved.id));
                await employee.delete("/api/prototype/employee-session").expect(204); await employee.post("/api/prototype/employee-session").send({}).expect(204);
                assert((await employee.get("/api/employee/bookings")).body.some((b) => b.id === saved.id));
                const moved = (await employee.patch(`/api/employee/bookings/${saved.id}`).send({ slotId: String(slots[3]) }).expect(200)).body;
                assert.equal(moved.id, saved.id); assert.equal(moved.slotId, String(slots[3]));
                await employee.delete(`/api/employee/bookings/${saved.id}`).expect(200);
                assert.equal((await stored(saved.id)).status, "cancelled");
                assert(!(await employee.get("/api/employee/appointment-reminders")).body.some((b) => b.id === saved.id));
                assert((await employee.get("/api/employee/bookings")).body.some((b) => b.id === saved.id && b.status === "cancelled"));
                await employee.delete(`/api/employee/bookings/${close.booking_id}`).expect(409);
                for (const agent of [manager, hr, request.agent(app)]) {
                    const status = agent === manager || agent === hr ? 403 : 401;
                    await agent.get("/api/employee/psychologist-slots").expect(status); await agent.get("/api/employee/bookings").expect(status);
                    await agent.post("/api/employee/bookings").send({ slotId }).expect(status);
                    await agent.patch(`/api/employee/bookings/${saved.id}`).send({ slotId }).expect(status);
                    await agent.delete(`/api/employee/bookings/${saved.id}`).expect(status);
                }
            });
            await client.query("ROLLBACK");
            const after = await captureSnapshot(client); assert.deepEqual(after.tables, before.tables); assert.deepEqual(after.definitions, before.definitions);
        } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
    });

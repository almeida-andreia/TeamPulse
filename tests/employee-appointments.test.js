const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");
const { createEmployeeAppointments } = require("../server/employee-appointments");

test("PostgreSQL Support booking adapter never reads or writes browser-demo bookings", async () => {
    const { createEmployeeApi } = await import("../public/js/employee-api.mjs");
    const originalFetch = globalThis.fetch, originalStorage = globalThis.sessionStorage, calls = [];
    try {
        globalThis.sessionStorage = { getItem() { throw Error("Persisted bookings must not read tab data"); }, setItem() { throw Error("Persisted bookings must not write tab data"); } };
        globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => [] }; };
        const api = createEmployeeApi("postgres");
        await api.getSlots(); await api.getBookings(); await api.bookSlot("12"); await api.rescheduleBooking("own-booking", "13"); await api.cancelBooking("own-booking");
        assert.deepEqual(calls.map((c) => [c.url, c.options.method]), [
            ["/api/employee/psychologist-slots", "GET"], ["/api/employee/bookings", "GET"], ["/api/employee/bookings", "POST"],
            ["/api/employee/bookings/own-booking", "PATCH"], ["/api/employee/bookings/own-booking", "DELETE"]]);
        assert.deepEqual(JSON.parse(calls[2].options.body), { slotId: "12" });
        assert(calls.every((c) => c.options.credentials === "same-origin" && c.options.cache === "no-store"));
        globalThis.fetch = async () => ({ ok: false, status: 409 });
        await assert.rejects(api.bookSlot("12"), { status: 409 });
    } finally { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalStorage; }
});

test("Home appointment source is the authenticated API; browser demo bookings cannot supply reminders or act as fallback", async () => {
    const { createEmployeeApi } = await import("../public/js/employee-api.mjs");
    const { createDemoEmployeeApi } = await import("../public/js/demo-employee-api.mjs");
    const previousFetch = globalThis.fetch, previousStorage = globalThis.sessionStorage;
    const stored = new Map(), storage = { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    try {
        // An isolated in-memory demo fixture, never a PostgreSQL booking or the
        // user's browser storage. Its booking workflow remains unchanged.
        const demo = createDemoEmployeeApi({ storage });
        await demo.bookSlot((await demo.getSlots())[0].id);
        const before = stored.get("teampulse.employee-demo.v1");
        assert.equal((await demo.getBookings()).length, 1);
        assert.deepEqual(await demo.getAppointmentReminders(), []);
        globalThis.sessionStorage = storage;
        const persisted = [{ id: "persisted-own", startsAt: new Date(Date.now() + 86400000).toISOString(), status: "booked", format: "Online", location: null }];
        globalThis.fetch = async (url, options) => {
            assert.equal(url, "/api/employee/appointment-reminders");
            assert.equal(options.method, "GET"); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store");
            return { ok: true, status: 200, json: async () => persisted };
        };
        const api = createEmployeeApi("postgres");
        assert.deepEqual(await api.getAppointmentReminders(), persisted);
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
        assert.deepEqual(await api.getAppointmentReminders(), []);
        globalThis.fetch = async () => ({ ok: false, status: 503 });
        await assert.rejects(api.getAppointmentReminders(), { status: 503 });
        assert.equal(stored.get("teampulse.employee-demo.v1"), before);
    } finally { globalThis.fetch = previousFetch; globalThis.sessionStorage = previousStorage; }
});

test("appointment reminder API authenticates Employee ownership and rejects role or identity overrides", async () => {
    const now = Date.now(), calls = [];
    const users = [{ user_id: "ana", display_name: "Ana Silva", role: "employee", is_active: true },
        { user_id: "other", display_name: "Other Employee", role: "employee", is_active: true },
        { user_id: "manager", display_name: "Manager", role: "manager", is_active: true },
        { user_id: "hr", display_name: "HR", role: "hr", is_active: true }];
    const bookings = [
        { booking_id: "own", user_id: "ana", starts_at: new Date(now + 86400000), status: "booked", format: "online", location: null },
        { booking_id: "past", user_id: "ana", starts_at: new Date(now - 86400000), status: "booked", format: "online", location: null },
        { booking_id: "cancelled", user_id: "ana", starts_at: new Date(now + 86400000), status: "cancelled", format: "online", location: null },
        { booking_id: "other-booking", user_id: "other", starts_at: new Date(now + 86400000), status: "booked", format: "in_person", location: "Private room" }];
    let selected = "ana";
    const db = { async query(sql, args) {
        calls.push({ sql, args });
        if (sql.includes("SELECT user_id FROM identity.users")) return { rows: users.filter((u) => u.user_id === selected) };
        if (sql.includes("SELECT user_id, display_name")) return { rows: users.filter((u) => u.user_id === args[0]) };
        if (sql.includes("employee-appointments:upcoming")) {
            assert(sql.includes("b.user_id=$1")); assert(sql.includes("b.status='booked'")); assert(sql.includes("s.starts_at > CURRENT_TIMESTAMP"));
            return { rows: bookings.filter((b) => b.user_id === args[0] && b.status === "booked" && b.starts_at.getTime() > now) };
        }
        throw Error("Unexpected query");
    } };
    const app = createApp({ getPool: () => db, prototypeAccess: true, sessionSecret: "appointment-tests" });
    const agent = request.agent(app);
    await agent.get("/api/employee/appointment-reminders").expect(401);
    await agent.post("/api/prototype/employee-session").send({}).expect(204);
    const first = await agent.get("/api/employee/appointment-reminders").expect(200);
    assert.equal(first.headers["cache-control"], "no-store");
    assert.deepEqual(first.body, [{ id: "own", startsAt: bookings[0].starts_at.toISOString(), status: "booked", format: "Online", location: null }]);
    await agent.get("/api/employee/appointment-reminders?userId=other").expect(400);
    users[0].role = "manager"; await agent.get("/api/employee/appointment-reminders").expect(403);
    users[0].role = "hr"; await agent.get("/api/employee/appointment-reminders").expect(403);
    users[0].role = "employee"; users[0].is_active = false; await agent.get("/api/employee/appointment-reminders").expect(401);
    selected = "other";
    const other = request.agent(app); await other.post("/api/prototype/employee-session").send({}).expect(204);
    const ownOther = (await other.get("/api/employee/appointment-reminders").expect(200)).body;
    assert.equal(ownOther.length, 1); assert.equal(ownOther[0].id, "other-booking"); assert.equal(ownOther[0].format, "In person");
    assert(calls.every((c) => /^\s*(?:\/\*[^]*?\*\/\s*)?SELECT/.test(c.sql)));
});

test("PostgreSQL appointment reminders match only session-owned future booked slots and never modify records (SELECT only)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1." : false }, async () => {
        const { pool } = require("../server/db");
        const before = await pool.query("SELECT md5(string_agg(to_jsonb(b)::text,'|' ORDER BY booking_id)) AS hash FROM private.psychologist_bookings b");
        const readonly = { query(sql, args) { assert(/^\s*(?:\/\*[^]*?\*\/\s*)?SELECT/.test(sql)); return pool.query(sql, args); } };
        try {
            const ids = (await readonly.query("SELECT DISTINCT user_id FROM private.psychologist_bookings ORDER BY user_id")).rows;
            const service = createEmployeeAppointments(() => readonly);
            for (const { user_id: id } of ids) {
                const actual = await service.upcoming(id);
                const expected = (await readonly.query(`SELECT b.booking_id AS id,s.starts_at,s.format,s.location FROM private.psychologist_bookings b
                    JOIN operations.psychologist_slots s USING(slot_id) WHERE b.user_id=$1 AND b.status='booked'
                    AND s.starts_at>CURRENT_TIMESTAMP ORDER BY s.starts_at,b.booking_id`, [id])).rows.map((r) => ({ id: r.id,
                    startsAt: new Date(r.starts_at).toISOString(), format: r.format === "online" ? "Online" : "In person", location: r.location, status: "booked" }));
                assert.deepEqual(actual, expected);
                // Moving only the read-query clock past the owner's slots hides
                // them without editing the original schedule or booking rows.
                const later = (await readonly.query(`SELECT greatest(CURRENT_TIMESTAMP,max(s.starts_at))+interval '1 day' AS instant
                    FROM private.psychologist_bookings b JOIN operations.psychologist_slots s USING(slot_id) WHERE b.user_id=$1`, [id])).rows[0].instant;
                const futureClock = { query: (sql, args) => readonly.query(sql.replaceAll("CURRENT_TIMESTAMP", "$2::timestamptz"), [...args, later]) };
                assert.deepEqual(await createEmployeeAppointments(() => futureClock).upcoming(id), []);
            }
            assert.deepEqual((await pool.query("SELECT md5(string_agg(to_jsonb(b)::text,'|' ORDER BY booking_id)) AS hash FROM private.psychologist_bookings b")).rows, before.rows);
        } finally { await pool.end(); }
    });

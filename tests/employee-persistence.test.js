const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");

const ANA = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const raw = () => ({ wellbeing: "positive", workload: "difficult", stress: 4,
    teamIntegration: "connected", psychologicalSafety: 2, challenges: ["deadlines", "communication"], comment: "  Clearer deadlines would help.  " });
const week = { week_start: "2026-11-09", next_week: "2026-11-16", today: "2026-11-10" };
const catalog = ["workload", "unclear_priorities", "communication", "limited_support", "work_life_balance", null, "deadlines", "difficulty_integrating", "organizational_changes"];

// Explicit SQL test double: checks query parameters, atomic failure paths and
// HTTP authorization. It is NOT proof that PostgreSQL constraints execute.
// The opt-in test below exercises the real schema without committing fixtures.
function fixture(week = { week_start: "2026-11-09", next_week: "2026-11-16", today: "2026-11-13" }) {
    let state = {
        users: [{ user_id: ANA, display_name: "Ana Silva", role: "employee", is_active: true, team_id: "2" },
            { user_id: OTHER, display_name: "Luis Costa", role: "employee", is_active: true, team_id: "1" }],
        eligibility: [{ user_id: ANA, week_start: week.week_start, team_id: "1", response_id: null }],
        responses: [], factors: [], cohorts: [{ team_id: "1", week_start: week.week_start, finalized_at: null }]
    };
    const calls = [];
    let tail = Promise.resolve();
    const db = { calls, catalog: [...catalog], failure: null, released: 0, get state() { return state; } };
    async function query(sql, args = []) {
        const q = sql.replace(/\s+/g, " ").trim(); calls.push({ sql: q, args: structuredClone(args) });
        if (db.failure && q.includes(db.failure)) throw new Error("private SQL detail password=must-not-leak");
        const result = (rows = []) => ({ rows, rowCount: rows.length });
        if (q.includes("activity-support:list")) return result([{ activity_id: "1", title: "Shared priorities workshop", description: "Plan shared priorities.",
            activity_type: "workshop", starts_at: "2026-12-11T14:00:00Z", duration_minutes: 45, format: "online", target_audience: "All employees", is_featured: true, registered: false }]);
        if (q.includes("activity-support:available")) return result([{ activity_id: "1" }]);
        if (q.includes("activity-support:register")) return result([{ activity_id: "1" }]);
        if (q.startsWith("SELECT user_id FROM identity.users"))
            return result(state.users.filter((u) => u.user_id === ANA && u.is_active && u.role === "employee").map((u) => ({ user_id: u.user_id })));
        if (q.startsWith("SELECT user_id, display_name")) return result(state.users.filter((u) => u.user_id === args[0]));
        if (q.startsWith("SELECT to_char(date_trunc")) return result([week]);
        if (q.includes("FROM private.employee_weekly_checkins c") && !q.includes("JOIN wellbeing.wellbeing_responses"))
            return result(state.eligibility.filter((c) => c.user_id === args[0] && c.week_start === args[1])
                .map((c) => ({ ...c, finalized_at: state.cohorts.find((w) => w.team_id === c.team_id && w.week_start === c.week_start)?.finalized_at })));
        if (q.startsWith("INSERT INTO wellbeing.team_weeks")) {
            if (!state.cohorts.some((c) => c.team_id === args[0] && c.week_start === args[1]))
                state.cohorts.push({ team_id: args[0], week_start: args[1], finalized_at: null });
            return result();
        }
        if (q.startsWith("SELECT finalized_at")) return result(state.cohorts.filter((c) => c.team_id === args[0] && c.week_start === args[1]));
        if (q.startsWith("INSERT INTO private.employee_weekly_checkins")) {
            for (const u of state.users.filter((u) => u.team_id === args[0] && u.role === "employee" && u.is_active)) {
                if (!state.eligibility.some((c) => c.user_id === u.user_id && c.week_start === args[1]))
                    state.eligibility.push({ user_id: u.user_id, week_start: args[1], team_id: u.team_id, response_id: null });
            }
            return result();
        }
        if (q.startsWith("SELECT challenge_factor_id")) return result(db.catalog.flatMap((code, i) => code && args[0].includes(code) ? [{ code, challenge_factor_id: i + 1 }] : []));
        if (q.startsWith("INSERT INTO wellbeing.wellbeing_responses")) {
            const fields = ["team_id", "week_start", "wellbeing_score", "workload_score", "stress_score", "team_integration_score", "psychological_safety_score", "comment"];
            const response = { response_id: `response-${state.responses.length + 1}`, ...Object.fromEntries(fields.map((key, i) => [key, args[i]])) };
            state.responses.push(response); return result([{ response_id: response.response_id }]);
        }
        if (q.startsWith("INSERT INTO wellbeing.response_challenges")) { state.factors.push({ response_id: args[0], challenge_factor_id: args[1] }); return result(); }
        if (q.startsWith("UPDATE private.employee_weekly_checkins")) {
            const c = state.eligibility.find((c) => c.user_id === args[0] && c.week_start === args[1] && !c.response_id);
            if (c) c.response_id = args[2];
            return { rows: [], rowCount: c ? 1 : 0 };
        }
        if (q.includes("JOIN wellbeing.wellbeing_responses r")) return result(state.eligibility.filter((c) => c.user_id === args[0] && c.week_start <= args[1])
            .map((c) => state.responses.find((r) => r.response_id === c.response_id && r.team_id === c.team_id && r.week_start === c.week_start))
            .filter(Boolean).sort((a, b) => a.week_start.localeCompare(b.week_start)));
        throw new Error(`Unhandled test SQL: ${q}`);
    }
    const pool = { query, async connect() {
        let previous, unlock, snapshot;
        return { async query(sql, args) {
            if (sql === "BEGIN") {
                previous = tail; tail = new Promise((resolve) => { unlock = resolve; }); await previous;
                snapshot = structuredClone(state); calls.push({ sql, args: [] }); return { rows: [] };
            }
            if (sql === "COMMIT" || sql === "ROLLBACK") {
                if (sql === "COMMIT" && db.failure === "COMMIT") throw new Error("private deferred constraint failure");
                if (sql === "ROLLBACK") state = snapshot;
                calls.push({ sql, args: [] }); unlock(); return { rows: [] };
            }
            return query(sql, args);
        }, release() { db.released++; } };
    } };
    db.pool = pool;
    db.app = createApp({ getPool: () => pool, sessionSecret: "test-only-session-secret", prototypeAccess: true });
    db.agent = request.agent(db.app);
    db.login = () => db.agent.post("/api/prototype/employee-session").send({}).expect(204);
    return db;
}

test("API stores five canonical scores, relational factors, comment and historical cohort atomically", async () => {
    const db = fixture(); await db.login();
    const result = await db.agent.post("/api/employee/check-ins").send(raw()).expect(201);
    assert.deepEqual(result.body, { weekStart: week.week_start });
    assert.deepEqual(db.state.responses[0], { response_id: "response-1", team_id: "1", week_start: week.week_start,
        wellbeing_score: 7.5, workload_score: 6.7, stress_score: 7.5, team_integration_score: 6.7,
        psychological_safety_score: 2.5, comment: "Clearer deadlines would help." });
    assert.equal(db.state.eligibility[0].response_id, "response-1");
    assert.deepEqual(db.state.factors.map((f) => f.challenge_factor_id).sort(), [3, 7]);
    assert(db.calls.find((c) => c.sql.includes("FOR UPDATE OF c")));
    const insert = db.calls.find((c) => c.sql.startsWith("INSERT INTO wellbeing.wellbeing_responses"));
    assert(!insert.sql.includes("user_id")); assert(!insert.args.includes(ANA));
    const attachIndex = db.calls.findIndex((c) => c.sql.startsWith("UPDATE private.employee_weekly_checkins"));
    assert(db.calls.findLastIndex((c) => c.sql.startsWith("INSERT INTO wellbeing.response_challenges")) < attachIndex);
    assert.equal(db.calls.at(-1).sql, "COMMIT"); assert.equal(db.released, 1);
    const status = await db.agent.get("/api/employee/check-ins/current").expect(200);
    assert.deepEqual(status.body, { weekStart: week.week_start, nextWeek: week.next_week, opensOn: "2026-11-13", nextOpensOn: "2026-11-20", available: false, submitted: true });
    const history = await db.agent.get("/api/employee/history?period=year").expect(200);
    assert.deepEqual(history.body.monthlyCompletion, { month: "2026-11", completed: 1, target: 4 });
});

for (const field of ["wellbeing", "workload", "stress", "teamIntegration", "psychologicalSafety"]) {
    test(`API rejects missing ${field} before starting a write`, async () => {
        const db = fixture(); await db.login(); const body = raw(); delete body[field];
        await db.agent.post("/api/employee/check-ins").send(body).expect(400);
        assert(!db.calls.some((c) => c.sql === "BEGIN")); assert.equal(db.state.responses.length, 0);
    });
}
for (const [label, values] of [
    ["numeric stress outside 1..5", { stress: 6 }], ["fractional rating", { psychologicalSafety: 2.5 }],
    ["string rating", { stress: "3" }], ["normalized category score", { workload: 6.7 }],
    ["unknown challenge", { challenges: ["tools_processes"] }], ["duplicate challenges", { challenges: ["workload", "workload"] }],
    ["oversized comment", { comment: "x".repeat(2001) }], ["identity injection", { user_id: OTHER }],
    ["normalized score injection", { stress_score: 0 }], ["team/week injection", { team_id: 2, week_start: "2026-11-02" }]
]) {
    test(`API rejects ${label}`, async () => {
        const db = fixture(); await db.login();
        await db.agent.post("/api/employee/check-ins").send({ ...raw(), ...values }).expect(400);
        assert.equal(db.state.responses.length, 0);
    });
}

test("API accepts zero challenges and an omitted comment", async () => {
    const db = fixture(); await db.login(); const body = raw(); body.challenges = []; delete body.comment;
    await db.agent.post("/api/employee/check-ins").send(body).expect(201);
    assert.equal(db.state.responses[0].comment, null); assert.equal(db.state.factors.length, 0);
});
test("API validates selected codes against the live database catalogue", async () => {
    const db = fixture(); await db.login(); db.catalog[6] = null;
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(400);
    assert.equal(db.state.responses.length, 0); assert.equal(db.calls.at(-1).sql, "ROLLBACK");
});
test("API rejects concurrent/repeated weekly submissions without adding responses", async () => {
    const db = fixture(); await db.login();
    const results = await Promise.all([db.agent.post("/api/employee/check-ins").send(raw()), db.agent.post("/api/employee/check-ins").send(raw())]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(409);
    assert.equal(db.state.responses.length, 1); assert.equal(db.state.factors.length, 2);
});
for (const failure of ["INSERT INTO wellbeing.wellbeing_responses", "INSERT INTO wellbeing.response_challenges", "UPDATE private.employee_weekly_checkins", "COMMIT"]) {
    test(`API rolls back and releases on failure at ${failure}`, async () => {
        const db = fixture(); await db.login(); db.failure = failure;
        const result = await db.agent.post("/api/employee/check-ins").send(raw()).expect(503);
        assert(!JSON.stringify(result.body).includes("private")); assert(!JSON.stringify(result.body).includes("password"));
        assert.equal(db.state.responses.length, 0); assert.equal(db.state.factors.length, 0);
        assert.equal(db.state.eligibility[0].response_id, null); assert.equal(db.calls.at(-1).sql, "ROLLBACK"); assert.equal(db.released, 1);
    });
}
test("new open weeks snapshot all active team members, preserving existing eligibility", async () => {
    const db = fixture(); db.state.eligibility = []; db.state.cohorts = [];
    db.state.users[1].team_id = "2"; await db.login();
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(201);
    assert.equal(db.state.eligibility.length, 2);
    assert.equal(db.state.eligibility.find((c) => c.user_id === OTHER).response_id, null);
    assert.equal(db.state.responses[0].team_id, "2");
});
test("finalized weeks cannot accept submissions", async () => {
    const db = fixture(); await db.login(); db.state.cohorts[0].finalized_at = "2026-11-16";
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(409);
    assert.equal(db.state.responses.length, 0);
});
test("private history reads only the session owner and preserves continuous/missing scores", async () => {
    const db = fixture(); await db.login();
    const records = [[ANA, "2026-10-26", "legacy", "1", "6.4", null], [OTHER, "2026-11-09", "other", "1", "0.0", "10.0"]];
    for (const [user_id, week_start, response_id, team_id, wellbeing_score, stress_score] of records) {
        db.state.eligibility.push({ user_id, week_start, response_id, team_id });
        db.state.responses.push({ response_id, week_start, team_id, wellbeing_score, stress_score,
            workload_score: "5.1", team_integration_score: "7.2", psychological_safety_score: "6.3", comment: "private comment" });
    }
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(201);
    const { body, headers } = await db.agent.get("/api/employee/history?period=quarter").expect(200);
    assert.equal(headers["cache-control"], "no-store"); assert.equal(body.entries.length, 2);
    assert.equal(body.entries[0].wellbeing, 6.4); assert.equal(body.entries[0].stress, null);
    assert.equal(body.latest.wellbeing, 7.5); assert.equal(body.monthlyChange.stress, null);
    assert(Math.abs(body.monthlyChange.wellbeing - 1.1) < 0.00001);
    for (const entry of body.entries) assert.deepEqual(Object.keys(entry), ["weekStart", "wellbeing", "workload", "stress", "teamIntegration", "psychologicalSafety"]);
    await db.agent.get(`/api/employee/history?user_id=${OTHER}`).expect(400);
    await db.agent.get("/api/employee/history?period=invalid").expect(400);
    const otherLogin = request.agent(db.app);
    await otherLogin.get("/api/employee/history").set("X-User-Id", ANA).set("X-Role", "employee").expect(401);
});
test("empty persisted history returns a valid empty DTO", async () => {
    const db = fixture(); await db.login(); const { body } = await db.agent.get("/api/employee/history").expect(200);
    assert.deepEqual(body.entries, []); assert.equal(body.latest, null);
    assert(Object.values(body.monthlyChange).every((value) => value === null));
});
test("persisted history periods use the Lisbon day and calendar quarter/year boundaries", async () => {
    const db = fixture(week); await db.login();
    for (const [i, date] of ["2025-12-29", "2026-01-05", "2026-09-28", "2026-10-05", "2026-10-12", "2026-11-09", "2026-11-16"].entries()) {
        const response_id = `history-${i}`;
        db.state.eligibility.push({ user_id: ANA, week_start: date, response_id, team_id: "1" });
        db.state.responses.push({ response_id, week_start: date, team_id: "1", wellbeing_score: "6.4", workload_score: "5.2",
            stress_score: "0.0", team_integration_score: "7.2", psychological_safety_score: "7.1" });
    }
    const datesFor = async (period) => (await db.agent.get(`/api/employee/history?period=${period}`).expect(200)).body.entries.map((entry) => entry.weekStart);
    assert.deepEqual(await datesFor("30days"), ["2026-10-12", "2026-11-09"]);
    assert.deepEqual(await datesFor("quarter"), ["2026-10-05", "2026-10-12", "2026-11-09"]);
    assert.deepEqual(await datesFor("year"), ["2026-01-05", "2026-09-28", "2026-10-05", "2026-10-12", "2026-11-09"]);
    assert.equal((await db.agent.get("/api/employee/history")).body.latest.stress, 0);
});
test("PostgreSQL adapter persists check-ins and activities and never falls back to browser bookings", async () => {
    const db = fixture(); const originalFetch = globalThis.fetch, originalStorage = globalThis.sessionStorage;
    const saved = new Map([["teampulse.employee-demo.v1", JSON.stringify({ version: 1,
        checkins: [{ weekStart: "2026-11-02", wellbeing: 6.4 }], registrations: [], bookings: [] })]]);
    const before = saved.get("teampulse.employee-demo.v1"), urls = [];
    globalThis.sessionStorage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
    globalThis.fetch = async (url, options = {}) => {
        urls.push(url);
        const method = (options.method || "GET").toLowerCase();
        let call = db.agent[method](url);
        if (options.headers) call = call.set(options.headers);
        if (options.body) call = call.send(options.body);
        const response = await call;
        return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.body };
    };
    try {
        const { createEmployeeApi } = await import("../public/js/employee-api.mjs");
        const api = createEmployeeApi("postgres");
        await api.startPrototypeSession(); assert.equal((await api.getEmployee()).displayName, "Ana Silva");
        assert.equal((await api.getCheckinStatus()).submitted, false);
        await api.submitCheckin(raw());
        assert.equal((await api.getHistory()).latest.stress, 7.5);
        assert.equal((await createEmployeeApi("postgres").getCheckinStatus()).submitted, true);
        await assert.rejects(api.submitCheckin(raw()), { status: 409 });
        assert.equal(saved.get("teampulse.employee-demo.v1"), before, "Existing browser check-ins are never cleared, imported or overwritten.");
        const count = urls.length;
        const activities = await api.getActivities(); assert(activities.length);
        const registration = await api.registerActivity(activities[0].id); assert.equal(registration.registered, true);
        assert(urls.includes("/api/employee/activities"));
        assert(urls.includes("/api/employee/activities/1/registrations"));
        // This check-in fixture intentionally has no appointment data access.
        // The old browser-demo expectation is obsolete: unavailable PostgreSQL
        // bookings must fail, while the real booking lifecycle is tested in PG.
        await assert.rejects(api.getSlots(), { status: 503 });
        await assert.rejects(api.bookSlot("1"), { status: 503 });
        assert.equal(urls.length, count + 4);
        assert(urls.includes("/api/employee/psychologist-slots") && urls.includes("/api/employee/bookings"));
        assert.equal(saved.get("teampulse.employee-demo.v1"), before);
        await api.endPrototypeSession(); await assert.rejects(api.getHistory(), { status: 401 });
        db.failure = "SELECT user_id FROM identity.users";
        await assert.rejects(api.startPrototypeSession(), { status: 503 });
    } finally { globalThis.fetch = originalFetch; globalThis.sessionStorage = originalStorage; }
});
for (const role of ["manager", "hr"]) {
    test(`${role} cannot access Employee data even with an existing session`, async () => {
        const db = fixture(); await db.login(); db.state.users[0].role = role;
        await db.agent.get("/api/employee/me").expect(403);
        await db.agent.get("/api/employee/check-ins/current").expect(403);
        await db.agent.get("/api/employee/history").expect(403);
        await db.agent.post("/api/employee/check-ins").send(raw()).expect(403);
        assert.equal(db.state.responses.length, 0);
    });
}
test("local prototype identity is fixed server-side; logout and inactive accounts deny access", async () => {
    const db = fixture();
    await db.agent.post("/api/prototype/employee-session").send({ user_id: OTHER, role: "employee" }).expect(400);
    await db.agent.post("/api/prototype/employee-session").set("Host", "outside.example").send({}).expect(403);
    await db.agent.post("/api/prototype/employee-session").set("Origin", "https://outside.example").send({}).expect(403);
    await db.login();
    const { body } = await db.agent.get("/api/employee/me").expect(200);
    assert.deepEqual(body, { displayName: "Ana Silva", firstName: "Ana", role: "employee" });
    db.state.users[0].is_active = false;
    await db.agent.get("/api/employee/history").expect(401); db.state.users[0].is_active = true;
    await db.agent.delete("/api/prototype/employee-session").expect(204);
    await db.agent.get("/api/employee/history").expect(401);
});
test("prototype access can be disabled and malformed/oversized requests fail safely", async () => {
    const db = fixture(); const app = createApp({ getPool: () => db.pool, prototypeAccess: false });
    await request(app).post("/api/prototype/employee-session").send({}).expect(403);
    const malformed = await db.agent.post("/api/employee/check-ins").set("Content-Type", "application/json").send('{"broken":').expect(400);
    assert(!JSON.stringify(malformed.body).includes("SyntaxError"));
    await db.agent.post("/api/employee/check-ins").send({ comment: "x".repeat(20000) }).expect(413);
    await db.agent.post("/api/prototype/employee-session").type("form").send("user=ana").expect(415);
    await db.agent.post("/api/prototype/employee-session").set("Sec-Fetch-Site", "cross-site").send({}).expect(403);
    db.failure = "SELECT user_id FROM identity.users";
    const failed = await db.agent.post("/api/prototype/employee-session").send({}).expect(503);
    assert(!JSON.stringify(failed.body).includes("password"));
    await db.agent.get("/api/health").expect(200, { status: "ok", message: "TeamPulse API is running" });
    await db.agent.get("/api/manager/responses").expect(404);
    await db.agent.get("/api/hr/responses").expect(404);
});

for (const today of ["2026-11-09", "2026-11-10", "2026-11-12"]) test(`check-in is closed before Friday (${today}), including direct POST`, async () => {
    const db = fixture({ ...week, today }); await db.login();
    const { body } = await db.agent.get("/api/employee/check-ins/current").expect(200);
    assert.equal(body.available, false); assert.equal(body.opensOn, "2026-11-13");
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(409);
    assert(!db.calls.some((c) => /^(INSERT|UPDATE)/.test(c.sql)));
});
for (const [monday, friday, nextMonday] of [["2026-10-26", "2026-10-30", "2026-11-02"], ["2026-11-02", "2026-11-06", "2026-11-09"],
    ["2026-12-28", "2027-01-01", "2027-01-04"]]) test(`Friday weekly availability crosses calendar boundaries: ${friday}`, async () => {
    const calendar = { week_start: monday, today: friday, next_week: nextMonday };
    const db = fixture(calendar); await db.login();
    assert.equal((await db.agent.get("/api/employee/check-ins/current")).body.available, true);
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(201);
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(409);
    const previous = structuredClone(db.state.responses);
    calendar.week_start = nextMonday;
    const next = new Date(`${nextMonday}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 4); calendar.today = next.toISOString().slice(0, 10);
    next.setUTCDate(next.getUTCDate() + 3); calendar.next_week = next.toISOString().slice(0, 10);
    assert.equal((await db.agent.get("/api/employee/check-ins/current")).body.available, true);
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(201);
    assert.deepEqual(db.state.responses.slice(0, previous.length), previous);
});
test("Sunday remains open for its Monday cohort", async () => {
    const db = fixture({ ...week, today: "2026-11-15" }); await db.login();
    assert.equal((await db.agent.get("/api/employee/check-ins/current")).body.available, true);
    await db.agent.post("/api/employee/check-ins").send(raw()).expect(201);
});

test("successive November Fridays each allow one independent check-in and preserve all prior answers", async () => {
    const calendar = { week_start: "2026-11-02", today: "2026-11-06", next_week: "2026-11-09" };
    const db = fixture(calendar); await db.login();
    for (let index = 0; index < 4; index++) {
        const previous = structuredClone(db.state.responses);
        const status = (await db.agent.get("/api/employee/check-ins/current").expect(200)).body;
        assert.equal(status.available, true); assert.equal(status.submitted, false);
        assert.equal(status.opensOn, calendar.today);
        await db.agent.post("/api/employee/check-ins").send(raw()).expect(201);
        await db.agent.post("/api/employee/check-ins").send(raw()).expect(409);
        assert.equal((await db.agent.get("/api/employee/check-ins/current")).body.submitted, true);
        assert.deepEqual(db.state.responses.slice(0, previous.length), previous);
        const plus = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
        calendar.week_start = calendar.next_week;
        calendar.today = calendar.week_start;
        calendar.next_week = plus(calendar.week_start, 7);
        assert.equal((await db.agent.get("/api/employee/check-ins/current")).body.available, false);
        await db.agent.post("/api/employee/check-ins").send(raw()).expect(409);
        calendar.today = plus(calendar.week_start, 4);
    }
    assert.equal(db.state.responses.length, 4);
});

test("PostgreSQL: real schema, scores, factors, ownership, history and duplicate protection (rollback only)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1 with a configured seeded local database." : false }, async () => {
        const { pool } = require("../server/db");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            // Nest the service transaction inside this outer rollback. Force
            // deferred ownership FKs to validate as a real COMMIT would.
            // Exercise submission on Friday even when the suite runs earlier
            // in the week. The separate SELECT-only calendar test verifies the
            // real Lisbon clock conversion and its precise opening boundaries.
            const fridayQuery = (sql, args) => client.query(sql.includes("AS today") ? sql.replace(
                "to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon', 'YYYY-MM-DD') AS today",
                "to_char(date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon') + interval '4 days', 'YYYY-MM-DD') AS today") : sql, args);
            const nestedPool = { query: fridayQuery, async connect() { return {
                async query(sql, args) {
                    if (sql === "BEGIN") return client.query("SAVEPOINT checkin_test");
                    if (sql === "COMMIT") { await client.query("SET CONSTRAINTS ALL IMMEDIATE"); return client.query("RELEASE SAVEPOINT checkin_test"); }
                    if (sql === "ROLLBACK") { await client.query("ROLLBACK TO SAVEPOINT checkin_test"); return client.query("RELEASE SAVEPOINT checkin_test"); }
                    return fridayQuery(sql, args);
                }, release() {}
            }; } };
            const { createEmployeeCheckins } = require("../server/employee-checkins");
            const service = createEmployeeCheckins(() => nestedPool);
            // The browser verification legitimately consumes Ana's weekly slot.
            // Use an Employee created INSIDE this outer rollback so this test
            // stays repeatable without clearing or replacing anybody's answers.
            const ana = await service.employee(await service.prototypeEmployee());
            const { rows: [testEmployee] } = await client.query(`INSERT INTO identity.users
                (sso_issuer, sso_subject, display_name, role, team_id)
                VALUES ($1, $2, $3, 'employee', $4) RETURNING user_id`,
            ["https://sso.example.invalid", `integration-${require("node:crypto").randomUUID()}`,
                "Transaction-only Test Employee", ana.team_id]);
            const id = testEmployee.user_id;
            assert.equal((await service.status(id)).submitted, false);
            const result = await service.submit(id, raw());
            const { rows: [saved] } = await client.query(`SELECT r.*, c.user_id,
                (SELECT array_agg(f.code ORDER BY f.code) FROM wellbeing.response_challenges rc
                 JOIN wellbeing.challenge_factors f USING (challenge_factor_id) WHERE rc.response_id = r.response_id) AS challenges
                FROM private.employee_weekly_checkins c JOIN wellbeing.wellbeing_responses r USING (response_id)
                WHERE c.user_id = $1 AND c.week_start = $2`, [id, result.weekStart]);
            assert.equal(saved.user_id, id); assert.equal(Number(saved.wellbeing_score), 7.5);
            assert.equal(Number(saved.workload_score), 6.7); assert.equal(Number(saved.stress_score), 7.5);
            assert.equal(Number(saved.team_integration_score), 6.7); assert.equal(Number(saved.psychological_safety_score), 2.5);
            assert.equal(saved.comment, "Clearer deadlines would help."); assert.deepEqual(saved.challenges, ["communication", "deadlines"]);
            assert.equal((await service.history(id, "year")).latest.weekStart, result.weekStart);
            await assert.rejects(service.submit(id, raw()), { status: 409 });
        } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
    });

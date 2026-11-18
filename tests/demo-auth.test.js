const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { readApplicationConfig } = require("../server/config");
const { createApp } = require("../server/app");

function identities() {
    const users = [
        { user_id: "00000000-0000-4000-8000-000000000001", sso_subject: "employee-05", display_name: "Beatriz Sousa", role: "employee", team_id: "1", is_active: true },
        { user_id: "00000000-0000-4000-8000-000000000002", sso_subject: "manager-platform", display_name: "Mara Duarte", role: "manager", is_active: true },
        { user_id: "00000000-0000-4000-8000-000000000003", sso_subject: "hr-marta", display_name: "Marta Pinto", role: "hr", is_active: true }
    ];
    const calls = [];
    return { users, calls, async query(sql, args) {
        assert.match(sql.trim(), /^SELECT\b/); calls.push({ sql, args });
        if (sql.includes("sso_issuer")) {
            const role = args[2] ?? "employee";
            return { rows: users.filter((u) => args[0] === "https://sso.example.invalid" && u.sso_subject === args[1] && u.role === role && u.is_active) };
        }
        if (sql.includes("WHERE user_id = $1")) return { rows: users.filter((u) => u.user_id === args[0]) };
        throw Error("Unexpected demo authentication query");
    } };
}
async function environment(values, run) {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    try {
        for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
        await run();
    } finally {
        for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    }
}

test("remote demo authentication is strictly opt-in; explicit false overrides legacy configuration", () => {
    for (const mode of [undefined, "development", "test", "production"]) {
        const config = readApplicationConfig({ ...(mode ? { NODE_ENV: mode } : {}) });
        assert.equal(config.demoAuthEnabled, false);
        assert.equal(config.prototypeAccess, false);
    }
    const production = readApplicationConfig({ NODE_ENV: "production", DEMO_AUTH_ENABLED: "true" });
    assert.equal(production.demoAuthEnabled, true); assert.equal(production.prototypeAccess, false);
    const disabled = readApplicationConfig({ DEMO_AUTH_ENABLED: "false", ENABLE_PROTOTYPE_ACCESS: "true" });
    assert.equal(disabled.demoAuthEnabled, false); assert.equal(disabled.prototypeAccess, false);
    for (const value of ["yes", "1", "", "TRUE"]) assert.throws(() => readApplicationConfig({ DEMO_AUTH_ENABLED: value }), { code: "CONFIGURATION_INVALID" });
});

test("disabled demo entry exposes only availability and never queries PostgreSQL", async () => {
    await environment({ DEMO_AUTH_ENABLED: "false", ENABLE_PROTOTYPE_ACCESS: "true" }, async () => {
        const app = createApp({ getPool: () => { throw Error("Disabled entry must not query the database"); } });
        assert.deepEqual((await request(app).get("/api/demo-access").expect(200)).body, { enabled: false });
        for (const role of ["employee", "manager", "hr"]) {
            const response = await request(app).post(`/api/prototype/${role}-session`).send({}).expect(403);
            assert.equal(response.body.code, "DEMO_AUTH_DISABLED"); assert.equal(response.headers["set-cookie"], undefined);
        }
    });
});

test("legacy local entry stays local when no remote demo flag is supplied", async () => {
    const db = identities(), app = createApp({ getPool: () => db, prototypeAccess: true, demoAuthEnabled: false });
    assert.deepEqual((await request(app).get("/api/demo-access").set("Host", "professor.example.invalid").expect(200)).body, { enabled: false });
    for (const role of ["employee", "manager", "hr"])
        await request(app).post(`/api/prototype/${role}-session`).set("Host", "professor.example.invalid").send({}).expect(403);
    assert.equal(db.calls.length, 0);
});

test("remote demo sessions reuse the three fixed accounts, rotate IDs, recheck roles and logout", async () => {
    const db = identities(), app = createApp({ getPool: () => db, demoAuthEnabled: true, prototypeAccess: false, sessionSecret: "demo-authentication-test-secret-only" });
    const host = "professor.example.invalid";
    assert.deepEqual((await request(app).get("/api/demo-access").set("Host", host).expect(200)).body, { enabled: true });
    let previousCookie;
    for (const role of ["employee", "manager", "hr"]) {
        let login = request(app).post(`/api/prototype/${role}-session`).set("Host", host).set("Origin", `http://${host}`);
        if (previousCookie) login = login.set("Cookie", previousCookie);
        const response = await login.send({}).expect(204), cookie = response.headers["set-cookie"][0].split(";")[0];
        if (previousCookie) {
            assert.notEqual(cookie, previousCookie);
            await request(app).get("/api/employee/me").set("Cookie", previousCookie).expect(401);
        }
        assert.match(response.headers["set-cookie"][0], /HttpOnly/); assert.match(response.headers["set-cookie"][0], /SameSite=Strict/);
        const denied = role === "employee" ? ["/api/manager/overview", "/api/hr/activities"]
            : role === "manager" ? ["/api/employee/history", "/api/hr/overview"] : ["/api/employee/history", "/api/manager/actions"];
        for (const endpoint of denied) await request(app).get(endpoint).set("Cookie", cookie).expect(403);
        if (role === "employee") {
            assert.equal((await request(app).get("/api/employee/me").set("Cookie", cookie).expect(200)).body.displayName, "Beatriz Sousa");
            db.users[0].is_active = false; await request(app).get("/api/employee/me").set("Cookie", cookie).expect(401); db.users[0].is_active = true;
        }
        previousCookie = cookie;
    }
    assert.deepEqual(db.calls.filter((c) => c.sql.includes("sso_issuer")).map((c) => c.args[1]), ["employee-05", "manager-platform", "hr-marta"]);
    await request(app).delete("/api/prototype/employee-session").set("Cookie", previousCookie).expect(204);
    for (const endpoint of ["/api/employee/history", "/api/manager/overview", "/api/hr/overview"])
        await request(app).get(endpoint).set("Cookie", previousCookie).expect(401);
});

test("remote demo entry rejects identity injection and cross-origin requests", async () => {
    const db = identities(), app = createApp({ getPool: () => db, demoAuthEnabled: true });
    for (const role of ["employee", "manager", "hr"]) {
        const endpoint = `/api/prototype/${role}-session`;
        for (const payload of [{ userId: db.users[0].user_id }, { role: "hr" }, { sso_subject: "another-employee" }])
            await request(app).post(endpoint).send(payload).expect(400);
        await request(app).post(endpoint).set("Host", "demo.example.invalid").set("Origin", "https://attacker.example.invalid").send({}).expect(403);
        await request(app).post(endpoint).set("Sec-Fetch-Site", "cross-site").send({}).expect(403);
    }
    assert.equal(db.calls.length, 0);
    db.users[0].role = "hr";
    const response = await request(app).post("/api/prototype/employee-session").send({}).expect(503);
    assert.equal(response.headers["set-cookie"], undefined);
});

test("production academic demo requires explicit enablement, strong secret and trusted HTTPS; cookies remain secure", async () => {
    await environment({ NODE_ENV: "production", DEMO_AUTH_ENABLED: "true", SESSION_SECRET: "", TRUST_PROXY: "1" }, async () => {
        assert.throws(() => createApp(), /SESSION_SECRET/);
        process.env.SESSION_SECRET = require("node:crypto").randomBytes(32).toString("hex");
        const db = identities(), app = createApp({ getPool: () => db });
        assert.equal(app.get("trust proxy fn")("127.0.0.1", 0), true);
        assert.equal(app.get("trust proxy fn")("203.0.113.1", 1), false);
        await request(app).post("/api/prototype/employee-session").send({}).expect(403);
        await request(app).post("/api/prototype/employee-session").set("Host", "demo.example.invalid")
            .set("X-Forwarded-Proto", "http").send({}).expect(403);
        await request(app).post("/api/prototype/employee-session").set("Host", "demo.example.invalid")
            .set("X-Forwarded-Proto", "https").set("X-Forwarded-Host", "evil.example.invalid")
            .set("Origin", "https://evil.example.invalid").send({}).expect(403);
        const response = await request(app).post("/api/prototype/employee-session").set("Host", "demo.example.invalid")
            .set("X-Forwarded-Proto", "https").set("Origin", "https://demo.example.invalid").send({}).expect(204);
        const cookie = response.headers["set-cookie"][0]; assert.match(cookie, /; Secure/); assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        await request(app).get("/api/employee/me").set("X-Forwarded-Proto", "https").set("Cookie", cookie.split(";")[0]).expect(200);
        process.env.TRUST_PROXY = "false";
        const untrusted = createApp({ getPool: () => db });
        await request(untrusted).post("/api/prototype/employee-session").set("X-Forwarded-Proto", "https").send({}).expect(403);
    });
});

test("Employee demo availability fails closed and disabled errors never expose backend diagnostics", async () => {
    const { createEmployeeApi } = await import("../public/js/employee-api.mjs");
    const original = globalThis.fetch;
    try {
        const api = createEmployeeApi("postgres");
        for (const enabled of [true, false, "true", undefined]) {
            globalThis.fetch = async () => ({ ok: true, json: async () => ({ enabled }) });
            assert.deepEqual(await api.getDemoAccess(), { enabled: enabled === true });
        }
        globalThis.fetch = async () => { throw Error("private service diagnostics"); };
        await assert.rejects(api.getDemoAccess(), /Demo access is unavailable/);
        globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ code: "DEMO_AUTH_DISABLED", error: "private diagnostics" }) });
        await assert.rejects(api.startPrototypeSession(), /Demo access is disabled on this deployment/);
    } finally { globalThis.fetch = original; }
});

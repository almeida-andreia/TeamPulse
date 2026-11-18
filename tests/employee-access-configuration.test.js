const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const request = require("supertest");
const { createApp } = require("../server/app");

test("missing database credentials are identified before opening a PostgreSQL connection", () => {
    // Isolated process: never edit .env or disturb the running application's
    // credentials. Explicit blanks prevent dotenv from substituting real values.
    const result = spawnSync(process.execPath, ["-e", `
        try { require('./server/db'); process.exitCode = 1; }
        catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
    `], { cwd: require("node:path").resolve(__dirname, ".."), encoding: "utf8",
        env: { ...process.env, DB_USER: "", DB_PASSWORD: "" } });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { code: "DATABASE_NOT_CONFIGURED" });
    assert.equal(result.stderr, "");
});

test("unconfigured Employee access returns a safe configuration code and creates no authenticated session", async () => {
    const app = createApp({ getPool: () => { throw Object.assign(new Error("private configuration details"), { code: "DATABASE_NOT_CONFIGURED" }); },
        sessionSecret: "configuration-test-session-only", prototypeAccess: true });
    const agent = request.agent(app);
    const response = await agent.post("/api/prototype/employee-session").send({}).expect(503);
    assert.deepEqual(response.body, { code: "DATABASE_NOT_CONFIGURED", error: "Local access requires a configured PostgreSQL connection." });
    assert.equal(response.headers["set-cookie"], undefined);
    for (const endpoint of ["/api/employee/me", "/api/employee/history", "/api/manager/overview", "/api/hr/overview"])
        await agent.get(endpoint).expect(401);
});

test("Employee client distinguishes missing configuration without displaying arbitrary backend errors", async () => {
    const { createEmployeeApi } = await import("../public/js/employee-api.mjs");
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async () => ({ ok: false, status: 503,
            json: async () => ({ code: "DATABASE_NOT_CONFIGURED", error: "private SQL password=must-not-leak" }) });
        const api = createEmployeeApi("postgres");
        await assert.rejects(api.startPrototypeSession(), (error) => error.status === 503
            && error.message === "Demo access requires a configured PostgreSQL connection.");
        globalThis.fetch = async () => ({ ok: false, status: 503,
            json: async () => ({ code: "UNKNOWN", error: "private SQL password=must-not-leak" }) });
        await assert.rejects(api.startPrototypeSession(), (error) => error.status === 503
            && error.message === "Employee demo access is unavailable. Please try again.");
    } finally { globalThis.fetch = original; }
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");
const session = require("express-session");
const request = require("supertest");
const { readApplicationConfig, readDatabaseConfig } = require("../server/config");
const { createApp } = require("../server/app");
const root = path.resolve(__dirname, "..");
const database = { DB_HOST: "db.example.invalid", DB_PORT: "6432", DB_NAME: "configured_database",
    DB_USER: "fictional_test_user", DB_PASSWORD: "test-only-not-a-real-password" };
const child = (overrides, args = [path.join(root, "server/app.js")]) => spawnSync(process.execPath, args, {
    cwd: require("node:os").tmpdir(), encoding: "utf8", timeout: 15000,
    env: { ...process.env, NODE_ENV: "test", ENABLE_PROTOTYPE_ACCESS: "true", DEMO_AUTH_ENABLED: "false", MIN_RESPONSES: "5", ...overrides }
});
const portServer = async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
};

test("database configuration is explicit, validates each required field and never falls back to local credentials", () => {
    const config = readDatabaseConfig(database);
    assert.equal(config.host, database.DB_HOST); assert.equal(config.port, 6432);
    assert.equal(config.database, database.DB_NAME); assert.equal(config.user, database.DB_USER);
    assert.equal(config.password, database.DB_PASSWORD); assert.equal(config.max, 5); assert.equal(config.ssl, false);
    for (const key of Object.keys(database)) assert.throws(() => readDatabaseConfig({ ...database, [key]: "" }), (e) =>
        e.code === "DATABASE_NOT_CONFIGURED" && e.message.includes(key) && !e.message.includes(database.DB_PASSWORD));
    for (const extra of [{ DB_PORT: "0" }, { DB_PORT: "65536" }, { DB_PORT: "0x1538" }, { DB_PORT: "abc" },
        { DB_POOL_MAX: "0" }, { DB_POOL_MAX: "101" }, { DB_SSL: "yes" }, { DB_SSL_CA_FILE: "missing.pem" }])
        assert.throws(() => readDatabaseConfig({ ...database, ...extra }), { code: "DATABASE_CONFIGURATION_INVALID" });
    const tls = readDatabaseConfig({ ...database, DB_SSL: "true", DB_POOL_MAX: "8" });
    assert.deepEqual(tls.ssl, { rejectUnauthorized: true }); assert.equal(tls.max, 8);
    assert.throws(() => readDatabaseConfig({ ...database, DB_SSL: "true", DB_SSL_CA_FILE: "missing-certificate-for-test.pem" }), /DB_SSL_CA_FILE could not be read/);
});

test("runtime defaults preserve port 3000; injected binding, mode and explicit proxy settings override defaults", () => {
    const local = readApplicationConfig({});
    assert.equal(local.port, 3000); assert.equal(local.host, "127.0.0.1"); assert.equal(local.prototypeAccess, false);
    const external = readApplicationConfig({ NODE_ENV: "production", HOST: "0.0.0.0", PORT: "8080", ENABLE_PROTOTYPE_ACCESS: "false", TRUST_PROXY: "127.0.0.1,::1/128" });
    assert.equal(external.port, 8080); assert.equal(external.host, "0.0.0.0"); assert.equal(external.prototypeAccess, false);
    assert.deepEqual(external.trustProxy, ["127.0.0.1", "::1/128"]);
    assert.equal(readApplicationConfig({ TRUST_PROXY: "1" }).trustProxy, 1);
    for (const env of [{ PORT: "abc" }, { PORT: "0" }, { NODE_ENV: "prod" }, { HOST: "http://localhost" }, { HOST: "localhost:3000" },
        { ENABLE_PROTOTYPE_ACCESS: "yes" }, { NODE_ENV: "production", ENABLE_PROTOTYPE_ACCESS: "true" },
        { TRUST_PROXY: "true" }, { TRUST_PROXY: "2" }, { TRUST_PROXY: "-1" }, { TRUST_PROXY: "1.0" },
        { TRUST_PROXY: "127.0.0.1/99" }, { TRUST_PROXY: "" }])
        assert.throws(() => readApplicationConfig(env), { code: "CONFIGURATION_INVALID" });
});

test("production requires a persistent session store and strong secret; prototype entry stays closed", async () => {
    const keys = ["NODE_ENV", "ENABLE_PROTOTYPE_ACCESS", "DEMO_AUTH_ENABLED", "SESSION_SECRET"], previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
        process.env.NODE_ENV = "production"; process.env.ENABLE_PROTOTYPE_ACCESS = "false"; process.env.DEMO_AUTH_ENABLED = "false"; process.env.SESSION_SECRET = "";
        assert.throws(() => createApp(), /SESSION_SECRET/);
        await assert.rejects(require("../db/manage.cjs").run({ connect() { throw Error("Production seed must not connect"); } }, "seed-demo"),
            { code: "SETUP_PRECONDITION" });
        process.env.SESSION_SECRET = require("node:crypto").randomBytes(32).toString("hex");
        assert.throws(() => createApp(), /persistent sessionStore/);
        assert.throws(() => createApp({ sessionStore: new session.MemoryStore() }), /persistent sessionStore/);
        class ExternalStore extends session.Store { get(id, cb) { cb(null, null); } set(id, value, cb) { cb(); } destroy(id, cb) { cb(); } }
        const app = createApp({ sessionStore: new ExternalStore(), prototypeAccess: true,
            getPool: () => { throw Error("An unauthenticated request must not reach PostgreSQL"); } });
        for (const role of ["employee", "manager", "hr"]) await request(app).post(`/api/prototype/${role}-session`).send({}).expect(403);
        for (const endpoint of ["/api/employee/history", "/api/manager/overview", "/api/hr/overview"]) await request(app).get(endpoint).expect(401);
        const health = await request(app).get("/api/health").expect(200);
        assert.equal(health.headers["x-powered-by"], undefined);
        assert.deepEqual(health.body, { status: "ok", message: "TeamPulse API is running" });
    } finally { for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; }
});

test("startup fails with actionable configuration errors without exposing values", () => {
    for (const [extra, text] of [[{ DB_USER: "", DB_PASSWORD: "" }, "DB_USER"], [{ PORT: "invalid" }, "PORT"], [{ MIN_RESPONSES: "" }, "MIN_RESPONSES"]]) {
        const result = child({ ...database, ...extra });
        assert.equal(result.status, 1); assert(result.stderr.includes(text));
        assert(!result.stderr.includes(database.DB_PASSWORD)); assert(!result.stderr.includes(database.DB_USER));
        assert.equal(result.stdout, "");
    }
});

test("an unreachable PostgreSQL server fails safely without driver diagnostics or credentials", async () => {
    const server = await portServer(), port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const result = child({ ...database, DB_HOST: "127.0.0.1", DB_PORT: String(port) });
    assert.equal(result.status, 1); assert(result.stderr.includes("Startup could not connect to PostgreSQL"));
    for (const privateValue of [database.DB_PASSWORD, database.DB_USER, "ECONNREFUSED", " at "]) assert(!result.stderr.includes(privateValue));
});

test("PostgreSQL: startup works outside the repository with injected port; occupied port fails clearly", {
    skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1 for a SELECT-only startup check." : false
}, async () => {
    const reserved = await portServer(), port = reserved.address().port;
    try {
        const failed = child({ HOST: "127.0.0.1", PORT: String(port) });
        assert.equal(failed.status, 1); assert(failed.stderr.includes("Cannot bind HOST/PORT"));
    } finally { await new Promise((resolve) => reserved.close(resolve)); }
    const started = child({ HOST: "127.0.0.1", PORT: String(port) }, ["-e", `
        require(${JSON.stringify(path.join(root, "server/start.js"))}).startServer().then(async r=>{
            console.log(JSON.stringify(r.server.address()));await r.stop();
        }).catch(()=>{process.exitCode=1});`]);
    assert.equal(started.status, 0, started.stderr);
    const address = JSON.parse(started.stdout); assert.equal(address.port, port); assert.equal(address.address, "127.0.0.1");
});

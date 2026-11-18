const path = require("node:path");
const fs = require("node:fs");
const { isIP } = require("node:net");

// Consistent from any working directory. Injected environment values win;
// .env is optional and is never printed or copied into a public directory.
require("dotenv").config({ path: path.resolve(__dirname, "../.env"), quiet: true });
const invalid = (message, code = "CONFIGURATION_INVALID") => Object.assign(new Error(message), { code });
function integer(env, key, fallback, max = 65535) {
    const value = env[key] ?? String(fallback);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max)
        throw invalid(`${key} must be an integer between 1 and ${max}.`);
    return Number(value);
}
function boolean(env, key, fallback) {
    if (env[key] === undefined) return fallback;
    if (!["true", "false"].includes(env[key])) throw invalid(`${key} must be true or false.`);
    return env[key] === "true";
}
function readApplicationConfig(env = process.env) {
    const mode = env.NODE_ENV ?? "development";
    if (!["development", "test", "production"].includes(mode)) throw invalid("NODE_ENV must be development, test or production.");
    const host = env.HOST ?? "127.0.0.1";
    if (!isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)) throw invalid("HOST must be a hostname or IP address, without a protocol or port.");
    // Remote demo access is opt-in, including when NODE_ENV was not supplied.
    const demoAuthEnabled = boolean(env, "DEMO_AUTH_ENABLED", false);
    const legacyPrototype = boolean(env, "ENABLE_PROTOTYPE_ACCESS", false);
    // Preserve the old local-only entry when the new flag is absent. Explicit
    // false disables every demo entry; the legacy flag cannot override it.
    const prototypeAccess = env.DEMO_AUTH_ENABLED === undefined && legacyPrototype;
    if (mode === "production" && prototypeAccess) throw invalid("ENABLE_PROTOTYPE_ACCESS must be false in production.");
    const proxy = env.TRUST_PROXY;
    let trustProxy = false;
    // Explicit opt-in for a managed ingress that overwrites forwarded headers
    // and is the only route to this listener. Trust only the immediate peer;
    // never enable blanket trust or infer it from NODE_ENV/platform variables.
    if (proxy === "1") trustProxy = 1;
    else if (proxy !== undefined && proxy !== "false") {
        const addresses = proxy.split(",").map((s) => s.trim());
        if (addresses.some((address) => {
            if (["loopback", "linklocal", "uniquelocal"].includes(address)) return false;
            const [ip, bits, extra] = address.split("/");
            const version = isIP(ip);
            return !version || extra !== undefined || bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) > (version === 4 ? 32 : 128));
        })) throw invalid("TRUST_PROXY must be false, 1 (immediate managed proxy only), or an explicit comma-separated list of trusted IPs/CIDRs or Express subnet names.");
        trustProxy = addresses;
    }
    return { mode, host, port: integer(env, "PORT", 3000), prototypeAccess, demoAuthEnabled, trustProxy, sessionSecret: env.SESSION_SECRET };
}
function readDatabaseConfig(env = process.env) {
    const missing = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"].filter((key) => !env[key] || key !== "DB_PASSWORD" && !env[key].trim());
    if (missing.length) throw invalid(`Missing database configuration: ${missing.join(", ")}. Set these values in .env or the server environment.`, "DATABASE_NOT_CONFIGURED");
    let port, max, ssl;
    try {
        port = integer(env, "DB_PORT", undefined);
        max = integer(env, "DB_POOL_MAX", 5, 100);
        const enabled = boolean(env, "DB_SSL", false);
        if (env.DB_SSL_CA_FILE && !enabled) throw invalid("DB_SSL_CA_FILE requires DB_SSL=true.");
        ssl = enabled ? { rejectUnauthorized: true } : false;
        if (enabled && env.DB_SSL_CA_FILE) {
            try { ssl.ca = fs.readFileSync(path.resolve(__dirname, "..", env.DB_SSL_CA_FILE), "utf8"); }
            catch { throw invalid("DB_SSL_CA_FILE could not be read. Provide a readable PostgreSQL CA certificate file."); }
        }
    } catch (error) { error.code = "DATABASE_CONFIGURATION_INVALID"; throw error; }
    return { host: env.DB_HOST, port, database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD,
        max, ssl, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000 };
}
module.exports = { readApplicationConfig, readDatabaseConfig };

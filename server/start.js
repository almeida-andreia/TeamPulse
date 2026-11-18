const { readApplicationConfig } = require("./config");

async function startServer(options) {
    const config = readApplicationConfig();
    const { configuredMinimum } = require("./reporting");
    if (configuredMinimum(process.env.MIN_RESPONSES) === null)
        throw Object.assign(new Error("Set MIN_RESPONSES to a valid integer of at least 2; the approved demo uses 5."), { code: "CONFIGURATION_INVALID" });
    const { createApp } = require("./app");
    const app = createApp(options); // Trusted bootstrap may supply a session store.
    const { pool, testConnection } = require("./db");
    let server;
    try {
        await testConnection(); // SELECT only. Never seed or migrate on startup.
        server = await new Promise((resolve, reject) => {
            const listener = app.listen(config.port, config.host, (error) => error ? reject(error) : resolve(listener));
            listener.once("error", reject);
        });
    } catch (error) { await pool.end(); throw error; }
    let stopping;
    const stop = () => stopping ??= (async () => {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await pool.end();
    })();
    return { server, stop, config };
}
async function main() {
    try {
        const running = await startServer();
        console.log(`TeamPulse listening on ${running.config.host}:${running.config.port} (${running.config.mode})`);
        for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
            running.stop().catch(() => { console.error("TeamPulse shutdown failed."); process.exitCode = 1; });
        });
    } catch (error) {
        const message = ["CONFIGURATION_INVALID", "DATABASE_NOT_CONFIGURED", "DATABASE_CONFIGURATION_INVALID"].includes(error.code)
            ? error.message : ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes(error.code)
                ? "Cannot bind HOST/PORT. Check address configuration, permissions and whether the port is already in use."
                : "Startup could not connect to PostgreSQL. Check DB_* settings, server availability and TLS configuration.";
        console.error(`TeamPulse startup failed: ${message}`);
        process.exitCode = 1;
    }
}
module.exports = { startServer, main };

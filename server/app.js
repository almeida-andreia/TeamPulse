const { readApplicationConfig } = require("./config");

const express = require("express");
const path = require("path");
const { installEmployeeRoutes } = require("./employee-routes");

function createApp(options) {
    const app = express();
    const config = readApplicationConfig();
    app.set("trust proxy", config.trustProxy);
    app.disable("x-powered-by");

    // Middleware
    app.use(express.json({ limit: "16kb" }));

    // Serve the frontend files from /public
    app.use(express.static(path.join(__dirname, "../public")));

    // Basic health check
    app.get("/api/health", (req, res) => {
        res.json({
            status: "ok",
            message: "TeamPulse API is running"
        });
    });

    // Read-only database health check
    app.get("/api/health/db", async (req, res) => {
        res.set("Cache-Control", "no-store");

        try {
            // Let frontend development run before database credentials are available.
            // Load the connection layer only when this endpoint is explicitly used.
            const { testConnection } = require("./db");
            const connection = await testConnection();

            res.json({
                status: "ok",
                message: "Database connection is working",
                ...(config.mode === "production" ? {} : { database: connection.database, user: connection.user })
            });
        } catch {
            // Do not expose raw errors, connection configuration, or credentials.
            console.error("Database health check failed.");
            res.status(503).json({
                status: "error",
                message: "Database connection is unavailable"
            });
        }
    });

    installEmployeeRoutes(app, options);
    return app;
}

// Importable without opening a listener for API tests.
module.exports = { createApp };
if (require.main === module) {
    require("./start").main();
}

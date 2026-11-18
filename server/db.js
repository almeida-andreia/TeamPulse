const { Pool } = require("pg");
const { readDatabaseConfig } = require("./config");

// One shared, lazily connected pool for this local application process.
const pool = new Pool(readDatabaseConfig());

// Idle clients can fail outside a request. Handle that event without printing
// connection options, credentials, or raw driver errors.
pool.on("error", () => {
    console.error("An idle PostgreSQL connection failed; the pool will replace it when needed.");
});

// Read-only check. pool.query acquires and releases its connection automatically.
// Query failures reject this promise so callers can handle them appropriately.
async function testConnection() {
    const result = await pool.query("SELECT current_database(), current_user");

    return {
        database: result.rows[0].current_database,
        user: result.rows[0].current_user
    };
}

module.exports = { pool, testConnection };

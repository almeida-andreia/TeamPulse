// Test-only clock and disposable PostgreSQL database. Never resets/reseeds the
// configured demo. No production clock hooks or environment overrides are added.
const { Pool, Client } = require("pg");
const { randomUUID } = require("node:crypto");
const { mock } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readDatabaseConfig } = require("../../server/config");
const AS_OF = "2026-11-13T12:00:00.000Z"; // Friday, Lisbon; fixture anchor is Monday 9 Nov.
function fixedSql(sql) {
    return sql.replace(/\bCURRENT_TIMESTAMP\b/gi, `TIMESTAMPTZ '${AS_OF}'`)
        .replace(/\bclock_timestamp\s*\(\s*\)/gi, `TIMESTAMPTZ '${AS_OF}'`);
}
class TestClient extends Client {
    query(sql, ...args) {
        return super.query(typeof sql === "string" ? fixedSql(sql) : { ...sql, text: fixedSql(sql.text) }, ...args);
    }
}
async function isolatedDatabase() {
    const config = readDatabaseConfig();
    const name = `teampulse_test_${randomUUID().replaceAll("-", "")}`;
    if (!/^teampulse_test_[a-f0-9]{32}$/.test(name) || name === config.database) throw Error("Unsafe test database name");
    const admin = new Pool(config);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "teampulse-test-"));
    const tempDirectory = mock.method(os, "tmpdir", () => scratch);
    const cleanupFiles = () => {
        tempDirectory.mock.restore();
        if (!path.isAbsolute(scratch) || !path.basename(scratch).startsWith("teampulse-test-")) throw Error("Unsafe test scratch path");
        fs.rmSync(scratch, { recursive: true, force: true });
    };
    let pool, created = false;
    try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
        mock.timers.enable({ apis: ["Date"], now: new Date(AS_OF).getTime() });
        pool = new Pool({ ...config, database: name, Client: TestClient });
        // Schema defaults AND trigger bodies receive the same fixed instant as
        // application queries. Only the disposable database is affected.
        const { run } = require("../../db/manage.cjs");
        await run(pool, "init");
        await run(pool, "seed-demo");
        // Expansion writes a private preservation snapshot using Date.now().
        // Advance only one millisecond so its subsequent dry-run has a distinct
        // filename; every calendar/SQL boundary is still the fixed test instant.
        mock.timers.tick(1);
        const end = pool.end.bind(pool);
        pool.end = async () => {
            try { await end(); }
            finally {
                try { await admin.query(`DROP DATABASE "${name}"`); }
                finally { mock.timers.reset(); cleanupFiles(); await admin.end(); }
            }
        };
        return pool;
    } catch (error) {
        if (pool) await pool.end();
        try { if (created) await admin.query(`DROP DATABASE "${name}"`); }
        finally { mock.timers.reset(); cleanupFiles(); await admin.end(); }
        throw error;
    }
}
module.exports = { isolatedDatabase, AS_OF, fixedSql };

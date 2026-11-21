const fs = require("node:fs");
const path = require("node:path");
const { readApplicationConfig } = require("../server/config");
const fail = (message) => Object.assign(new Error(message), { code: "SETUP_PRECONDITION" });
const schemas = ["identity", "wellbeing", "private", "operations"];

function validateCommand(command, { check = false, shared = false }) {
    if (!["init", "migrate", "seed-demo"].includes(command)
        || check && command !== "migrate" || shared && command !== "init")
        throw fail("Use init [--shared], migrate [--check], or seed-demo. --shared is only valid for init.");
}

function scriptBody(relative) {
    const sql = fs.readFileSync(path.join(__dirname, relative), "utf8");
    // Own the transaction in this runner. Do not split SQL at semicolons:
    // functions/DO blocks contain their own statements and dollar quoting.
    if ((sql.match(/^BEGIN;[ \t]*\r?$/gm) ?? []).length !== 1 || (sql.match(/^COMMIT;[ \t]*\r?$/gm) ?? []).length !== 1)
        throw fail(`Expected one outer transaction in ${relative}; inspect the script before running it.`);
    return sql.replace(/^BEGIN;[ \t]*\r?$/m, "").replace(/^COMMIT;[ \t]*\r?$/m, "");
}
async function migrations(db) {
    const { rows } = await db.query(`SELECT table_schema,table_name,column_name,is_nullable FROM information_schema.columns
        WHERE table_schema=ANY($1::text[])`, [schemas]);
    const column = (schema, table, name) => rows.find((r) => r.table_schema === schema && r.table_name === table && r.column_name === name);
    if (!column("wellbeing", "wellbeing_responses", "stress_score"))
        throw fail("The five-score base schema is required. Use db:init only on an empty database; review older questionnaire upgrades separately, without backfilling stress.");
    const pending = [];
    if (!column("operations", "team_actions", "description") || column("operations", "team_actions", "insight_week_start")?.is_nullable !== "YES")
        pending.push("20261111_manager_action_plans.sql");
    const fields = ["department_id", "related_area", "source_week_start", "source_value", "source_change"];
    const present = fields.filter((field) => column("operations", "activities", field));
    if (present.length && present.length !== fields.length) throw fail("Partial activity migration detected. Inspect the existing schema; automatic repair is not safe.");
    if (!present.length) pending.push("20261111_activity_insights.sql");
    if (!pending.length) {
        const { rows: constraints } = await db.query(`SELECT conname FROM pg_constraint WHERE conrelid IN
            ('operations.team_actions'::regclass,'operations.activities'::regclass)`);
        for (const name of ["team_actions_description_check", "activities_insight_source_check"])
            if (!constraints.some((c) => c.conname === name)) throw fail(`Missing ${name}; inspect the partially upgraded schema.`);
    }
    return pending;
}
// The existing services retain transactions and authorization. Nest only their
// transaction boundaries in the seed's outer atomic transaction.
function nestedPool(client) {
    let sequence = 0;
    return { query: (...args) => client.query(...args), async connect() {
        const savepoint = `demo_setup_${++sequence}`;
        return { async query(sql, args) {
            if (sql === "BEGIN") return client.query(`SAVEPOINT ${savepoint}`);
            if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT ${savepoint}`);
            if (sql === "ROLLBACK") { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); return client.query(`RELEASE SAVEPOINT ${savepoint}`); }
            return client.query(sql, args);
        }, release() {} };
    } };
}
async function demoCatalogue(db, anchor) {
    const { createReporting } = require("../server/reporting");
    const { createHrActivities } = require("../server/hr-activities");
    const { createTeamActions } = require("../server/team-actions");
    const reporting = createReporting(() => db), activities = createHrActivities(() => db);
    const hr = await reporting.prototypeAccount("hr"), manager = await reporting.prototypeAccount("manager");
    const catalogue = await activities.list(hr);
    const date = (offset) => { const value = new Date(`${anchor}T14:00:00Z`); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString(); };
    for (const department of catalogue.departments) {
        const source = catalogue.insights.find((i) => i.departmentId === department.id && i.area === "workloadBalance")
            ?? catalogue.insights.find((i) => i.departmentId === department.id);
        if (!source) throw fail(`The fictional ${department.name} fixture has no safe adverse source; inspect the demo rather than inventing one.`);
        await activities.create(hr, { departmentId: department.id, area: source.area, sourceWeek: source.sourceWeek,
            title: department.name === "Engineering" ? "Engineering shared priorities workshop" : `${department.name} communication workshop`,
            description: "Fictional demo activity: a facilitated workshop to coordinate shared priorities and supportive team practices.",
            type: "workshop", startsAt: date(35), duration: 45, format: "online", audience: "department",
            publication: department.name === "People and Operations" ? "draft" : "published" });
    }
    const team = (await reporting.overview("manager", manager)).teams.find((t) => t.name === "Platform");
    const area = ["workloadBalance", "wellbeing", "teamIntegration", "psychologicalSafety"].find((key) => Number.isFinite(team?.scores?.[key]) && team.monthlyChange?.[key] < 0);
    if (!area) throw fail("The Platform demo has no safe adverse source for its example action plan.");
    await createTeamActions(() => db).create(manager, { teamId: team.teamId, sourceWeek: team.weekStart, area,
        title: "Agree next-cycle Platform capacity", description: "Fictional demo action: review shared commitments and agree sustainable next-cycle capacity.",
        owner: "team_manager", targetDate: date(25).slice(0, 10), status: "completed" });
}
async function run(pool, command, { check = false, shared = false } = {}) {
    validateCommand(command, { check, shared });
    if (command === "seed-demo" && readApplicationConfig().mode === "production") throw fail("Demo seeding is forbidden in production.");
    const client = await pool.connect(); let begun = false;
    try {
        if (command === "migrate" && check) {
            const pending = await migrations(client);
            if (pending.length) throw fail(`Pending migrations: ${pending.join(", ")}. Review them, then run npm run db:migrate.`);
            return { status: "current", migrations: [] };
        }
        await client.query("BEGIN"); begun = true;
        // Shared schemas may be writable by other projects. Resolve built-ins
        // only through trusted namespaces while initializing; restore on commit.
        if (shared) await client.query("SET LOCAL search_path = pg_catalog, pg_temp");
        await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('teampulse-schema-setup'))");
        if (command === "init") {
            // Catalog visibility does not depend on USAGE/ownership, unlike
            // information_schema. Never reuse even an empty target namespace.
            const { rows } = await client.query(`SELECT nspname FROM pg_catalog.pg_namespace
                WHERE nspname=ANY($1::text[]) ORDER BY nspname`, [schemas]);
            if (rows.length) throw fail(`TeamPulse target schemas already exist: ${rows.map((row) => row.nspname).join(", ")}. Initialization will not reuse or change them.`);
            if (!shared) {
                const { rows: tables } = await client.query(`SELECT table_name FROM information_schema.tables
                    WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_%'`);
                if (tables.length) throw fail("db:init requires an empty dedicated database. Existing schemas/data will not be reset or overwritten.");
            }
            await client.query(scriptBody("schema.sql"));
        } else if (command === "migrate") {
            for (const filename of await migrations(client)) await client.query(scriptBody(`migrations/${filename}`));
            if ((await migrations(client)).length) throw fail("Migration verification failed.");
        } else {
            if ((await migrations(client)).length) throw fail("Apply the pending feature migrations before seeding.");
            const { rows: tables } = await client.query(`SELECT table_schema,table_name FROM information_schema.tables
                WHERE table_schema=ANY($1::text[]) AND table_type='BASE TABLE'`, [schemas]);
            for (const { table_schema: schema, table_name: table } of tables) {
                if (!/^[a-z_]+$/.test(table)) throw fail("Unexpected table name; inspect the database.");
                if ((await client.query(`SELECT 1 FROM "${schema}"."${table}" LIMIT 1`)).rows.length)
                    throw fail("Demo seed requires empty TeamPulse tables. Existing records will not be overwritten or duplicated.");
            }
            if (process.env.MIN_RESPONSES !== "5") throw fail("The approved synthetic demo requires MIN_RESPONSES=5; setup will not change it.");
            await client.query(scriptBody("seed.sql"));
            await client.query("SET CONSTRAINTS ALL DEFERRED");
            const db = nestedPool(client);
            const expansion = await require("./expand-demo.cjs").expandDemo(db, { apply: true });
            await demoCatalogue(db, expansion.anchor);
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        }
        await client.query("COMMIT"); begun = false;
        return { status: "complete", command, ...(shared ? { shared: true } : {}) };
    } catch (error) { if (begun) await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
}
if (require.main === module) {
    let pool;
    (async () => {
        try {
            const [command, ...flags] = process.argv.slice(2);
            if (flags.some((flag) => !["--check", "--shared"].includes(flag))) throw fail("Unknown setup option.");
            const options = { check: flags.includes("--check"), shared: flags.includes("--shared") };
            validateCommand(command, options); // Reject invalid flags before loading a database pool.
            pool = require("../server/db").pool;
            console.log(JSON.stringify(await run(pool, command, options)));
        } catch (error) {
            console.error(["SETUP_PRECONDITION", "DATABASE_NOT_CONFIGURED", "DATABASE_CONFIGURATION_INVALID", "CONFIGURATION_INVALID"].includes(error.code)
                ? error.message : "Database setup failed and was rolled back. Check DB_* configuration, PostgreSQL version, schema prerequisites and DDL permissions.");
            process.exitCode = 1;
        } finally { if (pool) await pool.end(); }
    })();
}
module.exports = { run, scriptBody, migrations };

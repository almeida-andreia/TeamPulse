const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { Pool } = require("pg");
const { readDatabaseConfig } = require("../server/config");
const { run } = require("../db/manage.cjs");

const schemas = ["identity", "operations", "private", "wellbeing"];
const postgres = { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1"
    ? "Set TEAMPULSE_TEST_POSTGRES=1 for disposable local initialization tests." : false };
const script = path.resolve(__dirname, "../db/manage.cjs");

// Never initialize, seed or even connect to the configured demo/FEUP database.
// Only a local maintenance connection and newly generated test databases are used.
async function disposable(work) {
    const config = readDatabaseConfig();
    assert(["localhost", "127.0.0.1", "::1"].includes(config.host), "Initialization tests require loopback PostgreSQL.");
    const name = `teampulse_test_${randomUUID().replaceAll("-", "")}`;
    assert.match(name, /^teampulse_test_[a-f0-9]{32}$/);
    assert.notEqual(name, config.database);
    const admin = new Pool({ ...config, database: "postgres" });
    let pool, created = false;
    try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created = true;
        pool = new Pool({ ...config, database: name });
        await work(pool, name);
    } finally {
        if (pool) await pool.end();
        try { if (created) await admin.query(`DROP DATABASE "${name}"`); }
        finally { await admin.end(); }
    }
}

async function targetSchemas(db) {
    return (await db.query(`SELECT nspname FROM pg_catalog.pg_namespace
        WHERE nspname=ANY($1::text[]) ORDER BY nspname`, [schemas])).rows.map((row) => row.nspname);
}

async function inventory(db) {
    const namespaces = (await db.query(`SELECT oid, nspname, nspowner, nspacl::text
        FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY nspname`)).rows;
    const relations = (await db.query(`SELECT c.oid, n.nspname, c.relname, c.relkind, c.relowner, c.relacl::text,
        CASE WHEN c.relkind='i' THEN pg_catalog.pg_get_indexdef(c.oid) END AS index_definition
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
        ORDER BY n.nspname,c.relname`)).rows;
    return { namespaces, relations };
}

async function unrelatedFixture(db) {
    // Deliberate table/index basename collisions with TeamPulse, in other schemas.
    await db.query(`CREATE TABLE public.users(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text NOT NULL);
        CREATE INDEX users_team_idx ON public.users(note);
        INSERT INTO public.users(note) VALUES ('Unrelated original row'), ('Keep this row');
        CREATE TABLE public.wellbeing_responses(id integer PRIMARY KEY, note text);
        INSERT INTO public.wellbeing_responses VALUES (7, 'Unrelated project data');
        CREATE SCHEMA unrelated_project;
        CREATE TABLE unrelated_project.items(id integer PRIMARY KEY, note text);
        INSERT INTO unrelated_project.items VALUES (9, 'Preserve another schema too');`);
}

async function unrelatedSnapshot(db) {
    const metadata = await inventory(db);
    return {
        namespaces: metadata.namespaces.filter((row) => !schemas.includes(row.nspname)),
        relations: metadata.relations.filter((row) => !schemas.includes(row.nspname)),
        users: (await db.query("SELECT * FROM public.users ORDER BY id")).rows,
        responses: (await db.query("SELECT * FROM public.wellbeing_responses ORDER BY id")).rows,
        items: (await db.query("SELECT * FROM unrelated_project.items ORDER BY id")).rows,
        sequence: (await db.query("SELECT last_value,is_called FROM public.users_id_seq")).rows
    };
}

function cli(args, extra = {}) {
    return spawnSync(process.execPath, [script, ...args], {
        cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 20000,
        env: { ...process.env, ...extra }
    });
}

test("shared initialization rejects unsupported flag combinations before connecting", async () => {
    const noConnection = { connect() { assert.fail("Invalid options must not connect."); } };
    for (const [command, options] of [["migrate", { shared: true }], ["seed-demo", { shared: true }],
        ["init", { shared: true, check: true }]]) {
        await assert.rejects(run(noConnection, command, options), { code: "SETUP_PRECONDITION" });
    }
    for (const args of [["migrate", "--shared"], ["seed-demo", "--shared"], ["init", "--shared", "--check"],
        ["init", "--unknown"]]) {
        const result = cli(args, { DB_HOST: "db.example.invalid", DB_USER: "", DB_PASSWORD: "" });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Use init|Unknown setup option/);
        assert.equal(result.stdout, "");
    }
});

test("PostgreSQL: ordinary fresh initialization creates the unchanged 15-table schema", postgres, async () => {
    await disposable(async (db) => {
        assert.deepEqual(await targetSchemas(db), []);
        assert.deepEqual(await run(db, "init"), { status: "complete", command: "init" });
        assert.deepEqual(await targetSchemas(db), schemas);
        const tables = (await db.query(`SELECT count(*)::int AS count FROM information_schema.tables
            WHERE table_schema=ANY($1::text[]) AND table_type='BASE TABLE'`, [schemas])).rows[0].count;
        assert.equal(tables, 15);
        assert.deepEqual(await run(db, "migrate", { check: true }), { status: "current", migrations: [] });
    });
});

test("PostgreSQL: explicit shared CLI initialization preserves unrelated rows, ownership, indexes and sequences", postgres, async () => {
    await disposable(async (db, name) => {
        await unrelatedFixture(db);
        const before = await unrelatedSnapshot(db);
        await assert.rejects(run(db, "init"), /empty dedicated database/);
        assert.deepEqual(await targetSchemas(db), []);
        assert.deepEqual(await unrelatedSnapshot(db), before);
        const result = cli(["init", "--shared"], { DB_NAME: name, NODE_ENV: "production" });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), { status: "complete", command: "init", shared: true });
        assert.deepEqual(await targetSchemas(db), schemas);
        assert.deepEqual(await unrelatedSnapshot(db), before);
        const { rows: tables } = await db.query(`SELECT table_schema,table_name FROM information_schema.tables
            WHERE table_schema=ANY($1::text[]) AND table_type='BASE TABLE'`, [schemas]);
        assert.equal(tables.length, 15);
        for (const table of tables) {
            const { rows } = await db.query(`SELECT count(*)::int AS count FROM "${table.table_schema}"."${table.table_name}"`);
            assert.equal(rows[0].count, 0, "Shared initialization must never seed data.");
        }
    });
});

for (const schema of schemas) {
    test(`PostgreSQL: existing ${schema} namespace refuses shared initialization without changes`, postgres, async () => {
        await disposable(async (db) => {
            await db.query(`CREATE SCHEMA "${schema}"`);
            const emptyNamespace = await inventory(db);
            await assert.rejects(run(db, "init", { shared: true }), { code: "SETUP_PRECONDITION" });
            assert.deepEqual(await inventory(db), emptyNamespace, "Even an empty occupied namespace must be preserved.");
            await db.query(`CREATE TABLE "${schema}".existing_data(id integer PRIMARY KEY, note text);
                INSERT INTO "${schema}".existing_data VALUES (1, 'Keep the occupied namespace');`);
            const before = await inventory(db);
            await assert.rejects(run(db, "init", { shared: true }), (error) =>
                error.code === "SETUP_PRECONDITION" && error.message.includes(schema));
            assert.deepEqual(await inventory(db), before);
            assert.deepEqual(await targetSchemas(db), [schema]);
            assert.deepEqual((await db.query(`SELECT * FROM "${schema}".existing_data`)).rows,
                [{ id: 1, note: "Keep the occupied namespace" }]);
        });
    });
}

test("PostgreSQL: a real failure after partial shared schema creation rolls back every TeamPulse namespace", postgres, async () => {
    await disposable(async (db) => {
        await unrelatedFixture(db);
        const before = await unrelatedSnapshot(db);
        const client = await db.connect();
        let reachedPartialSchema = false, released = false;
        const failingPool = { async connect() { return {
            async query(sql, args) {
                if (sql.includes("CREATE SCHEMA identity;")) {
                    const boundary = sql.indexOf("CREATE TABLE wellbeing.wellbeing_responses (");
                    assert(boundary > 0);
                    await client.query(sql.slice(0, boundary));
                    assert.deepEqual(await targetSchemas(client), schemas);
                    reachedPartialSchema = true;
                    // A real PostgreSQL DDL failure, solely inside this disposable
                    // transaction. No schema.sql mutation or production hook.
                    return client.query("CREATE TABLE operations.initialization_failure(value teampulse_missing_type)");
                }
                return client.query(sql, args);
            },
            release() { released = true; }
        }; } };
        try {
            await assert.rejects(run(failingPool, "init", { shared: true }), { code: "42704" });
            assert(reachedPartialSchema); assert(released);
            assert.deepEqual(await targetSchemas(client), []);
            assert.deepEqual(await unrelatedSnapshot(client), before);
        } finally { client.release(); }
    });
});

test("PostgreSQL: existing TeamPulse records survive repeated ordinary and shared initialization attempts", postgres, async () => {
    await disposable(async (db) => {
        await run(db, "init");
        await db.query("INSERT INTO identity.departments(name) VALUES ('Existing local-style fixture')");
        const before = await inventory(db);
        const records = (await db.query("SELECT * FROM identity.departments")).rows;
        for (const options of [{}, { shared: true }]) {
            await assert.rejects(run(db, "init", options), { code: "SETUP_PRECONDITION" });
            assert.deepEqual(await inventory(db), before);
            assert.deepEqual((await db.query("SELECT * FROM identity.departments")).rows, records);
        }
        assert.deepEqual(await run(db, "migrate", { check: true }), { status: "current", migrations: [] });
    });
});

// Local fictional dataset maintenance only; never imported by an API route.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const ISSUER = "https://demo-expansion.example.invalid";
const VERSION = "teampulse-demo-v1";
const GROUPS = [
    { team: "Platform", department: "Engineering", key: "platform", size: 6, attendance: [5, 6, 5, 5, 6, 5, 5, 6] },
    { team: "Product", department: "Engineering", key: "product", size: 6, attendance: [6, 5, 5, 6, 5, 5, 6, 5] },
    { team: "Customer Support", department: "Customer Experience", key: "customer", size: 8, attendance: [7, 6, 7, 6, 7, 6, 7, 7] },
    { team: "Internal Operations", department: "People and Operations", key: "operations", size: 8, attendance: [6, 7, 6, 7, 7, 7, 6, 7] }
];
const addDays = (day, days) => { const date = new Date(day + "T12:00:00Z"); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
function random(key) {
    let value = 2166136261;
    for (const char of VERSION + key) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
    value = Math.imul(value ^ value >>> 16, 2246822507);
    value = Math.imul(value ^ value >>> 13, 3266489909);
    return ((value ^ value >>> 16) >>> 0) / 4294967296;
}
async function buildDataset(currentWeek) {
    const { ANSWER_OPTIONS, normalizeCheckin } = await import("../public/js/checkin.mjs");
    const nearest = (key, value) => [...ANSWER_OPTIONS[key]].sort((a, b) => Math.abs(a.score - value) - Math.abs(b.score - value))[0].id;
    const rating = (value) => Math.max(1, Math.min(5, Math.round(value / 2.5) + 1));
    const trend = {
        workload: [3.8, 4.0, 4.2, 6.2, 7.1, 7.4, 7.0, 7.0], wellbeing: [8.1, 8.0, 7.9, 7.2, 6.5, 6.4, 6.6, 6.6],
        stress: [3.0, 3.2, 3.4, 5.4, 6.4, 6.6, 6.3, 6.0], connection: [7.8, 7.8, 7.7, 7.4, 7.2, 7.1, 7.3, 7.4],
        safety: [8.0, 7.9, 7.8, 7.4, 7.1, 7.0, 7.2, 7.1]
    };
    const people = [], entries = [];
    for (const group of GROUPS) for (let person = 0; person < group.size; person++) {
        const subject = `${VERSION}-${group.key}-${String(person + 1).padStart(2, "0")}`;
        people.push({ subject, team: group.team, department: group.department, name: `Demo ${group.team} ${String(person + 1).padStart(2, "0")} (fictional)` });
        for (let week = 0; week < 8; week++) {
            const entry = { subject, team: group.team, week: addDays(currentWeek, (week - 8) * 7), submitted: (person + week) % group.size < group.attendance[week] };
            if (entry.submitted) {
                const noise = (measure, width = 1.5) => (random(`${subject}/${week}/${measure}`) * 2 - 1) * width;
                const individual = (random(subject) * 2 - 1) * 0.5;
                const engineering = group.department === "Engineering", customer = group.key === "customer", operations = group.key === "operations";
                const pressure = trend.workload[week] + (engineering ? 0.7 : operations ? -0.6 : 0.1) + individual + noise("pressure");
                const connection = trend.connection[week] + (customer ? -0.6 : operations ? 0.1 : 0) + noise("connection");
                const safety = trend.safety[week] + (operations ? 0.2 : customer ? -0.2 : 0) + noise("safety");
                const stress = trend.stress[week] + (engineering ? 0.5 : operations ? -0.3 : 0.3)
                    + 0.15 * (pressure - trend.workload[week]) - 0.1 * (connection - 7.5) + noise("stress", 1.7);
                const wellbeing = trend.wellbeing[week] - 0.12 * (pressure - trend.workload[week]) + 0.1 * (safety - 7.5) + noise("wellbeing", 1.4);
                const probabilities = [
                    ["workload", engineering ? 0.48 : operations ? 0.28 : 0.34], ["deadlines", engineering ? 0.42 : 0.25],
                    ["communication", customer ? 0.43 : 0.30], ["difficulty_integrating", 0.22],
                    ["unclear_priorities", operations ? 0.35 : 0.28], ["limited_support", customer ? 0.30 : 0.24],
                    ["work_life_balance", customer ? 0.43 : 0.32], ["organizational_changes", operations ? 0.30 : 0.22]
                ];
                // Rotating opportunities plus independent offsets give each
                // small fictional team diverse selectors across the period.
                const challenges = probabilities.filter(([code, prevalence], index) => {
                    const phase = ["workload", "deadlines"].includes(code) && week >= 3 && week <= 5 ? 0.07 : 0;
                    const sample = ((week * 3 + person + index * 2) % 8 + random(`${subject}/${code}`) * 0.7) / 8;
                    return sample < prevalence + phase;
                }).map(([code]) => code);
                const raw = { wellbeing: nearest("wellbeing", wellbeing), workload: nearest("workload", pressure),
                    teamIntegration: nearest("teamIntegration", connection), stress: rating(stress), psychologicalSafety: rating(safety), challenges,
                    comment: random(subject + week + "/comment") < 0.16 ? "Fictional demo reflection: clearer priorities and time to connect would help this week." : "" };
                entry.scores = normalizeCheckin(raw);
            }
            entries.push(entry);
        }
    }
    return { version: VERSION, currentWeek, people, entries };
}

async function captureSnapshot(db) {
    const tables = (await db.query(`SELECT table_schema,table_name FROM information_schema.tables
        WHERE table_type='BASE TABLE' AND table_schema IN ('identity','wellbeing','private','operations') ORDER BY table_schema,table_name`)).rows;
    const snapshot = { capturedAt: new Date().toISOString(), tables: {}, functions: {} };
    for (const { table_schema: schema, table_name: table } of tables) {
        assert(/^[a-z_]+$/.test(schema) && /^[a-z_]+$/.test(table));
        snapshot.tables[`${schema}.${table}`] = (await db.query(`SELECT to_jsonb(t) AS row FROM "${schema}"."${table}" t ORDER BY to_jsonb(t)::text`)).rows.map((r) => r.row);
    }
    snapshot.definitions = (await db.query(`SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p
        WHERE p.pronamespace IN ('identity'::regnamespace,'wellbeing'::regnamespace,'private'::regnamespace,'operations'::regnamespace) ORDER BY p.oid`)).rows;
    for (const name of ["wellbeing.protect_response", "private.protect_weekly_checkin"])
        snapshot.functions[name] = (await db.query("SELECT pg_get_functiondef($1::regproc) AS definition", [name])).rows[0].definition;
    return snapshot;
}
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
function verifyPreserved(before, after) {
    const additive = ["identity.users", "private.employee_weekly_checkins", "wellbeing.wellbeing_responses", "wellbeing.response_challenges"];
    for (const [table, original] of Object.entries(before.tables)) {
        const current = new Set(after.tables[table].map(canonical));
        assert(original.every((row) => current.has(canonical(row))), `Existing records changed in ${table}`);
        if (!additive.includes(table)) assert.equal(current.size, original.length, `Unrelated records changed in ${table}`);
    }
    assert.deepEqual(after.functions, before.functions, "Original trigger functions must be restored before commit");
    if (before.definitions) assert.deepEqual(after.definitions, before.definitions, "No persistent function changes are permitted");
}

function verifyDataset(snapshot, plan, subjects, teams) {
    const responses = new Map(snapshot.tables["wellbeing.wellbeing_responses"].map((row) => [row.response_id, row]));
    const factors = new Map(snapshot.tables["wellbeing.challenge_factors"].map((row) => [row.challenge_factor_id, row.code]));
    const columns = { wellbeing: "wellbeing_score", workload: "workload_score", stress: "stress_score",
        teamIntegration: "team_integration_score", psychologicalSafety: "psychological_safety_score" };
    for (const entry of plan.entries) {
        const link = snapshot.tables["private.employee_weekly_checkins"].find((row) => row.user_id === subjects.get(entry.subject) && row.week_start === entry.week);
        assert(link && link.team_id === teams.get(entry.team), "Synthetic eligibility snapshot does not match this dataset version");
        if (!entry.submitted) { assert.equal(link.response_id, null); continue; }
        const response = responses.get(link.response_id); assert(response, "Synthetic response is missing");
        for (const [key, column] of Object.entries(columns)) assert.equal(Number(response[column]), entry.scores[key], `Synthetic ${column} differs from the reproducible plan`);
        assert.equal(response.comment, entry.scores.comment || null);
        const choices = snapshot.tables["wellbeing.response_challenges"].filter((row) => row.response_id === response.response_id).map((row) => factors.get(row.challenge_factor_id)).sort();
        assert.deepEqual(choices, [...entry.scores.challenges].sort());
    }
}

async function demoReport(db) {
    const { createReporting } = require("../server/reporting");
    const reporting = createReporting(() => db, { minimumResponses: 5 });
    const hr = await reporting.overview("hr", await reporting.prototypeAccount("hr"));
    const managers = (await db.query("SELECT user_id FROM identity.users WHERE role='manager' AND is_active ORDER BY user_id")).rows;
    const teams = [];
    for (const manager of managers) teams.push(...(await reporting.overview("manager", manager.user_id)).teams);
    for (const scope of [hr, ...hr.departments, ...teams]) {
        assert(scope.available && scope.participationAvailability?.available !== false, `Demo reporting unavailable: ${scope.name ?? "organization"}`);
        for (const key of ["wellbeing", "workloadBalance", "teamIntegration", "psychologicalSafety", "stress"])
            assert(Number.isFinite(scope.scores[key]) && scope.weeks.every((week) => Number.isFinite(week.scores?.[key])), `Demo ${key} must have eight safe points: ${scope.name ?? "organization"}`);
        assert(scope.participation >= 80 && scope.participation <= 95, "Demo participation must remain varied and realistic");
        assert(scope.sharedThemes.available && scope.sharedThemes.factors.filter((f) => f.reason === null).length >= 2, `Demo themes unavailable: ${scope.name ?? "organization"}`);
    }
    assert(Object.entries(hr.monthlyChange).some(([key, delta]) => key === "stress" ? delta > 0 : key !== "workload" && delta < 0), "The organization should have a real adverse monthly insight to demonstrate");
    return { organization: hr, teams };
}

function importDefinition(original, manifestPredicate) {
    const marker = "AND week_start = NEW.week_start AND finalized_at IS NULL FOR SHARE;";
    assert.equal(original.split(marker).length, 2, "Unexpected immutability function; inspect before maintenance");
    // Only this transaction sees the temporary manifest and altered function.
    // Existing UPDATE/DELETE/role/membership checks remain exactly as written.
    return original.replace(marker, `AND week_start = NEW.week_start AND (finalized_at IS NULL
        OR (TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM pg_temp.teampulse_demo_manifest m WHERE ${manifestPredicate}))) FOR SHARE;`);
}

async function expandDemo(pool, { apply = false, baselinePath = null } = {}) {
    const client = await pool.connect(); let begun = false;
    try {
        await client.query("BEGIN"); begun = true;
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '30s'");
        await client.query("LOCK TABLE identity.users,wellbeing.team_weeks,private.employee_weekly_checkins,wellbeing.wellbeing_responses,wellbeing.response_challenges IN SHARE ROW EXCLUSIVE MODE");
        const before = await captureSnapshot(client);
        if (baselinePath) verifyPreserved(JSON.parse(fs.readFileSync(baselinePath, "utf8")), before);
        const users = before.tables["identity.users"], existing = users.filter((u) => u.sso_issuer === ISSUER);
        assert(users.every((u) => u.sso_issuer.endsWith(".invalid")), "Only a fictional local demo database may be expanded");
        const backup = path.join(os.tmpdir(), `teampulse-${VERSION}-before-${Date.now()}.json`);
        fs.writeFileSync(backup, JSON.stringify(before, null, 2), { flag: "wx", mode: 0o600 });
        const current = (await client.query("SELECT to_char(date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date,'YYYY-MM-DD') AS week")).rows[0].week;
        const anchor = existing.length ? (await client.query(`SELECT to_char((min(created_at) AT TIME ZONE 'Europe/Lisbon')::date+56,'YYYY-MM-DD') AS week
            FROM identity.users WHERE sso_issuer=$1`, [ISSUER])).rows[0].week : current;
        const plan = await buildDataset(anchor);
        const teams = new Map(GROUPS.map((group) => {
            const department = before.tables["identity.departments"].find((d) => d.name === group.department);
            const matches = before.tables["identity.teams"].filter((t) => t.name === group.team && t.department_id === department?.department_id);
            assert.equal(matches.length, 1, `Missing expected demo team ${group.team}`); return [group.team, matches[0].team_id];
        }));
        const subjects = new Map();
        if (existing.length) {
            assert.equal(existing.length, plan.people.length, "Partial dataset or conflicting demo identities");
            for (const person of plan.people) {
                const user = existing.find((u) => u.sso_subject === person.subject);
                assert(user && user.team_id === teams.get(person.team) && user.display_name === person.name && user.role === "employee");
                subjects.set(person.subject, user.user_id);
            }
        } else {
            for (const person of plan.people) {
                const result = await client.query(`INSERT INTO identity.users (sso_issuer,sso_subject,display_name,role,team_id,created_at)
                    VALUES ($1,$2,$3,'employee',$4,($5::date::timestamp AT TIME ZONE 'Europe/Lisbon')) RETURNING user_id`,
                [ISSUER, person.subject, person.name, teams.get(person.team), addDays(anchor, -56)]);
                subjects.set(person.subject, result.rows[0].user_id);
            }
        }
        for (const week of [...new Set(plan.entries.map((entry) => entry.week))]) for (const team of teams.values())
            assert(before.tables["wellbeing.team_weeks"].some((tw) => tw.team_id === team && tw.week_start === week && tw.finalized_at), `Expected finalized cohort missing: ${team}/${week}`);
        const factors = new Map(before.tables["wellbeing.challenge_factors"].map((f) => [f.code, f.challenge_factor_id]));
        if (!existing.length) {
            await client.query(`CREATE TEMP TABLE teampulse_demo_manifest (
                user_id uuid NOT NULL,team_id bigint NOT NULL,week_start date NOT NULL,response_id uuid,
                PRIMARY KEY(user_id,week_start),UNIQUE(response_id)) ON COMMIT DROP`);
            for (const entry of plan.entries) {
                const result = await client.query(`INSERT INTO pg_temp.teampulse_demo_manifest VALUES($1,$2,$3,
                    CASE WHEN $4 THEN gen_random_uuid() ELSE NULL END) RETURNING response_id`,
                [subjects.get(entry.subject), teams.get(entry.team), entry.week, entry.submitted]);
                entry.responseId = result.rows[0].response_id;
            }
            await client.query(importDefinition(before.functions["wellbeing.protect_response"], "m.response_id=NEW.response_id AND m.team_id=NEW.team_id AND m.week_start=NEW.week_start"));
            await client.query(importDefinition(before.functions["private.protect_weekly_checkin"], "m.user_id=NEW.user_id AND m.team_id=NEW.team_id AND m.week_start=NEW.week_start AND m.response_id IS NOT DISTINCT FROM NEW.response_id"));
            for (const entry of plan.entries) {
                if (entry.submitted) {
                    const s = entry.scores;
                    await client.query(`INSERT INTO wellbeing.wellbeing_responses(response_id,team_id,week_start,wellbeing_score,workload_score,
                        stress_score,team_integration_score,psychological_safety_score,comment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    [entry.responseId, teams.get(entry.team), entry.week, s.wellbeing, s.workload, s.stress, s.teamIntegration, s.psychologicalSafety, s.comment || null]);
                    for (const code of s.challenges) {
                        assert(factors.has(code), `Missing approved challenge ${code}`);
                        await client.query("INSERT INTO wellbeing.response_challenges VALUES($1,$2)", [entry.responseId, factors.get(code)]);
                    }
                }
                // Choices precede the protected ownership link. The original
                // challenge immutability trigger and reciprocal FKs stay active.
                await client.query("INSERT INTO private.employee_weekly_checkins(user_id,team_id,week_start,response_id) VALUES($1,$2,$3,$4)",
                    [subjects.get(entry.subject), teams.get(entry.team), entry.week, entry.responseId]);
            }
            for (const definition of Object.values(before.functions)) await client.query(definition);
        }
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        const after = await captureSnapshot(client);
        verifyPreserved(before, after);
        verifyDataset(after, plan, subjects, teams);
        const report = await demoReport(client);
        const originalResponses = before.tables["wellbeing.wellbeing_responses"].length;
        const finalResponses = after.tables["wellbeing.wellbeing_responses"].length;
        const result = { applied: apply, alreadyPresent: existing.length > 0, backup, anchor,
            originalResponses, newEmployees: existing.length ? 0 : plan.people.length, newResponses: finalResponses - originalResponses,
            finalResponses, originalRecordsUnchanged: true, ...report };
        await client.query(apply ? "COMMIT" : "ROLLBACK"); begun = false;
        return result;
    } catch (error) {
        if (begun) await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
}

module.exports = { ISSUER, VERSION, GROUPS, addDays, buildDataset, captureSnapshot, verifyPreserved, verifyDataset, demoReport, importDefinition, expandDemo };
if (require.main === module) {
    const args = process.argv.slice(2), apply = args.includes("--apply"), dry = args.includes("--dry-run");
    if (apply === dry || args.some((arg) => !["--apply", "--dry-run"].includes(arg))) {
        console.error("Use node db/expand-demo.cjs --dry-run or --apply. Fictional local data only."); process.exitCode = 1;
    } else {
        const { pool } = require("../server/db");
        if (!["localhost", "127.0.0.1", "::1"].includes(process.env.DB_HOST) || process.env.DB_NAME !== "teampulse" || process.env.MIN_RESPONSES !== "5") {
            console.error("Use the local teampulse demo database with MIN_RESPONSES=5."); pool.end(); process.exitCode = 1;
        } else expandDemo(pool, { apply }).then((result) => console.log(JSON.stringify(result, null, 2)))
            .catch((error) => { console.error("Demo expansion rolled back:", error.message); process.exitCode = 1; }).finally(() => pool.end());
    }
}

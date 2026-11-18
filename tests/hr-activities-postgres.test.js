const { isolatedDatabase } = require("./helpers/postgres-fixture.cjs");
const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../server/app");
const noPrivate = (value) => {
    for (const [key, child] of Object.entries(value ?? {})) {
        assert(!["user_id", "userId", "employeeId", "created_by_user_id", "response_id", "responseId", "comment", "comments", "history", "responses"].includes(key));
        if (child && typeof child === "object") noPrivate(child);
    }
    assert(!JSON.stringify(value).includes("00000000-0000"));
};
test("PostgreSQL HR activity management and Employee support integration (all fixtures rolled back)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1 with the activity insight migration applied." : false }, async (t) => {
        const pool = await isolatedDatabase(), client = await pool.connect();
        try {
            await client.query("BEGIN");
            const fingerprint = async () => (await client.query(`SELECT count(*) AS count,md5(string_agg(to_jsonb(r)::text,'|' ORDER BY response_id)) AS hash FROM wellbeing.wellbeing_responses r`)).rows[0];
            const before = await fingerprint();
            const original = (await client.query("SELECT activity_id,to_jsonb(a) AS data FROM operations.activities a ORDER BY activity_id")).rows;
            const originalRegistrations = (await client.query("SELECT activity_id,user_id,to_jsonb(r) AS data FROM private.activity_registrations r ORDER BY activity_id,user_id")).rows;
            const actionsBefore = (await client.query("SELECT md5(string_agg(to_jsonb(a)::text,'|' ORDER BY team_action_id)) AS hash FROM operations.team_actions a")).rows[0];
            const nested = { query: (...args) => client.query(...args), async connect() { return { async query(sql, args) {
                if (sql === "BEGIN") return client.query("SAVEPOINT activity_test");
                if (sql === "COMMIT") return client.query("RELEASE SAVEPOINT activity_test");
                if (sql === "ROLLBACK") { await client.query("ROLLBACK TO SAVEPOINT activity_test"); return client.query("RELEASE SAVEPOINT activity_test"); }
                return client.query(sql, args);
            }, release() {} }; } };
            const app = createApp({ getPool: () => nested, minimumResponses: 5, prototypeAccess: true, sessionSecret: "real-activities-test" });
            const agents = {};
            for (const role of ["hr", "manager", "employee"]) { agents[role] = request.agent(app); await agents[role].post(`/api/prototype/${role}-session`).send({}).expect(204); }
            const { hr, manager, employee } = agents;
            const catalogue = (await hr.get("/api/hr/activities").expect(200)).body;
            const source = catalogue.insights.find((i) => i.departmentName === "Engineering"); assert(source);
            const small = catalogue.departments.find((d) => d.name === "People and Operations"); assert(small);
            const starts = new Date(Date.now() + 30 * 86400000); starts.setUTCSeconds(0, 0);
            const input = (extra = {}) => ({ departmentId: source.departmentId, area: source.area, sourceWeek: source.sourceWeek,
                type: "workshop", title: "Transaction-only wellbeing activity", description: "Coordinate shared priorities and supportive department planning.",
                startsAt: starts.toISOString(), duration: 45, format: "online", audience: "department", publication: "published", ...extra });
            let saved;
            await t.test("HR can create from real safe department sources with persisted aggregate context", async () => {
                for (const name of ["Engineering", "Customer Experience"]) {
                    const insight = catalogue.insights.find((i) => i.departmentName === name); assert(insight);
                    const body = (await hr.post("/api/hr/activities").send(input({ departmentId: insight.departmentId, area: insight.area, sourceWeek: insight.sourceWeek })).expect(201)).body;
                    assert.deepEqual(body.source, { week: insight.sourceWeek, value: insight.value, change: insight.change });
                    assert.equal(body.departmentName, name); assert.equal(body.area, insight.area); assert.equal(body.status, "upcoming"); noPrivate(body);
                    if (name === "Engineering") saved = body;
                }
                const reloaded = (await hr.get("/api/hr/activities").expect(200)).body;
                assert.deepEqual(reloaded.activities.find((a) => a.id === saved.id), saved); noPrivate(reloaded);
            });
            await t.test("HR edits publication/content while preserving a source; status follows the existing schedule", async () => {
                const changed = (await hr.put(`/api/hr/activities/${saved.id}`).send(input({ title: "Updated department workshop", publication: "draft" })).expect(200)).body;
                assert.equal(changed.status, "draft"); assert.deepEqual(changed.source, saved.source);
                const published = (await hr.put(`/api/hr/activities/${saved.id}`).send(input({ title: changed.title })).expect(200)).body;
                assert.equal(published.status, "upcoming");
                assert.equal((await hr.get("/api/hr/activities").expect(200)).body.activities.find((a) => a.id === saved.id).publication, "published");
                await hr.put(`/api/hr/activities/${saved.id}`).send(input({ departmentId: small.id })).expect(409);
                const { sourceWeek, ...noSource } = input(); await hr.put(`/api/hr/activities/${saved.id}`).send(noSource).expect(409);
            });
            await t.test("general activities support People and Operations and the whole organization without invented sources", async () => {
                const { sourceWeek, ...general } = input();
                const manual = (await hr.post("/api/hr/activities").send({ ...general, departmentId: small.id, publication: "draft" }).expect(201)).body;
                assert.equal(manual.source, null); assert.equal(manual.status, "draft");
                const org = (await hr.post("/api/hr/activities").send({ ...general, departmentId: null, audience: "all_employees" }).expect(201)).body;
                assert.equal(org.source, null); assert.equal(org.departmentId, null);
            });
            await t.test("unavailable/stale/unmeasured sources and forged private data are rejected", async () => {
                const stale = new Date(source.sourceWeek + "T12:00:00Z"); stale.setUTCDate(stale.getUTCDate() - 7);
                for (const extra of [{ departmentId: null, audience: "all_employees" }, { sourceWeek: stale.toISOString().slice(0, 10) }, { sourceWeek: "2026-01-05" }])
                    await hr.post("/api/hr/activities").send(input(extra)).expect(409);
                for (const extra of [{ departmentId: "999999" }, { area: "deadlines" }, { area: "challenge" }, { type: "clinical" },
                    { publication: "invalid" }, { title: " " }, { description: "" }, { duration: 0 }, { userId: "employee" },
                    { source: { value: 2 } }, { comment: "private" }, { startsAt: "2026-01-01T14:00:00.000Z" }])
                    await hr.post("/api/hr/activities").send(input(extra)).expect(400);
                await hr.put("/api/hr/activities/999999").send(input()).expect(404);
                await hr.get("/api/hr/activities?employeeId=anything").expect(400);
            });
            await t.test("Employee/Manager receive 403 and unauthenticated callers 401 on all management operations", async () => {
                for (const other of [employee, manager, request.agent(app)]) {
                    const code = other === employee || other === manager ? 403 : 401;
                    await other.get("/api/hr/activities").expect(code);
                    await other.post("/api/hr/activities").send(input()).expect(code);
                    await other.put(`/api/hr/activities/${saved.id}`).send(input()).expect(code);
                }
                await hr.post("/api/hr/activities").set("Origin", "https://evil.invalid").send(input()).expect(403);
                for (const other of [hr, manager]) await other.get("/api/employee/activities").expect(403);
                await hr.get("/api/hr/interventions").expect(404);
            });
            await t.test("published activity reaches Employee support without HR aggregate context; duplicate registration conflicts safely", async () => {
                const list = (await employee.get("/api/employee/activities").expect(200)).body;
                const visible = list.find((a) => a.id === saved.id); assert(visible); assert.equal(visible.demo, false);
                assert(!list.some((a) => a.audience === small.name));
                for (const a of list) { assert(!("source" in a)); assert(!("area" in a)); assert(!("departmentId" in a)); noPrivate(a); }
                await employee.post(`/api/employee/activities/${saved.id}/registrations`).send({}).expect(200);
                const firstRegistration = (await client.query("SELECT registered_at FROM private.activity_registrations WHERE activity_id=$1", [saved.id])).rows[0];
                const duplicate = (await employee.post(`/api/employee/activities/${saved.id}/registrations`).send({}).expect(409)).body;
                assert.equal(duplicate.error, "You are already registered for this activity.");
                assert.deepEqual((await client.query("SELECT registered_at FROM private.activity_registrations WHERE activity_id=$1", [saved.id])).rows[0], firstRegistration);
                assert.equal((await employee.get("/api/employee/activities").expect(200)).body.find((a) => a.id === saved.id).registered, true);
                await employee.delete("/api/prototype/employee-session").expect(204);
                await employee.post("/api/prototype/employee-session").send({}).expect(204);
                assert.equal((await employee.get("/api/employee/activities").expect(200)).body.find((a) => a.id === saved.id).registered, true);
                assert.equal((await client.query("SELECT count(*) AS n FROM private.activity_registrations WHERE activity_id=$1", [saved.id])).rows[0].n, "1");
                await employee.post(`/api/employee/activities/${saved.id}/registrations`).send({ userId: "other" }).expect(400);
                await employee.post("/api/employee/activities/999999/registrations").send({}).expect(409);
            });
            await t.test("registration survives logout, a regenerated Employee session and a fresh client; HR receives only its count", async () => {
                await employee.delete("/api/prototype/employee-session").expect(204);
                await employee.get("/api/employee/activities").expect(401);
                await employee.post("/api/prototype/employee-session").send({}).expect(204);
                const fresh = request.agent(app);
                await fresh.post("/api/prototype/employee-session").send({}).expect(204);
                for (const browser of [employee, fresh]) {
                    const a = (await browser.get("/api/employee/activities").expect(200)).body.find((a) => a.id === saved.id);
                    assert.equal(a.registered, true); assert.equal(a.status, "upcoming"); assert.equal(a.registrationOpen, true);
                    await browser.post(`/api/employee/activities/${saved.id}/registrations`).send({}).expect(409);
                }
                const a = (await hr.get("/api/hr/activities").expect(200)).body.activities.find((a) => a.id === saved.id);
                assert.equal(a.registrationCount, 1); assert.equal(a.registrationOpen, true); noPrivate(a);
                assert(!("attendees" in a)); assert(!("registrations" in a));
            });
            await t.test("Draft -> Published uses real department targeting and organization-wide visibility", async () => {
                const otherAccount = (await client.query(`SELECT u.sso_subject FROM identity.users u JOIN identity.teams t USING(team_id)
                    WHERE u.role='employee' AND u.is_active AND t.department_id <> $1 ORDER BY u.user_id LIMIT 1`, [source.departmentId])).rows[0];
                assert(otherAccount);
                // Test-only selection of a second real account. The production
                // prototype endpoint remains fixed; no identity input is added.
                const otherPool = { ...nested, query(sql, args) {
                    return client.query(sql, sql.includes("WHERE sso_issuer = $1 AND sso_subject = $2") ? [args[0], otherAccount.sso_subject] : args);
                } };
                const other = request.agent(createApp({ getPool: () => otherPool, prototypeAccess: true, minimumResponses: 5, sessionSecret: "other-employee-activities-test" }));
                await other.post("/api/prototype/employee-session").send({}).expect(204);
                const body = input({ sourceWeek: undefined, publication: "draft", title: "Transaction-only department activity" });
                const draft = (await hr.post("/api/hr/activities").send(body).expect(201)).body;
                assert.equal(draft.status, "draft"); assert.equal(draft.registrationOpen, false); assert.equal(draft.registrationCount, 0);
                for (const browser of [employee, other]) {
                    assert(!(await browser.get("/api/employee/activities").expect(200)).body.some((a) => a.id === draft.id));
                    await browser.post(`/api/employee/activities/${draft.id}/registrations`).send({}).expect(409);
                }
                const published = (await hr.put(`/api/hr/activities/${draft.id}`).send({ ...body, publication: "published" }).expect(200)).body;
                assert.equal(published.status, "upcoming"); assert.equal(published.registrationOpen, true);
                const target = (await employee.get("/api/employee/activities").expect(200)).body.find((a) => a.id === draft.id);
                assert(target); assert.equal(target.registrationOpen, true);
                assert(!(await other.get("/api/employee/activities").expect(200)).body.some((a) => a.id === draft.id));
                await other.post(`/api/employee/activities/${draft.id}/registrations`).send({}).expect(409);
                await employee.post(`/api/employee/activities/${draft.id}/registrations`).send({}).expect(200);
                const org = (await hr.post("/api/hr/activities").send({ ...body, departmentId: null, audience: "all_employees", publication: "published" }).expect(201)).body;
                for (const browser of [employee, other]) assert((await browser.get("/api/employee/activities").expect(200)).body.some((a) => a.id === org.id));
                // An insight's department may be retained while its explicit
                // audience is all employees; audience controls eligibility.
                const all = (await hr.post("/api/hr/activities").send({ ...body, audience: "all_employees", publication: "published" }).expect(201)).body;
                assert((await other.get("/api/employee/activities").expect(200)).body.some((a) => a.id === all.id));
                await employee.post(`/api/employee/activities/${all.id}/registrations`).send({}).expect(200);
                assert.equal((await other.get("/api/employee/activities").expect(200)).body.find((a) => a.id === all.id).registered, false);
            });
            await t.test("published activities later today are visible using Lisbon dates, while future publication and drafts stay hidden", async () => {
                const fixture = (await hr.post("/api/hr/activities").send(input({ sourceWeek: undefined })).expect(201)).body;
                // Only this new rollback-only fixture changes. Select a future
                // instant halfway to Lisbon midnight: always later TODAY, even
                // around month/year boundaries and daylight saving changes.
                const schedule = (await client.query(`UPDATE operations.activities SET
                    published_at=CURRENT_TIMESTAMP-interval '1 day',
                    starts_at=CURRENT_TIMESTAMP + (((date_trunc('day',CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')
                        + interval '1 day') AT TIME ZONE 'Europe/Lisbon')-CURRENT_TIMESTAMP)/2
                    WHERE activity_id=$1 RETURNING starts_at,
                        to_char(starts_at AT TIME ZONE 'Europe/Lisbon','YYYY-MM-DD') AS scheduled_day,
                        to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon','YYYY-MM-DD') AS today`, [fixture.id])).rows[0];
                assert.equal(schedule.scheduled_day, schedule.today);
                const current = (await employee.get("/api/employee/activities").expect(200)).body.find((a) => a.id === fixture.id);
                assert(current); assert.equal(current.status, "upcoming"); assert.equal(current.registrationOpen, true);
                // A scheduled date alone is insufficient: publication must
                // already have happened. Preserve the existing publication rule.
                await client.query(`UPDATE operations.activities SET starts_at=CURRENT_TIMESTAMP+interval '2 days',
                    published_at=CURRENT_TIMESTAMP+interval '1 day' WHERE activity_id=$1`, [fixture.id]);
                assert(!(await employee.get("/api/employee/activities").expect(200)).body.some((a) => a.id === fixture.id));
                await employee.post(`/api/employee/activities/${fixture.id}/registrations`).send({}).expect(409);
                await client.query("UPDATE operations.activities SET published_at=NULL WHERE activity_id=$1", [fixture.id]);
                assert(!(await employee.get("/api/employee/activities").expect(200)).body.some((a) => a.id === fixture.id));
                assert((await hr.get("/api/hr/activities").expect(200)).body.activities.some((a) => a.id === fixture.id));
            });
            await t.test("expired activities are hidden from Employee, retained for HR, and keep registrations", async () => {
                const upcoming = (await hr.post("/api/hr/activities").send(input({ sourceWeek: undefined })).expect(201)).body;
                await employee.post(`/api/employee/activities/${upcoming.id}/registrations`).send({}).expect(200);
                const registration = (await client.query("SELECT * FROM private.activity_registrations WHERE activity_id=$1", [upcoming.id])).rows;
                const registered = (await employee.get("/api/employee/activities").expect(200)).body.find((a) => a.id === upcoming.id);
                const { renderRegistrationNotices } = await import("../public/js/ui.mjs");
                assert(renderRegistrationNotices([registered]).includes(`data-registration-notice="${upcoming.id}"`));
                for (const [status, minutes] of [["in_progress", 0], ["in_progress", 1], ["completed", 60]]) {
                    // Advance only this rollback-only fixture's schedule. Existing
                    // activities and publication/lifecycle rules are untouched.
                    await client.query(`UPDATE operations.activities SET published_at=CURRENT_TIMESTAMP-interval '2 days',
                        starts_at=CURRENT_TIMESTAMP-$2*interval '1 minute' WHERE activity_id=$1`, [upcoming.id, minutes]);
                    const a = (await employee.get("/api/employee/activities").expect(200)).body.find((a) => a.id === upcoming.id);
                    assert.equal(a, undefined);
                    await employee.post(`/api/employee/activities/${upcoming.id}/registrations`).send({}).expect(409);
                    const managed = (await hr.get("/api/hr/activities").expect(200)).body.activities.find((a) => a.id === upcoming.id);
                    assert.equal(managed.status, status); assert.equal(managed.registrationOpen, false); assert.equal(managed.registrationCount, 1);
                    assert.equal((await client.query("SELECT activity_id FROM operations.activities WHERE activity_id=$1", [upcoming.id])).rows.length, 1);
                    // Also protect Home from a stale upcoming DTO whose actual
                    // scheduled time has since passed; never trust its old label.
                    assert.equal(renderRegistrationNotices([{ ...registered, startsAt: managed.startsAt }]), "");
                    assert.deepEqual((await client.query("SELECT * FROM private.activity_registrations WHERE activity_id=$1", [upcoming.id])).rows, registration);
                }
                for (const other of [hr, manager, request.agent(app)])
                    await other.post(`/api/employee/activities/${upcoming.id}/registrations`).send({}).expect(other === hr || other === manager ? 403 : 401);
            });
            await t.test("existing activities, all 167 responses and Manager plans remain intact; source snapshot is protected by SQL", async () => {
                for (const row of original) assert.deepEqual((await client.query("SELECT to_jsonb(a) AS data FROM operations.activities a WHERE activity_id=$1", [row.activity_id])).rows[0].data, row.data);
                for (const row of originalRegistrations) assert.deepEqual((await client.query("SELECT to_jsonb(r) AS data FROM private.activity_registrations r WHERE activity_id=$1 AND user_id=$2", [row.activity_id, row.user_id])).rows[0].data, row.data);
                assert.deepEqual(await fingerprint(), before);
                assert.deepEqual((await client.query("SELECT md5(string_agg(to_jsonb(a)::text,'|' ORDER BY team_action_id)) AS hash FROM operations.team_actions a")).rows[0], actionsBefore);
                await manager.get("/api/manager/actions").expect(200); await manager.get("/api/manager/overview").expect(200);
                await employee.get("/api/employee/history?period=year").expect(200);
                await client.query("SAVEPOINT invalid_activity");
                await assert.rejects(client.query("UPDATE operations.activities SET source_value=0 WHERE activity_id=$1", [saved.id]));
                await client.query("ROLLBACK TO SAVEPOINT invalid_activity"); await client.query("RELEASE SAVEPOINT invalid_activity");
            });
        } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
    });

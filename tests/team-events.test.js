const test = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createTeamEvents } = require("../server/team-events");
const { createApp } = require("../server/app");
const { isolatedDatabase } = require("./helpers/postgres-fixture.cjs");

test("team event validation rejects invalid dates, extra identity/scores and invalid teams before SQL", async () => {
    const service = createTeamEvents(() => { throw Error("Invalid event must not access SQL"); });
    const valid = { teamId: "1", title: "Planning workshop", date: "2026-10-25" };
    for (const value of [null, [], {}, { ...valid, date: "2026-02-30" }, { ...valid, date: "0000-01-01" },
        { ...valid, title: " " }, { ...valid, title: "x".repeat(161) }, { ...valid, teamId: "1 OR true" },
        { ...valid, userId: "other" }, { ...valid, created_by_user_id: "manager" }, { ...valid, scores: {} }])
        await assert.rejects(service.create("manager", value), { status: 400 });
});

test("event presentation uses the supplied Monday cohort, groups same-week markers and escapes titles", async () => {
    const { evolutionEvents, eventMarkers, eventContext } = await import("../public/js/team-events.mjs");
    const weeks = ["2026-10-19", "2026-10-26"].map((weekStart) => ({ weekStart }));
    const events = [
        { id: "1", title: '<img src=x onerror="alert(1)">', date: "2026-10-25", weekStart: "2026-10-19" },
        { id: "2", title: "Second event", date: "2026-10-23", weekStart: "2026-10-19" },
        { id: "3", title: "Next Monday", date: "2026-10-26", weekStart: "2026-10-26" },
        { id: "4", title: "Outside window", date: "2026-11-02", weekStart: "2026-11-02" }
    ];
    assert.deepEqual(evolutionEvents(weeks, events).map((event) => event.index), [0, 0, 1]);
    const svg = eventMarkers(weeks, events);
    assert.equal((svg.match(/class="report-event-marker"/g) ?? []).length, 2);
    assert(svg.includes('M 38 213')); assert(svg.includes('M 678 213'));
    assert(svg.includes('tabindex="0"')); assert(svg.includes('aria-label='));
    const html = eventContext({ teamId: "1", weeks, events });
    assert(!html.includes('<img')); assert(html.includes('&lt;img')); assert(!html.includes('Outside window'));
});

test("adding event context does not change plotted score points or expose it in HR presentation", async () => {
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const week = { weekStart: "2026-10-19", available: true, scores: { wellbeing: 7.5 }, responseCount: 12 };
    const team = { teamId: "1", name: "Platform", available: true, weeks: [week], scores: week.scores };
    const before = structuredClone(team);
    const plain = renderOverview("manager", { teams: [team], source: "postgres" });
    const event = { id: "1", title: "Team planning", date: "2026-10-21", weekStart: week.weekStart };
    const annotated = renderOverview("manager", { teams: [{ ...team, events: [event] }], source: "postgres" });
    assert.deepEqual(annotated.match(/<polyline[^>]+>/g), plain.match(/<polyline[^>]+>/g));
    assert(annotated.includes('data-event-week="2026-10-19"')); assert(annotated.includes('Team planning'));
    assert.deepEqual(team, before);
    const hidden = renderOverview("manager", { teams: [{ ...team, weeks: [{ ...week, available: false, scores: null }], events: [event] }] });
    assert(hidden.includes('Team planning')); assert(!hidden.includes('<polyline'));
    assert(!renderOverview("hr", { ...team, events: [event], departments: [] }).includes('Team planning'));
});

test("PostgreSQL: Manager team events, scoped annotations, storage and unchanged reporting (rollback)", {
    skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1." : false
}, async (t) => {
    const pool = await isolatedDatabase(), client = await pool.connect();
    const { captureSnapshot } = require("../db/expand-demo.cjs");
    const { createReporting } = require("../server/reporting");
    const before = await captureSnapshot(client);
    try {
        await client.query("BEGIN");
        const db = { query: (...args) => client.query(...args) };
        const app = createApp({ getPool: () => db, prototypeAccess: true, minimumResponses: 5, sessionSecret: "team-events-test" });
        const manager = request.agent(app), employee = request.agent(app), hr = request.agent(app);
        for (const [role, agent] of [["manager", manager], ["employee", employee], ["hr", hr]])
            await agent.post(`/api/prototype/${role}-session`).send({}).expect(204);
        const reporting = createReporting(() => db);
        const managerId = await reporting.prototypeAccount("manager");
        const metricsBefore = await reporting.overview("manager", managerId), hrBefore = await reporting.overview("hr", await reporting.prototypeAccount("hr"));
        const input = { teamId: metricsBefore.teams[0].teamId, title: "Sprint retrospective", date: "2026-10-25" };
        let saved;
        await t.test("create stores the authenticated creator and correct Sunday-to-Monday week", async () => {
            saved = (await manager.post("/api/manager/events").send(input).expect(201)).body;
            assert.deepEqual(saved, { ...input, id: saved.id, weekStart: "2026-10-19" });
            const row = (await client.query("SELECT created_by_user_id,title,event_date::text FROM operations.team_events WHERE team_event_id=$1", [saved.id])).rows[0];
            assert.equal(row.created_by_user_id, managerId); assert.equal(row.title, input.title); assert.equal(row.event_date, input.date);
        });
        await t.test("only Platform events in the displayed window reach its Manager; other teams and dates are excluded", async () => {
            const listed = (await manager.get("/api/manager/events").expect(200)).body;
            assert(listed.some((event) => event.id === saved.id)); assert(listed.every((event) => event.teamId === input.teamId));
            assert(listed.every((event) => event.date >= "2026-09-14" && event.date < "2026-11-09"));
            await manager.post("/api/manager/events").send({ ...input, title: "Outside window", date: "2026-11-09" }).expect(201);
            assert(!(await manager.get("/api/manager/events")).body.some((event) => event.title === "Outside window"));
            const overview = (await manager.get("/api/manager/overview").expect(200)).body;
            assert(overview.teams[0].events.some((event) => event.id === saved.id && event.weekStart === "2026-10-19"));
            for (const event of overview.teams[0].events) assert.deepEqual(Object.keys(event).sort(), ["date", "id", "teamId", "title", "weekStart"].sort());
        });
        await t.test("another Manager's team, arbitrary filters and forged creator fields are rejected", async () => {
            await manager.post("/api/manager/events").send({ ...input, teamId: "2" }).expect(403);
            await manager.post("/api/manager/events").send({ ...input, teamId: "999999" }).expect(403);
            await manager.get("/api/manager/events?teamId=2").expect(400);
            await manager.post("/api/manager/events").send({ ...input, created_by_user_id: managerId }).expect(400);
            const otherId = (await client.query("SELECT manager_user_id FROM identity.teams WHERE team_id=2")).rows[0].manager_user_id;
            assert(!(await createTeamEvents(() => db).list(otherId)).some((event) => event.id === saved.id));
        });
        await t.test("HR, Employee and unauthenticated callers cannot retrieve or manage events", async () => {
            for (const agent of [employee, hr, request.agent(app)]) {
                const status = agent === employee || agent === hr ? 403 : 401;
                await agent.get("/api/manager/events").expect(status);
                await agent.post("/api/manager/events").send(input).expect(status);
            }
            assert(!JSON.stringify((await hr.get("/api/hr/overview").expect(200)).body).includes(input.title));
            await manager.post("/api/manager/events").set("Origin", "https://untrusted.invalid").send(input).expect(403);
        });
        await t.test("event writes leave every aggregate, response, registration, action and other table unchanged", async () => {
            assert.deepEqual(await reporting.overview("manager", managerId), metricsBefore);
            assert.deepEqual(await reporting.overview("hr", await reporting.prototypeAccount("hr")), hrBefore);
            const after = await captureSnapshot(client);
            for (const table of Object.keys(before.tables)) if (table !== "operations.team_events") assert.deepEqual(after.tables[table], before.tables[table], table);
            assert.deepEqual(after.definitions, before.definitions);
        });
    } finally {
        await client.query("ROLLBACK");
        assert.deepEqual((await captureSnapshot(client)).tables, before.tables);
        client.release(); await pool.end();
    }
});

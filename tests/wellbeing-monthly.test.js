const test = require("node:test");
const assert = require("node:assert/strict");

test("monthly completion starts at zero and counts unique Monday records only in the current month", async () => {
    const { monthlyCompletion } = await import("../public/js/wellbeing.mjs");
    assert.deepEqual(monthlyCompletion([], "2026-11-01"), { month: "2026-11", completed: 0, target: 4 });
    assert.equal(monthlyCompletion([{ weekStart: "2026-11-02" }], "2026-11-04").completed, 1);
    assert.equal(monthlyCompletion([{ weekStart: "2026-10-26" }, { weekStart: "2026-11-02" }, { weekStart: "2026-11-09" },
        { weekStart: "2026-11-09" }, { weekStart: "2026-11-16" }], "2026-11-11").completed, 2);
});
test("monthly display caps five eligible weekly records at four without changing the records", async () => {
    const { monthlyCompletion } = await import("../public/js/wellbeing.mjs");
    const records = ["03", "10", "17", "24", "31"].map((day) => ({ weekStart: `2026-08-${day}` }));
    assert.equal(monthlyCompletion(records.slice(0, 4), "2026-08-31").completed, 4);
    assert.deepEqual(monthlyCompletion(records, "2026-08-31"), { month: "2026-08", completed: 4, target: 4 });
    assert.equal(records.length, 5);
    assert.equal(monthlyCompletion(records, "2026-09-01").completed, 0);
});
test("recorded demo submissions drive the monthly count; illustrative trend fixtures never do", async () => {
    const { createDemoEmployeeApi } = await import("../public/js/demo-employee-api.mjs");
    let date = new Date("2026-11-06T12:00:00Z");
    const api = createDemoEmployeeApi({ storage: null, now: () => date });
    const raw = { wellbeing: "positive", workload: "manageable", stress: 3, teamIntegration: "connected", psychologicalSafety: 4, challenges: [] };
    assert.equal((await api.getHistory()).monthlyCompletion.completed, 0);
    await api.submitCheckin(raw);
    assert.equal((await api.getHistory()).monthlyCompletion.completed, 1);
    await assert.rejects(api.submitCheckin(raw), { status: 409 });
    assert.equal((await api.getHistory()).monthlyCompletion.completed, 1);
    date = new Date("2026-11-13T12:00:00Z"); await api.submitCheckin(raw);
    assert.equal((await api.getHistory("quarter")).monthlyCompletion.completed, 2);
    date = new Date("2026-12-01T00:00:00Z");
    assert.equal((await api.getHistory("year")).monthlyCompletion.completed, 0);
    await assert.rejects(api.submitCheckin(raw), { status: 409 });
    // The Nov 30 week belongs to November, even if answered on Friday Dec 4.
    date = new Date("2026-12-04T12:00:00Z");
    await api.submitCheckin(raw); assert.equal((await api.getHistory()).monthlyCompletion.completed, 0);
    date = new Date("2026-12-11T12:00:00Z"); await api.submitCheckin(raw);
    assert.equal((await api.getHistory()).monthlyCompletion.completed, 1);
});
test("monthly boundaries follow Lisbon summer time, not UTC or the selected chart period", async () => {
    const { createDemoEmployeeApi } = await import("../public/js/demo-employee-api.mjs");
    const api = createDemoEmployeeApi({ storage: null, now: () => new Date("2026-08-31T23:30:00Z") });
    assert.equal((await api.getHistory("quarter")).monthlyCompletion.month, "2026-09");
    assert.equal((await api.getHistory("quarter")).monthlyCompletion.completed, 0);
});
test("a fifth weekly cohort remains eligible across the month boundary without displaying 5/4", async () => {
    const { createDemoEmployeeApi } = await import("../public/js/demo-employee-api.mjs");
    let date = new Date("2026-08-07T12:00:00Z"), saved;
    const storage = { getItem: () => null, setItem: (key, value) => { saved = JSON.parse(value); } };
    const api = createDemoEmployeeApi({ storage, now: () => date });
    const raw = { wellbeing: "neutral", workload: "manageable", stress: 3, teamIntegration: "connected", psychologicalSafety: 3, challenges: [] };
    for (const [index, day] of ["07", "14", "21", "28"].entries()) {
        date = new Date(`2026-08-${day}T12:00:00Z`); await api.submitCheckin(raw);
        assert.equal((await api.getHistory()).monthlyCompletion.completed, index + 1);
    }
    date = new Date("2026-08-31T12:00:00Z");
    assert.equal((await api.getHistory()).monthlyCompletion.completed, 4);
    await assert.rejects(api.submitCheckin(raw), { status: 409 });
    date = new Date("2026-09-04T12:00:00Z");
    await api.submitCheckin(raw);
    assert.equal(saved.checkins.length, 5);
    assert.equal(saved.checkins[4].weekStart, "2026-08-31");
    assert.equal((await api.getHistory()).monthlyCompletion.completed, 0);
    await assert.rejects(api.submitCheckin(raw), { status: 409 });
    date = new Date("2026-09-11T12:00:00Z");
    await api.submitCheckin(raw); assert.equal((await api.getHistory()).monthlyCompletion.completed, 1);
});
test("core pillars are exactly the five canonical measures and missing stress stays unavailable", async () => {
    const { PILLARS, pillarLevel } = await import("../public/js/wellbeing.mjs");
    assert.deepEqual(PILLARS.map((pillar) => pillar.key), ["wellbeing", "workload", "stress", "teamIntegration", "psychologicalSafety"]);
    assert.equal(PILLARS.find((p) => p.key === "workload").direction, "higher_is_worse");
    assert.equal(PILLARS.find((p) => p.key === "stress").direction, "higher_is_worse");
    assert.equal(pillarLevel(null, "higher_is_worse"), "Unavailable");
    assert.equal(pillarLevel(undefined, "higher_is_worse"), "Unavailable");
    assert(pillarLevel(0, "higher_is_worse").startsWith("Lower range"));
    assert(pillarLevel(6.4, "higher_is_better").startsWith("Mid-range"));
    assert(!PILLARS.some((pillar) => /clarity|vitality/i.test(pillar.label)));
});

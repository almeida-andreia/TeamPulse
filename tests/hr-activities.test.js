const test = require("node:test");
const assert = require("node:assert/strict");
const input = (extra = {}) => ({ departmentId: "1", area: "workloadBalance", type: "workshop", title: "Shared priorities workshop",
    description: "Review shared department priorities.", startsAt: "2026-12-11T14:00:00.000Z", duration: 45,
    format: "online", audience: "department", publication: "published", ...extra });
const department = (extra = {}) => ({ departmentId: "1", name: "Engineering", available: true, weekStart: "2026-11-02",
    scores: { wellbeing: 6.7, workloadBalance: 3.5, teamIntegration: 7, psychologicalSafety: 7.2, stress: null },
    monthlyChange: { wellbeing: -0.3, workloadBalance: -0.3, teamIntegration: 0.1, psychologicalSafety: -0.1, stress: null }, ...extra });

test("HR form permits the valid All departments target and preserves optional legacy areas", async () => {
    const { renderHrActivityForm } = await import("../public/js/hr-activities.mjs");
    const data = { departments: [{ id: "1", name: "Engineering" }], insights: [] };
    const fresh = renderHrActivityForm(data);
    assert.match(fresh, /<select name="departmentId"><option value="">All departments<\/option>/);
    assert.match(fresh, /<select name="area" required>/);
    const legacy = renderHrActivityForm(data, {}, { ...input(), id: "1", area: null, source: null });
    assert.match(legacy, /<select name="area"><option value="">No related area recorded<\/option>/);
});

test("activity contract reuses scheduling, duration, format, type, audience and publication fields", async () => {
    const { validateActivity } = await import("../public/js/hr-activities.mjs");
    assert.deepEqual(validateActivity(input()), input());
    assert.deepEqual(validateActivity(input({ title: "  Workshop  " })).title, "Workshop");
    assert.equal(validateActivity(input({ departmentId: null, audience: "all_employees" })).departmentId, null);
});
test("activity contract validates required fields, dates, duration, formats, types and publication", async () => {
    const { validateActivity } = await import("../public/js/hr-activities.mjs");
    for (const key of Object.keys(input())) { const body = input(); delete body[key]; assert.throws(() => validateActivity(body), { status: 400 }, key); }
    for (const extra of [{ title: " " }, { description: "x".repeat(2001) }, { type: "clinical_treatment" }, { format: "unknown" },
        { duration: 0 }, { duration: 1441 }, { duration: 2.5 }, { publication: "completed" }, { startsAt: "2026-02-30T14:00:00.000Z" },
        { startsAt: "0000-01-01T14:00:00.000Z" }, { startsAt: "2026-12-11" }, { departmentId: "9223372036854775808" },
        { departmentId: null, audience: "department" }, { area: "deadlines" }, { area: "challenge" }, { sourceWeek: "2026-11-03" },
        { sourceWeek: null }, { sourceWeek: "2026-02-30" }]) assert.throws(() => validateActivity(input(extra)), { status: 400 });
});
test("activity requests reject identity, individual answers/comments and forged aggregate context", async () => {
    const { validateActivity } = await import("../public/js/hr-activities.mjs");
    for (const extra of [{ userId: "employee" }, { responseId: "response" }, { comment: "private" }, { source: { value: 2 } },
        { source_value: 2 }, { sourceChange: -2 }, { owner: "employee" }, { status: "planned" }])
        assert.throws(() => validateActivity(input(extra)), { status: 400 });
});
test("safe activity sources select only finite released adverse department metrics and respect stress direction", async () => {
    const { safeActivityInsights } = await import("../public/js/hr-activities.mjs");
    const released = safeActivityInsights({ available: false, departments: [department(), department({ departmentId: "3", available: false })] });
    assert.deepEqual(released.map((i) => i.area), ["wellbeing", "workloadBalance", "psychologicalSafety"]);
    assert(!released.some((i) => i.departmentId === "3"));
    assert(!safeActivityInsights({ departments: [department({ scores: null })] }).length);
    const measured = department(); measured.scores.stress = 6; measured.monthlyChange.stress = 1;
    assert(safeActivityInsights({ departments: [measured] }).some((i) => i.area === "stress"));
    measured.monthlyChange.stress = -1;
    assert(!safeActivityInsights({ departments: [measured] }).some((i) => i.area === "stress"));
});
test("HR activity presentation escapes content, distinguishes source/general, filters and reuses the activity form", async () => {
    const { renderHrActivities, renderHrActivityForm, safeActivityInsights } = await import("../public/js/hr-activities.mjs");
    const data = { departments: [{ id: "1", name: "Engineering" }, { id: "3", name: "People and Operations" }],
        insights: safeActivityInsights({ departments: [department()] }), activities: [{ id: "1", ...input(), title: "<script>unsafe</script>",
            departmentName: "Engineering", targetAudience: "Engineering", status: "upcoming", registrationCount: 1, registrationOpen: true,
            createdAt: "2026-11-11T14:00:00.000Z", source: null }] };
    const html = renderHrActivities(data); assert(html.includes("&lt;script&gt;")); assert(!html.includes("<script>"));
    assert(html.includes("General activity · no measured source")); assert(html.includes("Create wellbeing activity"));
    assert(html.includes("1 registration &middot; Registration open"));
    data.activities[0].registrationCount = 0; data.activities[0].registrationOpen = false; data.activities[0].status = "completed";
    const closed = renderHrActivities(data);
    assert(closed.includes("0 registrations &middot; Registration closed")); assert(closed.includes("Completed"));
    assert(!renderHrActivities(data, { departmentId: "3" }).includes('data-hr-activity-row="1"'));
    assert(!renderHrActivities(data, { status: "draft" }).includes('data-hr-activity-row="1"'));
    const form = renderHrActivityForm(data, data.insights[0]); assert(form.includes('name="sourceWeek"')); assert(form.includes("Insight-driven activity"));
    for (const name of ["startsAt", "duration", "format", "audience", "publication"]) assert(form.includes(`name="${name}"`));
    assert(!form.includes('name="owner"')); assert(!form.includes('name="targetDate"'));
    assert.throws(() => renderHrActivityForm(data, { ...data.insights[0], departmentId: "3" }));
    assert(!renderHrActivityForm(data).includes('name="sourceWeek"'));
});
test("HR activity API requires PostgreSQL and never falls back to local demo success", async () => {
    const { createHrActivitiesApi } = await import("../public/js/hr-activities.mjs");
    await assert.rejects(createHrActivitiesApi("demo").list(), /PostgreSQL/);
    const before = globalThis.fetch;
    try {
        const requests = [];
        globalThis.fetch = async (url, config) => { requests.push({ url, config }); return { ok: false, status: 403, json: async () => ({ error: "HR only" }) }; };
        await assert.rejects(createHrActivitiesApi("postgres").create(input()), /HR only/);
        assert.equal(requests[0].url, "/api/hr/activities"); assert.equal(requests[0].config.credentials, "same-origin");
    } finally { globalThis.fetch = before; }
});

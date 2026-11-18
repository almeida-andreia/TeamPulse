const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("dynamic month options use Lisbon dates, include historical months and default to All months", async () => {
    const { monthKey, monthFilterOptions } = await import("../public/js/ui.mjs");
    assert.equal(monthKey("2027-04-30T23:30:00.000Z"), "2027-05");
    assert.equal(monthKey("2026-12-31"), "2026-12");
    const html = monthFilterOptions(["2026-11-01", "2027-01-01", "2026-11-09"]);
    assert(html.startsWith('<option value="">All months</option>'));
    assert.equal((html.match(/value="2026-11"/g) ?? []).length, 1);
    assert(html.includes("January 2027")); assert(!html.includes(" selected"));
    assert(monthFilterOptions(["2026-11-01"], "2026-11").includes('value="2026-11" selected'));
});

test("HR Month combines with department, lifecycle status and related area without losing history", async () => {
    const { renderHrActivities } = await import("../public/js/hr-activities.mjs");
    const activity = (id, startsAt, departmentId = "1", status = "completed", area = "wellbeing") => ({ id, startsAt, departmentId, status, area,
        title: `Activity ${id}`, description: "Shared support", type: "workshop", createdAt: "2026-09-01T12:00:00Z", duration: 45,
        format: "online", targetAudience: "All employees", source: null });
    const data = { insights: [], departments: [{ id: "1", name: "Engineering" }], activities: [
        activity("1", "2026-10-01T12:00:00Z"), activity("2", "2026-11-01T12:00:00Z"), activity("3", "2026-11-02T12:00:00Z", "2"),
        activity("4", "2026-11-03T12:00:00Z", "1", "draft"), activity("5", "2026-11-04T12:00:00Z", "1", "completed", "stress") ] };
    const before = structuredClone(data);
    const ids = (filters) => [...renderHrActivities(data, filters).matchAll(/data-hr-activity-row="(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids({}), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(ids({ month: "2026-10" }), ["1"]);
    assert.deepEqual(ids({ month: "2026-11", departmentId: "1", status: "completed", area: "wellbeing" }), ["2"]);
    assert.deepEqual(ids({ month: "2030-01" }), []);
    assert.deepEqual(ids({ month: "" }), ["1", "2", "3", "4", "5"]);
    assert.deepEqual(data, before);
});

test("Manager Month filters target dates while retaining overdue plans and unchanged statuses", async () => {
    const { renderActionPlans } = await import("../public/js/actions.mjs");
    const data = { teams: [{ id: "1", name: "Platform" }], actions: [
        { id: "1", title: "Historic planned action", targetDate: "2020-12-31", status: "planned" },
        { id: "2", title: "Current action", targetDate: "2026-11-13", status: "in_progress" },
        { id: "3", title: "Completed action", targetDate: "2026-12-01", status: "completed" }] };
    const before = structuredClone(data);
    for (const action of data.actions) assert(renderActionPlans(data).includes(action.title));
    const selected = renderActionPlans(data, "2020-12");
    assert(selected.includes("Historic planned action")); assert(selected.includes("Planned"));
    assert(!selected.includes("Current action")); assert(!selected.includes("Completed action"));
    assert(renderActionPlans(data, "").includes("Completed action"));
    assert.deepEqual(data, before);
});

test("Home registration notices show only own upcoming API registrations, escaped with schedule and format", async () => {
    const { renderRegistrationNotices } = await import("../public/js/ui.mjs");
    const now = Date.parse("2026-11-13T12:00:00Z");
    const a = { id: "1", title: "Team <lunch>", registered: true, registrationOpen: true, status: "upcoming", startsAt: "2026-11-17T14:00:00Z", format: "In person" };
    const html = renderRegistrationNotices([a, { ...a, id: "2", title: "Workshop" }, { ...a, id: "3", registered: false },
        { ...a, id: "4", startsAt: "2026-11-12T14:00:00Z" }, { ...a, id: "5", status: "completed" }, { ...a, id: "6", registrationOpen: false }], now);
    assert.deepEqual([...html.matchAll(/data-registration-notice="(\d+)"/g)].map((m) => m[1]), ["1", "2"]);
    assert(html.includes("Team &lt;lunch&gt;")); assert(html.includes("17 Nov 2026")); assert(html.includes("14:00 (Lisbon time)")); assert(html.includes("In person"));
    assert.equal(renderRegistrationNotices([], now), "");
});

test("registration event cards derive Lisbon calendar dates, time and mode from each activity", async () => {
    const { renderRegistrationNotices, icon } = await import("../public/js/ui.mjs");
    const registration = { id: "1", title: "Shared priorities", registered: true, registrationOpen: true, status: "upcoming", format: "Online" };
    const activities = [{ ...registration, startsAt: "2027-04-30T23:30:00Z" },
        { ...registration, id: "2", startsAt: "2027-12-03T14:00:00Z", format: "In person", location: "Room <A>" }];
    const before = structuredClone(activities), html = renderRegistrationNotices(activities, Date.parse("2027-01-01T00:00:00Z"));
    assert(html.includes('class="registration-calendar-month" aria-hidden="true">MAY</span>'));
    assert(html.includes('class="registration-calendar-day" aria-hidden="true">1</span>'));
    assert(html.includes('class="registration-calendar-month" aria-hidden="true">DEC</span>'));
    assert(html.includes('class="registration-calendar-day" aria-hidden="true">3</span>'));
    assert(html.includes("00:30 (Lisbon time)")); assert(html.includes("14:00 (Lisbon time)"));
    assert(html.includes(icon("video"))); assert(html.includes(icon("pin")));
    assert(html.includes("In person · Room &lt;A&gt;"));
    assert(!html.includes("registration-confirmation"));
    assert.equal((html.match(/Manage registration<svg/g) ?? []).length, 2);
    assert.equal((html.match(/<article class="registration-card"/g) ?? []).length, 2);
    assert.deepEqual(activities, before);
});

test("favicon references the existing approved vector mark, without external resources or a new logo", () => {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    assert(html.includes('rel="icon" type="image/svg+xml" href="/assets/teampulse-logo.svg#mark"'));
    const svg = fs.readFileSync(path.join(__dirname, "../public/assets/teampulse-logo.svg"), "utf8");
    assert(svg.includes('<view id="mark" viewBox=')); assert(!svg.includes("<image"));
});

test("Home reminders prioritise available check-in, private future appointments, then registered activities", async () => {
    const { renderHomeReminders, renderAppointmentNotices } = await import("../public/js/ui.mjs");
    const future = new Date(Date.now() + 86400000).toISOString(), past = new Date(Date.now() - 86400000).toISOString();
    const appointment = { id: "own", startsAt: future, status: "booked", format: "Online", psychologist: "Private clinician name", videoUrl: "https://private.invalid" };
    const activity = { id: "activity", startsAt: future, registered: true, registrationOpen: true, status: "upcoming", title: "Team lunch", format: "In person" };
    const appointments = [appointment, { ...appointment, id: "past", startsAt: past }, { ...appointment, id: "cancelled", status: "cancelled" }];
    const before = structuredClone(appointments);
    const html = renderHomeReminders({ available: true, submitted: false }, [activity], appointments);
    assert(html.indexOf('class="weekly-hero"') < html.indexOf('data-appointment-notice="own"'));
    assert(html.indexOf('data-appointment-notice="own"') < html.indexOf('data-registration-notice="activity"'));
    assert(!html.includes('data-appointment-notice="past"')); assert(!html.includes('data-appointment-notice="cancelled"'));
    assert(!html.includes("Private clinician name")); assert(!html.includes("https://private.invalid"));
    assert(html.includes('class="registration-card appointment-reminder"'));
    assert(html.includes('data-appointment="own"'));
    assert(html.includes('data-activity="activity"'));
    assert(html.includes("Manage appointment")); assert(html.includes("Manage registration"));
    assert(!html.includes("registration-confirmation"));
    assert(!html.includes("data-cancel-booking")); assert(!html.includes("data-register="));
    const complete = renderHomeReminders({ available: false, submitted: true, nextOpensOn: "2026-11-20" }, [activity], [appointment]);
    assert(complete.indexOf('data-appointment-notice="own"') < complete.indexOf('class="weekly-hero"'));
    assert.equal(renderAppointmentNotices([]), "");
    assert.equal(renderAppointmentNotices([{ ...appointment, startsAt: past }]), "");
    assert(renderAppointmentNotices([{ ...appointment, demo: true }]).includes("· Demo"));
    assert.deepEqual(appointments, before);
});

test("PostgreSQL Lisbon calendar opens at Friday midnight and closes Monday, across DST/year boundaries (SELECT only)",
    { skip: process.env.TEAMPULSE_TEST_POSTGRES !== "1" ? "Set TEAMPULSE_TEST_POSTGRES=1." : false }, async () => {
        const { pool } = require("../server/db"), { createEmployeeCheckins } = require("../server/employee-checkins");
        let instant;
        const service = createEmployeeCheckins(() => ({ query(sql, args) {
            assert(/^\s*SELECT/.test(sql));
            return sql.includes("AS today") ? pool.query(sql.replaceAll("CURRENT_TIMESTAMP", "$1::timestamptz"), [instant]) : pool.query(sql, args);
        } }));
        try {
            const id = await service.prototypeEmployee();
            for (const [time, week, opensOn, available] of [
                ["2026-12-31T23:59:59Z", "2026-12-28", "2027-01-01", false],
                ["2027-01-01T00:00:00Z", "2026-12-28", "2027-01-01", true],
                ["2027-05-06T22:59:59Z", "2027-05-03", "2027-05-07", false],
                ["2027-05-06T23:00:00Z", "2027-05-03", "2027-05-07", true],
                ["2027-05-09T22:59:59Z", "2027-05-03", "2027-05-07", true],
                ["2027-05-09T23:00:00Z", "2027-05-10", "2027-05-14", false]
            ]) {
                instant = time; const status = await service.status(id);
                assert.equal(status.weekStart, week, time); assert.equal(status.opensOn, opensOn, time); assert.equal(status.available, available, time);
            }
        } finally { await pool.end(); }
    });

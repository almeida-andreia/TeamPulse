const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../public/js/demo-employee-api.mjs");
const answers = { wellbeing: "positive", workload: "manageable", stress: 3, teamIntegration: "connected", psychologicalSafety: 4, challenges: ["workload"], comment: "A fictional demo comment." };
function memoryStorage() {
    const values = new Map();
    return { getItem: (key = "teampulse.employee-demo.v1") => values.get(key) ?? null, setItem: (key, next) => { values.set(key, next); } };
}

test("a weekly submission survives reload, rejects duplicates, and opens again next week", async () => {
    const { createDemoEmployeeApi } = await load();
    const storage = memoryStorage();
    let clock = new Date("2026-11-09T12:00:00Z");
    const now = () => clock;
    const api = createDemoEmployeeApi({ storage, now });
    assert.equal((await api.getCheckinStatus()).submitted, false);
    await api.submitCheckin(answers);
    await assert.rejects(api.submitCheckin(answers), { status: 409 });
    const reloaded = createDemoEmployeeApi({ storage, now });
    assert.equal((await reloaded.getCheckinStatus()).submitted, true);
    const history = await reloaded.getHistory("year");
    assert.equal(history.latest.wellbeing, 7.5);
    assert.equal(history.latest.workload, 3.3);
    assert.equal(history.latest.stress, 5);
    assert.equal(history.latest.teamIntegration, 6.7);
    assert.equal(history.latest.psychologicalSafety, 7.5);
    assert.equal(history.entries.filter((entry) => entry.weekStart === "2026-11-09").length, 1);
    assert(!JSON.stringify(history).includes(answers.comment));
    assert(!Object.hasOwn(history.latest, "challenges"));
    clock = new Date("2026-11-16T12:00:00Z");
    assert.equal((await reloaded.getCheckinStatus()).submitted, false);
    await reloaded.submitCheckin(answers);
});

test("invalid scores, duplicate/unknown factors, and oversized comments are not saved", async () => {
    const { createDemoEmployeeApi } = await load();
    const api = createDemoEmployeeApi({ storage: null });
    for (const payload of [
        { ...answers, wellbeing: undefined }, { ...answers, workload: 11 },
        { ...answers, stress: undefined }, { ...answers, psychologicalSafety: 0 },
        { ...answers, challenges: ["workload", "workload"] },
        { ...answers, challenges: ["unsupported"] }, { ...answers, comment: "x".repeat(2001) }
    ]) await assert.rejects(api.submitCheckin(payload), { status: 400 });
    assert.equal((await api.getCheckinStatus()).submitted, false);
});

test("weeks follow Lisbon's calendar, including summer time near Sunday midnight", async () => {
    const { weekKey } = await load();
    assert.equal(weekKey(new Date("2026-07-05T22:59:59Z")), "2026-06-29");
    assert.equal(weekKey(new Date("2026-07-05T23:00:00Z")), "2026-07-06");
    assert.equal(weekKey(new Date("2026-11-08T23:59:59Z")), "2026-11-02");
    assert.equal(weekKey(new Date("2026-11-09T00:00:00Z")), "2026-11-09");
});

test("history periods have calendar boundaries and contain only this Employee's indicator DTO", async () => {
    const { createDemoEmployeeApi } = await load();
    const api = createDemoEmployeeApi({ storage: null, now: () => new Date("2026-11-09T12:00:00Z") });
    const recent = await api.getHistory("30days"), quarter = await api.getHistory("quarter"), year = await api.getHistory("year");
    assert.equal(recent.entries.length, 4);
    assert(quarter.entries.every((item) => item.weekStart >= "2026-10-01"));
    assert.equal(year.entries.length, 8);
    assert.equal(typeof year.monthlyChange.wellbeing, "number");
    assert.deepEqual(Object.keys(year.latest).sort(), ["weekStart", "wellbeing", "workload", "stress", "teamIntegration", "psychologicalSafety"].sort());
    assert(year.entries.every((entry) => entry.stress === null));
    assert.equal(year.monthlyChange.stress, null);
    await assert.rejects(api.getHistory("arbitrary"), { status: 400 });
});

test("activity registrations are idempotent and private to the current demo tab", async () => {
    const { createDemoEmployeeApi } = await load();
    const now = () => new Date("2026-11-09T12:00:00Z");
    const storage = memoryStorage(), api = createDemoEmployeeApi({ storage, now });
    const activity = (await api.getActivities())[0];
    await api.registerActivity(activity.id); await api.registerActivity(activity.id);
    assert.equal((await createDemoEmployeeApi({ storage, now }).getActivities())[0].registered, true);
    assert.equal((await createDemoEmployeeApi({ storage: null, now }).getActivities())[0].registered, false);
    await assert.rejects(api.registerActivity("missing"), { status: 404 });
});

test("bookings reject an occupied slot; rescheduling and cancellation free the previous slot", async () => {
    const { createDemoEmployeeApi } = await load();
    const api = createDemoEmployeeApi({ storage: null, now: () => new Date("2026-11-09T12:00:00Z") });
    const [first, second] = await api.getSlots();
    const booking = await api.bookSlot(first.id);
    await assert.rejects(api.bookSlot(first.id), { status: 409 });
    await api.rescheduleBooking(booking.id, second.id);
    let slots = await api.getSlots();
    assert.equal(slots.find((item) => item.id === first.id).available, true);
    assert.equal(slots.find((item) => item.id === second.id).available, false);
    await api.cancelBooking(booking.id);
    slots = await api.getSlots();
    assert.equal(slots.find((item) => item.id === second.id).available, true);
    assert.equal((await api.getBookings())[0].status, "cancelled");
});

test("booking times stay fixed across reloads, and the two-hour cutoff is enforced", async () => {
    const { createDemoEmployeeApi } = await load();
    const storage = memoryStorage();
    let clock = new Date("2026-11-09T12:00:00Z");
    const now = () => clock, api = createDemoEmployeeApi({ storage, now });
    const slot = (await api.getSlots())[0], booking = await api.bookSlot(slot.id);
    clock = new Date(new Date(slot.startsAt).getTime() - 7200000);
    const reloaded = createDemoEmployeeApi({ storage, now });
    assert.equal((await reloaded.getBookings())[0].startsAt, slot.startsAt);
    assert.equal((await reloaded.getBookings())[0].canChange, true);
    clock = new Date(clock.getTime() + 1);
    await assert.rejects(reloaded.cancelBooking(booking.id), { status: 400 });
    await assert.rejects(reloaded.rescheduleBooking(booking.id, "anything"), { status: 400 });
});

test("a storage failure leaves an operable in-memory preview", async () => {
    const { createDemoEmployeeApi } = await load();
    const api = createDemoEmployeeApi({ storage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
    await api.submitCheckin(answers);
    assert.equal((await api.getCheckinStatus()).submitted, true);
});

test("HTTP adapter uses Employee endpoints and never treats an API error as a demo success", async () => {
    const { createHttpEmployeeApi } = await import("../public/js/employee-api.mjs");
    const originalFetch = globalThis.fetch;
    const calls = [];
    try {
        globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({ weekStart: "2026-11-09" }) }; };
        const api = createHttpEmployeeApi();
        await api.submitCheckin(answers);
        assert.equal(calls[0].url, "/api/employee/check-ins");
        assert.equal(calls[0].options.method, "POST");
        assert.equal(calls[0].options.credentials, "same-origin");
        assert(!Object.hasOwn(JSON.parse(calls[0].options.body), "userId"));
        assert.deepEqual(JSON.parse(calls[0].options.body), answers);
        await assert.rejects(api.submitCheckin({ ...answers, user_id: "another-employee" }), { status: 400 });
        await assert.rejects(api.submitCheckin({ ...answers, stress_score: 5 }), { status: 400 });
        assert.equal(calls.length, 1, "private/normalized fields must not reach fetch");
        globalThis.fetch = async () => ({ ok: false, status: 409 });
        await assert.rejects(api.submitCheckin(answers), { status: 409 });
        globalThis.fetch = async () => { throw new Error("private transport details"); };
        await assert.rejects(api.getHistory(), (error) => error.status === 0 && !error.message.includes("private transport details"));
    } finally { globalThis.fetch = originalFetch; }
});

test("Employee views support demo data and first-time API histories without database requests", async () => {
    // A small DOM stand-in exercises module startup and route rendering. This is
    // a component smoke check, not a replacement for visual/browser verification.
    const originals = new Map();
    const install = (key, value) => {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    };
    const element = () => ({ innerHTML: "", textContent: "", hidden: false, setAttribute() {}, removeAttribute() {}, focus() {} });
    const main = element(), nav = element(), listeners = new Map();
    const accessEvents = new Map();
    const accessForm = { addEventListener: (name, callback) => accessEvents.set(name, callback), querySelector: () => ({ value: "employee" }) };
    const dialog = { ...element(), open: false, close() { this.open = false; }, showModal() { this.open = true; } };
    const nodes = new Map([
        ["main", main], ["#detail-dialog", dialog], ["#employee-nav", nav],
        ["#today-label", element()], ["#employee-name", element()], [".avatar", element()],
        ["#toast", element()], ["#dialog-content", element()],
        [".demo-notice", element()], [".demo-pill", element()], [".profile small", element()],
        ["#prototype-form", accessForm],
        ['meta[name="teampulse-data-source"]', { content: "demo" }]
    ]);
    let networkRequests = 0;
    try {
        install("document", { querySelector: (selector) => nodes.get(selector) ?? null, querySelectorAll: () => [], addEventListener() {}, title: "" });
        install("window", { addEventListener: (name, callback) => listeners.set(name, callback), scrollTo() {} });
        install("location", { hash: "#home" });
        const previewStorage = memoryStorage(); previewStorage.setItem("teampulse.prototype-role.v1", "employee");
        install("sessionStorage", previewStorage);
        install("fetch", async () => { networkRequests++; throw new Error("Network access is forbidden in demo mode"); });
        await import("../public/js/app.mjs");
        assert(main.innerHTML.includes("Your Wellbeing Space"));
        assert(main.innerHTML.includes('aria-label="Check-ins completed this month: 0 out of 4"'));
        assert(!nav.innerHTML.includes("My sessions"));
        for (const label of ["Home", "Check-in", "My Wellbeing", "Support"]) assert(nav.innerHTML.includes(`>${label}</a>`));
        for (const [route, expected] of [
            ["check-in", "How have you been feeling at work recently?"],
            ["history", "Your wellbeing, over time."],
            ["support", "Support that fits your week."],
            ["sessions", "A private space to talk."]
        ]) {
            globalThis.location.hash = `#${route}`;
            await listeners.get("hashchange")();
            assert(main.innerHTML.includes(expected), route);
            if (route === "history") {
                assert(main.innerHTML.includes("Core Pillars"));
                for (const label of ["Wellbeing", "Workload pressure", "Stress", "Team connection", "Psychological safety"])
                    assert(main.innerHTML.includes(`<h3>${label}</h3>`));
                assert(main.innerHTML.includes('<h3>Stress</h3><strong>Unavailable</strong>'));
            }
            assert(!main.innerHTML.includes('class="error-panel"'), route);
            assert(nav.innerHTML.includes(`href="#${route === "sessions" ? "support" : route}" class="nav-link" aria-current="page"`));
        }
        assert.equal(networkRequests, 0);

        // Exercise the same views through the HTTP adapter with a first-time
        // Employee response. fetch is mocked; there is no Express/DB request.
        nodes.get('meta[name="teampulse-data-source"]').content = "http";
        globalThis.location.hash = "#home";
        const apiCalls = [];
        let checkinAvailable = false;
        globalThis.fetch = async (url) => {
            apiCalls.push(url);
            const path = new URL(url, "http://test.invalid").pathname;
            const fixtures = {
                "/api/employee/me": { firstName: "Rita", displayName: "Rita Costa", role: "employee" },
                "/api/employee/check-ins/current": { submitted: false, available: checkinAvailable,
                    weekStart: "2026-11-09", nextWeek: "2026-11-16", opensOn: "2026-11-13", nextOpensOn: "2026-11-20" },
                "/api/employee/history": { entries: [], latest: null, monthlyChange: null },
                "/api/employee/activities": [],
                "/api/employee/appointment-reminders": []
            };
            assert(Object.hasOwn(fixtures, path), `Unexpected request: ${path}`);
            return { ok: true, status: 200, json: async () => fixtures[path] };
        };
        await import("../public/js/app.mjs?first-time-employee");
        await accessEvents.get("submit")({ preventDefault() {}, currentTarget: accessForm });
        assert(main.innerHTML.includes("Your first reflection starts here."));
        assert(!main.innerHTML.includes('class="error-panel"'));
        assert(!main.innerHTML.includes('class="big-score"'));
        globalThis.location.hash = "#history";
        await listeners.get("hashchange")();
        assert(main.innerHTML.includes("Your first reflection starts here."));
        assert(main.innerHTML.includes("data-export disabled"));
        assert(!main.innerHTML.includes('class="error-panel"'));
        assert(apiCalls.every((url) => url.startsWith("/api/employee/")));
        globalThis.location.hash = "#check-in";
        await listeners.get("hashchange")();
        assert(main.innerHTML.includes("Opens Friday"));
        assert(!main.innerHTML.includes('id="checkin-form"'));
        checkinAvailable = true;
        await listeners.get("hashchange")();
        assert(main.innerHTML.includes('id="checkin-form"'));
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

test("check-in handlers preserve raw answers across Back/Continue and submit all five scores", async () => {
    const originals = new Map(), nodes = new Map(), windowEvents = new Map();
    const install = (key, value) => {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    };
    const element = () => ({ innerHTML: "", textContent: "", hidden: false, events: new Map(),
        setAttribute() {}, removeAttribute() {}, focus() {}, addEventListener(name, callback) { this.events.set(name, callback); } });
    const main = element(), dialog = { ...element(), close() {}, open: false };
    let html = "", backButtons = [], requests = 0;
    const accessEvents = new Map();
    const accessForm = { querySelector: () => ({ value: "employee" }), addEventListener: (name, callback) => accessEvents.set(name, callback) };
    // Rebuild only the form surface on render, so the real app handlers must
    // save and restore state rather than relying on retained input elements.
    Object.defineProperty(main, "innerHTML", { get: () => html, set(value) {
        html = value; backButtons = [];
        for (const key of ["#checkin-form", "#checkin-error", "[data-back]"]) nodes.delete(key);
        if (!html.includes('id="checkin-form"')) return;
        const form = { ...element(), values: new Map(), submitButton: element(),
            querySelector: () => form.submitButton };
        for (const input of html.matchAll(/<input\b[^>]*>/g)) {
            const name = /name="([^"]+)"/.exec(input[0])?.[1];
            const value = /value="([^"]+)"/.exec(input[0])?.[1];
            if (name && /\bchecked\b/.test(input[0])) {
                if (name === "challenges") form.values.set(name, [...(form.values.get(name) || []), value]);
                else form.values.set(name, value);
            }
        }
        const comment = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html);
        if (comment) form.values.set("comment", comment[1]);
        nodes.set("#checkin-form", form); nodes.set("#checkin-error", element());
        backButtons = [...html.matchAll(/\bdata-back\b/g)].map(() => element());
        if (backButtons.length) nodes.set("[data-back]", backButtons[0]);
    } });
    for (const key of ["#employee-nav", "#today-label", "#employee-name", ".avatar", "#page-title"]) nodes.set(key, element());
    nodes.set("main", main); nodes.set("#detail-dialog", dialog);
    nodes.set("#prototype-form", accessForm);
    nodes.set('meta[name="teampulse-data-source"]', { content: "demo" });
    const storage = memoryStorage();
    storage.setItem("teampulse.prototype-role.v1", "employee");
    const submit = () => nodes.get("#checkin-form").events.get("submit")({ preventDefault() {} });
    const set = (values) => { for (const [key, value] of Object.entries(values)) nodes.get("#checkin-form").values.set(key, value); };
    const checked = (name, value) => assert(html.includes(`name="${name}" value="${value}" required checked`), `${name}=${value} was not restored`);
    try {
        install("document", { querySelector: (selector) => nodes.get(selector) ?? null,
            querySelectorAll: (selector) => selector === "[data-back]" ? backButtons : [], addEventListener() {}, title: "" });
        install("window", { addEventListener: (name, callback) => windowEvents.set(name, callback), scrollTo() {} });
        install("location", { hash: "#check-in" }); install("sessionStorage", storage);
        install("FormData", class {
            constructor(form) { this.values = form.values; }
            has(key) { return this.values.has(key); }
            get(key) { return this.values.get(key) ?? null; }
            getAll(key) { return this.values.get(key) ?? []; }
        });
        install("fetch", async () => { requests++; throw new Error("No network in demo flow"); });
        await import("../public/js/app.mjs?questionnaire-flow");
        await submit();
        assert.equal(nodes.get("#checkin-error").hidden, false);
        assert(html.includes("Very positive"));
        assert(html.includes("Step 1 of 4"));
        assert(html.includes("Take a breath and answer freely."));
        assert(html.includes("About 2 minutes"));
        set({ wellbeing: "positive" }); await submit();
        assert(html.includes('name="stress"'));
        set({ workload: "manageable" }); await submit();
        assert.equal(nodes.get("#checkin-error").hidden, false);
        assert(!html.includes('name="teamIntegration"'));
        set({ stress: "4" }); await nodes.get("[data-back]").events.get("click")();
        checked("wellbeing", "positive"); await submit();
        checked("workload", "manageable"); checked("stress", "4");
        set({ workload: "difficult", stress: "2" }); await submit();
        assert(html.includes("Strong mutual trust and collaboration."));
        assert(html.includes("Good alignment and regular healthy communication."));
        assert(html.includes("Occasional silos or feeling left out of key discussions."));
        assert(html.includes("Rarely collaborate, feeling lonely or unsupported."));
        set({ teamIntegration: "connected" }); await submit();
        assert.equal(nodes.get("#checkin-error").hidden, false);
        set({ psychologicalSafety: "3" }); await submit();
        set({ challenges: ["deadlines", "organizational_changes"], comment: "Fictional context" });
        await nodes.get("[data-back]").events.get("click")();
        checked("teamIntegration", "connected"); checked("psychologicalSafety", "3");
        await backButtons[1].events.get("click")();
        await backButtons[0].events.get("click")(); checked("wellbeing", "positive");
        await submit(); checked("workload", "difficult"); checked("stress", "2");
        await submit(); checked("psychologicalSafety", "3"); await submit();
        assert(html.includes('value="deadlines" checked'));
        assert(html.includes('value="organizational_changes" checked'));
        assert(html.includes(">Fictional context</textarea>"));
        await submit(); assert(html.includes("Thank you for checking in."));
        assert(html.includes("Your weekly check-in has been submitted successfully. You're all set for this week."));
        assert(html.includes('href="#history"'));
        assert(html.includes("Your response is anonymous."));
        const saved = JSON.parse(storage.getItem()).checkins;
        assert.equal(saved.length, 1);
        assert.deepEqual({ ...saved[0], weekStart: "checked-separately" }, { weekStart: "checked-separately",
            wellbeing: 7.5, workload: 6.7, stress: 2.5, teamIntegration: 6.7, psychologicalSafety: 5,
            challenges: ["deadlines", "organizational_changes"], comment: "Fictional context" });
        await import("../public/js/app.mjs?questionnaire-reload");
        assert(html.includes("Thank you for checking in."));
        globalThis.location.hash = "#history"; await windowEvents.get("hashchange")();
        assert(html.includes("<th scope=\"col\">Stress</th>"));
        assert(html.includes("Unavailable"));
        assert.equal(requests, 0);

        // Exercise an async HTTP write: failed submissions retain the draft,
        // and Enter/programmatic resubmission cannot send a second in-flight POST.
        nodes.get('meta[name="teampulse-data-source"]').content = "http";
        globalThis.location.hash = "#check-in";
        let posted = 0, completePost, submitted = false, lastPayload;
        globalThis.fetch = async (url, options = {}) => {
            const path = new URL(url, "http://test.invalid").pathname;
            const ok = (body) => ({ ok: true, status: 200, json: async () => body });
            if (path === "/api/employee/check-ins" && options.method === "POST") {
                posted++; lastPayload = JSON.parse(options.body);
                if (posted === 1) return { ok: false, status: 503 };
                return new Promise((resolve) => { completePost = () => { submitted = true; resolve(ok({ weekStart: "2026-11-09" })); }; });
            }
            const fixtures = {
                "/api/employee/me": { firstName: "Ana", displayName: "Ana Silva", role: "employee" },
                "/api/employee/check-ins/current": { submitted, weekStart: "2026-11-09", nextWeek: "2026-11-16" },
                "/api/employee/history": { entries: [], latest: null, monthlyChange: null },
                "/api/employee/activities": [],
                "/api/employee/appointment-reminders": []
            };
            assert(Object.hasOwn(fixtures, path), `Unexpected request: ${path}`);
            return ok(fixtures[path]);
        };
        await import("../public/js/app.mjs?checkin-async-http");
        await accessEvents.get("submit")({ preventDefault() {}, currentTarget: accessForm });
        globalThis.location.hash = "#check-in"; await windowEvents.get("hashchange")();
        set({ wellbeing: "positive" }); await submit();
        set({ workload: "manageable", stress: "4" }); await submit();
        set({ teamIntegration: "connected", psychologicalSafety: "1" }); await submit();
        assert(html.includes("Choose all options that apply (multiple choice)."));
        assert(html.includes("ADD CONTEXT (OPTIONAL)"));
        assert(html.includes('maxlength="2000"'));
        // Zero challenges and an empty comment are valid.
        const finalForm = nodes.get("#checkin-form");
        await submit();
        assert.equal(nodes.get("#checkin-error").hidden, false);
        assert.equal(finalForm.submitButton.disabled, false);
        assert.equal(finalForm.values.get("comment"), "");
        const pendingSubmission = submit();
        await submit();
        assert.equal(posted, 2, "one failed attempt plus one in-flight retry only");
        assert.equal(finalForm.submitButton.disabled, true);
        assert.deepEqual(lastPayload, { wellbeing: "positive", workload: "manageable", stress: 4,
            teamIntegration: "connected", psychologicalSafety: 1, challenges: [], comment: "" });
        completePost(); await pendingSubmission;
        assert(html.includes("Thank you for checking in."));
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

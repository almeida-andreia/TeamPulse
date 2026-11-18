const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("root opens Demo Access; role selection leads to isolated spaces and preserves demo history", async () => {
    const original = new Map(), nodes = new Map(), routes = new Map(), submits = new Map();
    const install = (key, value) => {
        original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    };
    const element = () => ({ innerHTML: "", textContent: "", hidden: false, setAttribute() {}, removeAttribute() {}, focus() {} });
    let selected = "employee", requests = 0;
    const main = element(), nav = element(), access = element(), sidebar = element(), workspace = element();
    const form = { querySelector: () => ({ value: selected }), addEventListener: (name, callback) => submits.set(name, callback) };
    const dialog = { ...element(), open: false, close() { this.open = false; }, showModal() { this.open = true; } };
    for (const [key, value] of [["main", main], ["#employee-nav", nav], ["#prototype-access", access], [".sidebar", sidebar],
        [".workspace", workspace], ["#prototype-form", form], ["#detail-dialog", dialog]]) nodes.set(key, value);
    for (const key of ["#access-error", "#role-badge", "#privacy-label", "#today-label", ".demo-notice"]) nodes.set(key, element());
    nodes.set('meta[name="teampulse-data-source"]', { content: "demo" });
    const savedHistory = JSON.stringify({ version: 1, checkins: [], registrations: ["saved-registration"], bookings: [] });
    const values = new Map([["teampulse.employee-demo.v1", savedHistory], ["teampulse.prototype-role.v1", "employee"]]);
    const enter = () => submits.get("submit")({ preventDefault() {}, currentTarget: form });
    try {
        install("document", { body: { classList: { toggle() {} } }, title: "", querySelector: (key) => nodes.get(key) ?? null,
            querySelectorAll: () => [], addEventListener() {} });
        install("window", { addEventListener: (name, callback) => routes.set(name, callback), scrollTo() {} });
        install("location", { hash: "" });
        install("sessionStorage", { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
        install("fetch", async () => { requests++; throw new Error("Prototype entry must not request a database or external SSO"); });
        const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
        assert(html.includes('id="prototype-access"'));
        assert(html.includes('class="workspace" hidden'));
        assert(html.includes("A space to be heard,"));
        assert(html.includes("Enter demo"));
        for (const name of ["Beatriz Sousa", "Mara Duarte", "Marta Pinto"]) assert(html.includes(name));
        assert(!/Continue with (Microsoft|Google|work email)/.test(html));
        await import("../public/js/app.mjs?prototype-entry-test");
        assert.equal(document.title, "Demo Access · TeamPulse");
        assert.equal(access.hidden, false); assert.equal(workspace.hidden, true);
        assert.equal(main.innerHTML, ""); assert.equal(requests, 0);
        assert.equal(values.get("teampulse.employee-demo.v1"), savedHistory);
        await enter();
        assert.equal(location.hash, "#home");
        assert.equal(access.hidden, true); assert.equal(workspace.hidden, false);
        assert(main.innerHTML.includes("Your Wellbeing Space"));
        for (const label of ["Home", "Check-in", "My Wellbeing", "Support"]) assert(nav.innerHTML.includes(`>${label}</a>`));
        assert.equal((nav.innerHTML.match(/class="nav-link"/g) || []).length, 4);
        assert(!main.innerHTML.includes("Good afternoon"));
        location.hash = "#auth"; await routes.get("hashchange")();
        assert.equal(main.innerHTML, ""); assert.equal(access.hidden, false);
        selected = "manager"; await enter();
        assert.equal(location.hash, "#manager");
        assert(main.innerHTML.includes("Team wellbeing")); assert(!main.innerHTML.includes("Your Wellbeing Space"));
        location.hash = "#history"; await routes.get("hashchange")();
        assert(main.innerHTML.includes("Team wellbeing")); assert(main.innerHTML.includes("No organization metrics are simulated"));
        assert(!main.innerHTML.includes("Latest scores"));
        location.hash = "#auth"; await routes.get("hashchange")();
        selected = "hr"; await enter();
        assert.equal(location.hash, "#organization"); assert(main.innerHTML.includes("Organization wellbeing"));
        assert(!main.innerHTML.includes("My month")); assert.equal(nodes.get("#privacy-label").textContent, "Aggregated view");
        assert.equal(values.get("teampulse.employee-demo.v1"), savedHistory);
        assert.equal(requests, 0);
        // A browser role never authorizes the real HTTP adapter.
        nodes.get('meta[name="teampulse-data-source"]').content = "http";
        location.hash = "";
        await import("../public/js/app.mjs?http-prototype-entry-test");
        selected = "manager"; await enter();
        assert.equal(access.hidden, false); assert.equal(workspace.hidden, true);
        assert(nodes.get("#access-error").textContent.includes("cannot grant API access"));
        assert.equal(requests, 0);
    } finally {
        for (const [key, descriptor] of original) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
        }
    }
});

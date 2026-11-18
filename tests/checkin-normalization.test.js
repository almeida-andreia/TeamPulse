const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../public/js/checkin.mjs");
const answers = { wellbeing: "positive", workload: "manageable", stress: 3,
    teamIntegration: "connected", psychologicalSafety: 4, challenges: [], comment: "" };

test("all approved categorical answers normalize to their exact scores", async () => {
    const { normalizeCheckin } = await load();
    const expected = {
        wellbeing: { very_positive: 10, positive: 7.5, neutral: 5, struggling: 2.5, very_difficult: 0 },
        workload: { very_manageable: 0, manageable: 3.3, difficult: 6.7, very_difficult: 10 },
        teamIntegration: { very_connected: 10, connected: 6.7, distant: 3.3, disconnected: 0 }
    };
    for (const [key, options] of Object.entries(expected)) for (const [answer, score] of Object.entries(options)) {
        assert.equal(normalizeCheckin({ ...answers, [key]: answer })[key], score, `${key}: ${answer}`);
    }
});

test("stress and psychological safety independently map 1..5 to 0..10", async () => {
    const { normalizeCheckin, SCORE_DIRECTIONS } = await load();
    for (const key of ["stress", "psychologicalSafety"]) for (const [index, score] of [0, 2.5, 5, 7.5, 10].entries()) {
        const result = normalizeCheckin({ ...answers, [key]: index + 1 });
        assert.equal(result[key], score);
        assert.equal(result[key === "stress" ? "psychologicalSafety" : "stress"], key === "stress" ? 7.5 : 5);
    }
    assert.deepEqual(SCORE_DIRECTIONS, { wellbeing: "higher_is_better", workload: "higher_is_worse",
        stress: "higher_is_worse", teamIntegration: "higher_is_better", psychologicalSafety: "higher_is_better" });
});

test("all five answers are required; categories and ratings cannot be replaced by arbitrary scores", async () => {
    const { normalizeCheckin, SCORE_FIELDS } = await load();
    for (const key of SCORE_FIELDS) {
        for (const invalid of [undefined, null, false, {}, []]) {
            assert.throws(() => normalizeCheckin({ ...answers, [key]: invalid }), { status: 400 });
        }
    }
    for (const key of ["stress", "psychologicalSafety"]) for (const invalid of [0, 6, 2.5, "3", NaN, Infinity]) {
        assert.throws(() => normalizeCheckin({ ...answers, [key]: invalid }), { status: 400 });
    }
    for (const key of ["wellbeing", "workload", "teamIntegration"]) for (const invalid of [7.5, "unsupported", "toString", "__proto__"]) {
        assert.throws(() => normalizeCheckin({ ...answers, [key]: invalid }), { status: 400 });
    }
});

test("each check-in step requires both workload/stress and connection/safety before continuing", async () => {
    const { validateCheckinStep } = await load();
    validateCheckinStep({ wellbeing: "neutral" }, 0);
    assert.throws(() => validateCheckinStep({}, 0), { status: 400 });
    for (const [step, payload] of [[1, { workload: "manageable" }], [1, { stress: 3 }],
        [2, { teamIntegration: "connected" }], [2, { psychologicalSafety: 3 }]]) {
        assert.throws(() => validateCheckinStep(payload, step), { status: 400 });
    }
    validateCheckinStep({ workload: "manageable", stress: 3 }, 1);
    validateCheckinStep({ teamIntegration: "connected", psychologicalSafety: 3 }, 2);
});

test("optional context and zero challenges are valid without changing canonical challenge codes", async () => {
    const { normalizeCheckin } = await load();
    const empty = normalizeCheckin({ ...answers, challenges: [], comment: undefined });
    assert.deepEqual(empty.challenges, []); assert.equal(empty.comment, "");
    const context = normalizeCheckin({ ...answers, challenges: ["communication", "unclear_priorities"], comment: "  Optional context  " });
    assert.deepEqual(context.challenges, ["communication", "unclear_priorities"]);
    assert.equal(context.comment, "Optional context");
    assert.equal(normalizeCheckin({ ...answers, comment: "x".repeat(2000) }).comment.length, 2000);
    for (const comment of [null, 42, {}, "x".repeat(2001)]) assert.throws(() => normalizeCheckin({ ...answers, comment }), { status: 400 });
});

test("exact eight challenge codes are accepted, while removed/unknown/duplicate choices are rejected", async () => {
    const { CHALLENGES, normalizeCheckin } = await load();
    const expected = ["workload", "deadlines", "communication", "difficulty_integrating",
        "unclear_priorities", "limited_support", "work_life_balance", "organizational_changes"];
    assert.deepEqual(CHALLENGES.map((choice) => choice.id), expected);
    assert.deepEqual(CHALLENGES.map((choice) => choice.label), ["Workload", "Deadlines", "Team communication",
        "Difficulty integrating", "Lack of clarity", "Lack of support", "Work-life balance", "Organizational changes"]);
    assert.deepEqual(normalizeCheckin({ ...answers, challenges: expected }).challenges, expected);
    for (const challenges of [["tools_processes"], ["unknown"], ["workload", "workload"], [null], "workload", null]) {
        assert.throws(() => normalizeCheckin({ ...answers, challenges }), { status: 400 });
    }
});

test("raw payload has no ownership or normalized fields and normalization does not mutate it", async () => {
    const { createCheckinPayload, normalizeCheckin } = await load();
    const original = { ...answers, challenges: ["deadlines"], comment: "  Optional context  " };
    const payload = createCheckinPayload(original), normalized = normalizeCheckin(original);
    assert.deepEqual(payload, original);
    assert.notStrictEqual(payload.challenges, original.challenges);
    assert.equal(original.comment, "  Optional context  ");
    assert.equal(normalized.comment, "Optional context");
    assert.deepEqual(Object.keys(normalized).sort(), ["wellbeing", "workload", "stress", "teamIntegration", "psychologicalSafety", "challenges", "comment"].sort());
    for (const key of ["userId", "user_id", "role", "team_id", "week_start", "response_id", "stress_score", "workloadBalance"]) {
        assert.throws(() => createCheckinPayload({ ...answers, [key]: "untrusted" }), { status: 400 });
    }
    assert.equal(normalizeCheckin({ ...answers, comment: undefined }).comment, "");
    assert.throws(() => normalizeCheckin({ ...answers, comment: "x".repeat(2001) }), { status: 400 });
});

test("legacy continuous browser history survives unchanged and missing stress remains null", async () => {
    const { createDemoEmployeeApi } = await import("../public/js/demo-employee-api.mjs");
    const old = { version: 1, checkins: [{ weekStart: "2026-11-09", wellbeing: 7.9, workload: 6.2,
        teamIntegration: 8.1, psychologicalSafety: 7.3, challenges: ["tools_processes"], comment: "Legacy private context" }],
        registrations: ["saved-activity"], bookings: [] };
    let saved = JSON.stringify(old), writes = 0;
    const storage = { getItem: () => saved, setItem: (_, value) => { writes++; saved = value; } };
    const api = createDemoEmployeeApi({ storage, now: () => new Date("2026-11-10T12:00:00Z") });
    const history = await api.getHistory("year");
    assert.deepEqual(history.latest, { weekStart: "2026-11-09", wellbeing: 7.9, workload: 6.2,
        stress: null, teamIntegration: 8.1, psychologicalSafety: 7.3 });
    assert.equal(history.monthlyChange.stress, null);
    assert.equal(writes, 0);
    assert.deepEqual(JSON.parse(saved), old);
    assert.equal((await api.getCheckinStatus()).submitted, true);
    await assert.rejects(api.submitCheckin(answers), { status: 409 });
    assert(!JSON.stringify(history).includes("Legacy private context"));
    assert(!JSON.stringify(history).includes("tools_processes"));
    const nextWeek = createDemoEmployeeApi({ storage, now: () => new Date("2026-11-17T12:00:00Z") });
    await nextWeek.submitCheckin(answers);
    const persisted = JSON.parse(saved);
    assert.deepEqual(persisted.checkins[0], old.checkins[0]);
    assert.deepEqual(persisted.registrations, old.registrations);
    assert.deepEqual(persisted.bookings, old.bookings);
    assert.equal(persisted.checkins[1].stress, 5);
});

test("stress monthly changes exclude missing values and include genuine zero scores", async () => {
    const { createDemoEmployeeApi } = await import("../public/js/demo-employee-api.mjs");
    const record = { wellbeing: 7.9, workload: 6.2, teamIntegration: 8.1, psychologicalSafety: 7.3 };
    const saved = JSON.stringify({ version: 1, checkins: [
        { ...record, weekStart: "2026-10-26", stress: 5 },
        { ...record, weekStart: "2026-11-02" }, { ...record, weekStart: "2026-11-09", stress: 0 }
    ], registrations: [], bookings: [] });
    const api = createDemoEmployeeApi({ storage: { getItem: () => saved }, now: () => new Date("2026-11-10T12:00:00Z") });
    const history = await api.getHistory("year");
    assert.equal(history.latest.stress, 0);
    assert.equal(history.entries.find((entry) => entry.weekStart === "2026-11-02").stress, null);
    assert.equal(history.monthlyChange.stress, -5);
});

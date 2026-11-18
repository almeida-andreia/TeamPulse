// Approved raw-answer contract and normalization. Pure ES module: also importable
// by the future Express service, which MUST validate raw inputs server-side.
// Browser/demo validation is not authentication, authorization or persistence.
const choices = (items) => Object.freeze(items.map(([id, label, score, description]) => Object.freeze({ id, label, score, ...(description ? { description } : {}) })));
export const ANSWER_OPTIONS = Object.freeze({
    wellbeing: choices([
        ["very_positive", "Very positive", 10], ["positive", "Positive", 7.5],
        ["neutral", "Neutral", 5], ["struggling", "Struggling", 2.5],
        ["very_difficult", "Very difficult", 0]
    ]),
    workload: choices([
        ["very_manageable", "Very manageable", 0], ["manageable", "Manageable", 3.3],
        ["difficult", "Difficult", 6.7], ["very_difficult", "Very difficult", 10]
    ]),
    teamIntegration: choices([
        ["very_connected", "Very connected", 10, "Strong mutual trust and collaboration."],
        ["connected", "Connected", 6.7, "Good alignment and regular healthy communication."],
        ["distant", "Distant", 3.3, "Occasional silos or feeling left out of key discussions."],
        ["disconnected", "Disconnected", 0, "Rarely collaborate, feeling lonely or unsupported."]
    ])
});
export const RATING_SCORES = Object.freeze({ 1: 0, 2: 2.5, 3: 5, 4: 7.5, 5: 10 });
export const SCORE_DIRECTIONS = Object.freeze({
    wellbeing: "higher_is_better", workload: "higher_is_worse", stress: "higher_is_worse",
    teamIntegration: "higher_is_better", psychologicalSafety: "higher_is_better"
});
export const SCORE_FIELDS = Object.freeze(Object.keys(SCORE_DIRECTIONS));
export const CHECKIN_STEPS = Object.freeze([
    Object.freeze(["wellbeing"]), Object.freeze(["workload", "stress"]),
    Object.freeze(["teamIntegration", "psychologicalSafety"]), Object.freeze([])
]);
export const CHALLENGES = Object.freeze([
    { id: "workload", label: "Workload", icon: "layers" },
    { id: "deadlines", label: "Deadlines", icon: "clock" },
    { id: "communication", label: "Team communication", icon: "message" },
    { id: "difficulty_integrating", label: "Difficulty integrating", icon: "people" },
    { id: "unclear_priorities", label: "Lack of clarity", icon: "compass" },
    { id: "limited_support", label: "Lack of support", icon: "heart" },
    { id: "work_life_balance", label: "Work-life balance", icon: "sun" },
    { id: "organizational_changes", label: "Organizational changes", icon: "grid" }
].map(Object.freeze));

const invalid = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
export function validateCheckinStep(answers, step) {
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) invalid("Please provide your check-in answers.");
    if (!Number.isInteger(step) || step < 0 || step > 3) invalid("Please choose a valid check-in step.");
    for (const key of CHECKIN_STEPS[step]) {
        if (Object.hasOwn(ANSWER_OPTIONS, key)) {
            if (typeof answers[key] !== "string" || !ANSWER_OPTIONS[key].some((choice) => choice.id === answers[key]))
                invalid("Please select an answer for each question.");
        } else if (!Number.isInteger(answers[key]) || answers[key] < 1 || answers[key] > 5) {
            invalid("Please answer each rating question on the 1–5 scale.");
        }
    }
    if (step === 3) {
        if (!Array.isArray(answers.challenges) || new Set(answers.challenges).size !== answers.challenges.length
            || answers.challenges.some((id) => !CHALLENGES.some((choice) => choice.id === id)))
            invalid("Please select valid challenge choices.");
        if (answers.comment !== undefined && (typeof answers.comment !== "string" || answers.comment.length > 2000))
            invalid("Please keep your comment within 2,000 characters.");
    }
}

// Submission contains raw categories + integer 1..5 ratings, never identity,
// team/week ownership or caller-supplied normalized scores. History is normalized.
export function createCheckinPayload(answers) {
    validateCheckinStep(answers, 0);
    const allowed = [...SCORE_FIELDS, "challenges", "comment"];
    if (Object.keys(answers).some((key) => !allowed.includes(key))) invalid("Unexpected check-in fields.");
    for (let step = 1; step < 4; step++) validateCheckinStep(answers, step);
    return { ...Object.fromEntries(SCORE_FIELDS.map((key) => [key, answers[key]])),
        challenges: [...answers.challenges], comment: answers.comment ?? "" };
}

export function normalizeCheckin(answers) {
    const raw = createCheckinPayload(answers);
    return { ...Object.fromEntries(SCORE_FIELDS.map((key) => [key, Object.hasOwn(ANSWER_OPTIONS, key)
        ? ANSWER_OPTIONS[key].find((choice) => choice.id === raw[key]).score : RATING_SCORES[raw[key]]])),
        challenges: raw.challenges, comment: raw.comment.trim() };
}

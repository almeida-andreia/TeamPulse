import { SCORE_DIRECTIONS } from "./checkin.mjs";

// Measured dimensions only. The mockup's unmeasured Role Clarity pillar is not
// inferred from challenge selections or replaced with a fabricated score.
export const PILLARS = Object.freeze([
    { key: "wellbeing", label: "Wellbeing", hint: "Higher scores are more positive." },
    { key: "workload", label: "Workload pressure", hint: "Higher scores mean more pressure." },
    { key: "stress", label: "Stress", hint: "Higher scores mean more stress." },
    { key: "teamIntegration", label: "Team connection", hint: "Higher scores mean stronger connection." },
    { key: "psychologicalSafety", label: "Psychological safety", hint: "Higher scores mean greater ease asking for help." }
].map((item) => Object.freeze({ ...item, direction: SCORE_DIRECTIONS[item.key] })));

// The existing privacy-preserving record date is the week's Lisbon Monday,
// not an unrecorded submission timestamp. This is a monthly display target;
// a fifth valid weekly submission is still accepted, but displayed as 4 / 4.
export function monthlyCompletion(entries, today) {
    const month = today.slice(0, 7);
    const weeks = new Set(entries.filter((entry) => typeof entry.weekStart === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(entry.weekStart) && entry.weekStart.startsWith(`${month}-`)
        && entry.weekStart <= today).map((entry) => entry.weekStart));
    return { month, completed: Math.min(4, weeks.size), target: 4 };
}

export function pillarLevel(value, direction) {
    if (!Number.isFinite(value)) return "Unavailable";
    // Reuse the existing UI's score-range boundaries; these are descriptive,
    // not diagnostic. Pressure/stress remain higher-is-worse, never inverted.
    const level = value >= 7 ? "Upper range" : value >= 4 ? "Mid-range" : "Lower range";
    return `${level} · ${direction === "higher_is_worse" ? "higher is less favorable" : "higher is more positive"}`;
}

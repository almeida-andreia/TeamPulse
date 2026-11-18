const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("visual changes respect all five metric directions without changing deltas or units", async () => {
    const { renderChange } = await import("../public/js/ui.mjs");
    const { SCORE_DIRECTIONS } = await import("../public/js/checkin.mjs");
    for (const [metric, direction] of Object.entries(SCORE_DIRECTIONS)) for (const delta of [-0.3, 0.3]) {
        const favorable = direction === "higher_is_worse" ? delta < 0 : delta > 0;
        const html = renderChange(delta, direction);
        assert(html.includes(`change-indicator--${favorable ? "positive" : "negative"}`), `${metric}: ${delta}`);
        assert(html.includes(`${favorable ? "Improved" : "Worsened"}:`));
        assert(html.includes(`aria-hidden="true">${delta > 0 ? "↑" : "↓"}`));
        assert(html.includes(`${delta > 0 ? "+" : ""}${delta.toFixed(1)}`));
        assert(html.includes("points")); assert(!html.includes("%"));
    }
});

test("zero and missing comparisons remain neutral and cannot appear as a positive or negative measurement", async () => {
    const { renderChange } = await import("../public/js/ui.mjs");
    for (const zero of [0, -0]) {
        const html = renderChange(zero, "higher_is_worse");
        assert(html.includes("change-indicator--neutral")); assert(html.includes("Unchanged")); assert(html.includes("→"));
    }
    for (const value of [null, undefined, NaN, Infinity]) {
        const html = renderChange(value, "higher_is_better");
        assert(html.includes("Not enough monthly history")); assert(!html.includes("change-indicator--"));
        assert(!html.includes("0.0")); assert(!html.includes("NaN"));
    }
    assert(renderChange(0.3, "higher_is_better", { comparison: "<script>unsafe</script>" }).includes("&lt;script&gt;"));
});

test("semantic green and red badge text exceed AA contrast against their backgrounds", () => {
    const css = fs.readFileSync(require.resolve("../public/css/style.css"), "utf8");
    const color = (name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))[1];
    const luminance = (hex) => {
        const rgb = hex.slice(1).match(/../g).map((value) => parseInt(value, 16) / 255)
            .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    for (const tone of ["positive", "negative"]) {
        const foreground = luminance(color(tone)), background = luminance(color(tone + "-surface"));
        assert((Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5);
    }
});

test("reporting badges and attention arrows retain stress and balance semantics", async () => {
    const { renderOverview } = await import("../public/js/reporting.mjs");
    const team = { name: "Platform", departmentName: "Engineering", available: true, scores: {
        wellbeing: 7, workloadBalance: 4, stress: 6, teamIntegration: 7, psychologicalSafety: 7
    }, monthlyChange: { wellbeing: 0.2, workloadBalance: -0.2, stress: 0.3, teamIntegration: -0.1, psychologicalSafety: 0 } };
    let html = renderOverview("manager", { available: true, teams: [team] });
    assert(html.includes('aria-label="Needs attention: increasing Stress">&uarr;'));
    assert(html.includes('aria-label="Needs attention: decreasing Workload Balance">&darr;'));
    const cards = [...html.matchAll(/<article class="card report-metric">[^]*?<\/article>/g)].map((match) => match[0]);
    assert(cards[0].includes("change-indicator--positive")); assert(cards[1].includes("change-indicator--negative"));
    assert(cards[2].includes("change-indicator--negative")); assert(cards[4].includes("change-indicator--neutral"));
    team.monthlyChange.stress = -0.3;
    html = renderOverview("manager", { available: true, teams: [team] });
    const stress = [...html.matchAll(/<article class="card report-metric">[^]*?<\/article>/g)][2][0];
    assert(stress.includes("change-indicator--positive")); assert(stress.includes("↓"));
    assert(!html.includes('aria-label="Needs attention: increasing Stress"'));
});

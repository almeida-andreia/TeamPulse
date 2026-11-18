import { escapeHtml as e, icon, dateLabel, renderChange } from "./ui.mjs";
import { CHALLENGES } from "./checkin.mjs";
import { eventMarkers, eventContext } from "./team-events.mjs";

export const REPORT_METRICS = Object.freeze([
    { key: "wellbeing", label: "Wellbeing", direction: "higher_is_better" },
    { key: "workloadBalance", label: "Workload Balance", direction: "higher_is_better" },
    { key: "stress", label: "Stress", direction: "higher_is_worse" },
    { key: "teamIntegration", label: "Team connection", direction: "higher_is_better" },
    { key: "psychologicalSafety", label: "Psychological safety", direction: "higher_is_better" }
]);
export const emptyOverview = (reason = "service_unavailable", source = "unavailable") => ({
    source, reason, available: false, teams: [], departments: [], weeks: []
});
export function createReportingApi(source) {
    const validRole = (role) => { if (!["manager", "hr"].includes(role)) throw new Error("Unknown reporting role."); };
    async function request(url, method = "GET") {
        const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store",
            ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}) });
        if (!response.ok) throw new Error(method === "POST" ? "Demo access is unavailable. Please try again."
            : "Aggregated information is unavailable. Please try again later.");
        return response.status === 204 ? null : response.json();
    }
    return {
        async startSession(role) {
            validRole(role);
            if (source === "postgres") await request(`/api/prototype/${role}-session`, "POST");
        },
        async getOverview(role) {
            validRole(role);
            // No simulated metrics, no Employee API, no browser aggregation.
            return source === "demo" ? emptyOverview("prototype", "demo") : request(`/api/${role}/overview`);
        }
    };
}
const number = (value, suffix = "") => Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : "Unavailable";
// Display punctuation only; catalogue names, IDs and reporting scopes stay intact.
const departmentLabel = (name) => name === "People and Operations" ? "People & Operations" : name;
const stressExplanation = "Stress tracking was introduced after these historical check-ins.";
const historicalStress = (data, key) => key === "stress"
    && !Number.isFinite(data.scores?.stress) && data.metricAvailability?.stress === "not_measured_historically";
const scoreLabel = (data, key, suffix = "", privacyAware = false) => historicalStress(data, key) ? "Not yet available"
    : data.available && Number.isFinite(data.scores?.[key]) ? number(data.scores[key], suffix)
        : privacyAware ? "Insights unavailable" : "Unavailable";
const reasons = {
    privacy_not_configured: "Insights are unavailable until the minimum-response privacy setting is configured.",
    insufficient_responses: "Insights unavailable: at least one constituent cohort is too small or not finalized. Totals are withheld rather than excluding that cohort.",
    protected_constituent: "Publishing this organization value alongside visible department results could reveal a protected department by subtraction.",
    not_measured_historically: "Not measured historically",
    no_data: "There are no finalized weekly insights to show yet.",
    prototype: "Prototype view · No organization metrics are simulated. Connect PostgreSQL to see eligible aggregated insights.",
    service_unavailable: "Prototype view · Aggregated data is unavailable. Database access and role verification must be ready before insights can be shown."
};
function metrics(data, privacyAware = false) {
    return `<div class="report-metrics">${REPORT_METRICS.map((item) => {
        const value = data.available ? data.scores?.[item.key] : null;
        const delta = Number.isFinite(value) ? data.monthlyChange?.[item.key] : null;
        const adverse = Number.isFinite(delta) && (item.direction === "higher_is_worse" ? delta > 0 : delta < 0);
        const missing = data.metricAvailability?.[item.key] === "not_measured_historically";
        const protectedMetric = privacyAware && !Number.isFinite(value)
            && (data.reason === "insufficient_responses" || ["insufficient_responses", "protected_constituent"].includes(data.metricAvailability?.[item.key]));
        const explanation = historicalStress(data, item.key) ? stressExplanation
            : privacyAware && data.metricAvailability?.[item.key] === "protected_constituent" ? reasons.protected_constituent
            : protectedMetric ? "Not enough responses to protect employee privacy."
                : missing ? reasons.not_measured_historically : privacyAware && !data.available ? reasons[data.reason] ?? reasons.service_unavailable
                    : Number.isFinite(delta) ? `${delta > 0 ? "+" : ""}${delta.toFixed(1)} vs previous month` : "Monthly comparison unavailable";
        return `<article class="card report-metric"><span>${e(item.label)}</span><strong${Number.isFinite(value) ? "" : ' class="is-unavailable"'}>${scoreLabel(data, item.key, '<small>/ 10</small>', privacyAware)}</strong><p${adverse ? ' class="report-change-adverse"' : ""}>${Number.isFinite(delta) ? renderChange(delta, item.direction, { comparison: "vs previous month" }) : e(explanation)}</p><small>${item.direction === "higher_is_worse" ? "Higher means more stress" : "Higher is more positive"}</small></article>`;
    }).join("")}</div>`;
}
function chart(weeks, metric, events = []) {
    const measured = REPORT_METRICS.find((item) => item.key === metric) ?? REPORT_METRICS[0];
    const hasValue = (week) => week.available && Number.isFinite(week.scores?.[measured.key]);
    if (!weeks.some(hasValue)) {
        const historical = weeks.some((week) => historicalStress(week, measured.key));
        const protectedMetric = weeks.some((week) => week.metricAvailability?.[measured.key] === "protected_constituent");
        return `<div class="empty-state report-chart-empty">${icon("chart")}<h3>${e(measured.label)} ${historical ? "not yet available" : protectedMetric ? "insights protected" : "unavailable"}</h3><p>${historical ? stressExplanation : protectedMetric ? reasons.protected_constituent : "Only finalized weeks with enough answers for this measure can appear here."}</p></div>`;
    }
    const x = (i) => 38 + i * 640 / Math.max(weeks.length - 1, 1), y = (value) => 212 - value * 18;
    const segments = []; let points = [];
    weeks.forEach((week, i) => {
        if (week.available && Number.isFinite(week.scores?.[measured.key])) points.push(`${x(i)},${y(week.scores[measured.key])}`);
        else if (points.length) { segments.push(points); points = []; }
    });
    if (points.length) segments.push(points);
    return `<svg class="history-chart" viewBox="0 0 720 260" role="img" aria-label="Aggregated ${e(measured.label)} over eight completed weeks. Missing insights are gaps.">
        ${[0, 2, 4, 6, 8, 10].map((tick) => `<line x1="38" y1="${y(tick)}" x2="678" y2="${y(tick)}" stroke="#e4eaf1" stroke-dasharray="3 5"/><text x="12" y="${y(tick) + 4}" fill="#6c8091" font-size="10">${tick}</text>`).join("")}
        ${segments.map((segment) => `<polyline points="${segment.join(" ")}" fill="none" stroke="#537bf0" stroke-width="2.5" stroke-linejoin="round"/>`).join("")}
        ${weeks.map((week, i) => `${hasValue(week) ? `<circle cx="${x(i)}" cy="${y(week.scores[measured.key])}" r="4" fill="white" stroke="#537bf0" stroke-width="2"/>` : ""}<text x="${x(i)}" y="242" text-anchor="middle" fill="#6c8091" font-size="10">${e(dateLabel(week.weekStart))}</text>`).join("")}${eventMarkers(weeks, events)}</svg>`;
}
function challenges(data, minimum) {
    const window = data.sharedThemes;
    const items = window?.available ? (window.factors ?? []).filter((item) =>
        CHALLENGES.some((factor) => factor.id === item.code) && item.reason === null
        && Number.isFinite(item.percentage) && item.percentage >= 0 && item.percentage <= 100)
        .sort((a, b) => b.percentage - a.percentage || a.label.localeCompare(b.label)) : [];
    const period = window?.startWeek && window?.endDate
        ? dateLabel(window.startWeek, { year: "numeric" }) + " - " + dateLabel(window.endDate, { year: "numeric" })
        : "Latest 8 completed weeks";
    const policy = !Number.isInteger(minimum) ? "" : window?.privacyBasis === "organization_with_complementary_suppression"
        ? " Privacy is checked independently for each organization theme across the period: at least " + minimum + " distinct participants must select it and at least " + minimum + " must not. Published department results are also checked: subtraction must not isolate a protected department or a small selecting/nonselecting group. Every department is included; individual weeks are not published here."
        : " Privacy is checked after aggregating the period: each constituent team/department group needs at least " + minimum
            + " distinct participants, with at least " + minimum + " selecting and " + minimum + " not selecting the theme across the period. Individual weeks are not published here.";
    return `<section class="card report-challenges"><p class="eyebrow">SHARED THEMES</p><h2>What people have been experiencing recently</h2><p class="field-help">${e(period)} &middot; finalized weekly cohorts only.</p>
        ${items.length ? `<div class="report-themes-list">${items.map((item) => `<article class="report-theme report-theme--available" data-theme-state="available"><div class="report-theme-heading"><h3>${e(item.label)}</h3><span class="report-theme-status">${item.percentage}%</span></div><progress max="100" value="${item.percentage}" aria-label="${e(item.label)}: ${item.percentage}% of responses selected this as a challenge"></progress><p class="report-theme-caption">${item.percentage}% of responses selected this as a challenge.</p></article>`).join("")}</div><p class="field-help">One response can select several challenges; percentages do not have to add up to 100%.</p>`
            : '<p class="report-themes-empty">No shared themes are available for this period yet.</p>'}
        <details class="report-challenge-policy"><summary>About this period and privacy</summary><p class="field-help">For each theme, the percentage is the share of eligible responses that selected it, among responses where that factor was actually asked in this period. Each weekly response counts once; people may contribute in several weeks.${e(policy)} Factors not yet measured or without enough safe data are omitted. Small or missing cohorts are never silently excluded from a total. Several themes may be selected in one check-in.</p></details></section>`;
}

function focus(data, manager = false) {
    const comparisons = REPORT_METRICS.filter((item) => Number.isFinite(data.monthlyChange?.[item.key]));
    const adverse = comparisons.filter((item) => item.direction === "higher_is_worse" ? data.monthlyChange[item.key] > 0 : data.monthlyChange[item.key] < 0);
    const protectedChanges = !manager && Object.values(data.metricAvailability ?? {}).includes("protected_constituent");
    const emptyExplanation = comparisons.length ? "No adverse monthly change is visible in the available aggregates."
        : protectedChanges ? "Monthly changes are protected because the underlying organization values could reveal a small department."
            : "More eligible finalized weeks are needed to highlight changes.";
    return `<aside class="card report-focus"><p class="eyebrow">FOCUS</p><h2>Areas to pay attention to</h2>${adverse.length ? adverse.map((item) => `<div class="report-focus-item"><span class="attention-indicator" role="img" aria-label="${e((item.direction === "higher_is_worse" ? "Needs attention: increasing " : "Needs attention: decreasing ") + item.label)}">${item.direction === "higher_is_worse" ? "&uarr;" : "&darr;"}</span><div><h3>${e(item.label)}</h3><p>${item.direction === "higher_is_worse" ? "Increased" : "Decreased"} compared with the previous month’s available finalized weeks.</p>${manager && data.available && data.teamId && data.weekStart && Number.isFinite(data.scores?.[item.key]) && ["wellbeing", "workloadBalance", "teamIntegration", "psychologicalSafety"].includes(item.key) ? `<button class="action-insight-link" type="button" data-action-insight="${item.key}" data-action-team="${e(data.teamId)}" data-action-week="${e(data.weekStart)}">Create action plan ${icon("arrow")}</button>` : ""}${!manager && data.available && data.departmentId && data.weekStart && Number.isFinite(data.scores?.[item.key]) ? `<button class="action-insight-link" type="button" data-hr-activity-insight="${item.key}" data-hr-activity-department="${e(data.departmentId)}" data-hr-activity-week="${e(data.weekStart)}">Create wellbeing activity ${icon("arrow")}</button>` : ""}</div></div>`).join("") : `<div class="empty-state">${icon("shield")}<p>${e(emptyExplanation)}</p></div>`}<p class="field-help">These are workplace reflections, not clinical assessments.</p></aside>`;
}
function trends(data, metric, manager = false) {
    return `<section class="card report-trends"><p class="eyebrow">8-WEEK VIEW</p><h2>Wellbeing evolution</h2><div class="period-tabs report-dimensions" role="group" aria-label="Aggregate trend dimension">${REPORT_METRICS.map((item) => `<button type="button" data-report-metric="${item.key}" aria-pressed="${metric === item.key}">${e(item.label)}</button>`).join("")}</div>${chart(data.weeks ?? [], metric, manager ? data.events : [])}<p class="field-help">Finalized cohorts only. Withheld weeks remain gaps; individual responses are never available here.</p>${manager ? eventContext(data) : ""}
        ${(data.weeks ?? []).some((week) => week.available) ? `<details><summary>View aggregate chart values</summary><div class="table-wrap"><table><caption>Released weekly aggregate scores only</caption><thead><tr><th>Week of</th>${REPORT_METRICS.map((item) => `<th>${e(item.label)}</th>`).join("")}<th>Responses</th></tr></thead><tbody>${data.weeks.map((week) => `<tr><th>${e(dateLabel(week.weekStart))}</th>${REPORT_METRICS.map((item) => `<td>${scoreLabel(week, item.key)}</td>`).join("")}<td>${week.available ? week.responseCount : "Unavailable"}</td></tr>`).join("")}</tbody></table></div></details>` : ""}</section>`;
}
function departmentCells(department) {
    return `${REPORT_METRICS.map((item) => `<td><span class="department-score">${scoreLabel(department, item.key, "", true)}</span></td>`).join("")}<td>${participationAvailable(department) ? `${department.participation}%` : "Participation unavailable"}</td>`;
}
const participationAvailable = (data) => (data.participationAvailability?.available ?? data.available) && Number.isFinite(data.participation);
function participationPanel(data, organization) {
    // Use the selected, backend-authorized cohort's participation value. Its
    // release state is independent of whether any wellbeing score was measured.
    const available = participationAvailable(data);
    const title = organization ? "Listening across the organization" : `Participation in ${data.name}`;
    const reason = data.participationAvailability?.reason ?? data.reason;
    const privacyProtected = ["insufficient_responses", "protected_constituent"].includes(reason);
    const explanation = privacyProtected ? "Not enough responses to calculate a privacy-safe participation rate."
        : reasons[reason] ?? "Participation is unavailable for this reporting scope.";
    return `<aside class="card report-focus"><p class="eyebrow">PARTICIPATION</p><h2>${e(title)}</h2><strong class="report-participation${available ? "" : " is-unavailable"}">${available ? `${data.participation}%` : "Participation unavailable"}</strong><p>${available && Number.isFinite(data.responseCount) ? `${data.responseCount} anonymous responses in the latest completed week.` : e(explanation)}</p>${!available && organization && privacyProtected ? '<p class="field-help">An organization total could reveal a protected department by subtraction. Every department remains included.</p>' : ""}${data.weekStart ? `<p class="field-help">Latest finalized week: ${e(dateLabel(data.weekStart, { year: "numeric" }))}. Metrics and participation use this week; Shared Themes use the eight-week period.</p>` : ""}<p class="field-help">No list of respondents or nonrespondents is available.</p></aside>`;
}
function reportingScope(data, selectedScope) {
    const departments = data.departments ?? [];
    // The scope is always labelled. A safe department is never presented as an
    // organization total. This only selects already-authorized aggregate DTOs.
    const firstSafe = departments.findIndex((department) => department.available || department.weeks?.some((week) => week.available));
    const choice = selectedScope ?? (!data.available && firstSafe >= 0 ? String(firstSafe) : "organization");
    const department = departments.find((_, index) => String(index) === choice);
    const label = department ? departmentLabel(department.name) : "All departments";
    const description = !department ? "Every department is included. Each metric and theme is checked separately, including protection against reconstructing a small department."
        : !department.available && department.reason === "insufficient_responses"
            ? "Department · Insights unavailable. Not enough responses to protect employee privacy."
            : "Department";
    return { data: department ?? data, heading: departments.length ? `<div class="section-heading report-scope"><div><p class="eyebrow">${department ? "DEPARTMENT DETAIL" : "ORGANIZATION TOTAL"}</p><h2>${e(label)}</h2><p class="field-help">${e(description)}</p></div><label for="report-scope">Department / organization<select id="report-scope" data-report-scope><option value="organization"${!department ? " selected" : ""}>All departments</option>${departments.map((item, index) => `<option value="${index}"${item === department ? " selected" : ""}>${e(departmentLabel(item.name))} &middot; Department</option>`).join("")}</select></label></div>` : "" };
}
export function renderOverview(role, data, metric = "wellbeing", selectedScope = null) {
    const manager = role === "manager", title = manager ? "Team wellbeing" : "Organization wellbeing";
    const reason = data.reason ?? (data.available ? null : "insufficient_responses");
    const statusMessage = !manager && reason === "insufficient_responses"
        ? "Organization metrics and themes are evaluated independently. Values that could reveal a protected department remain withheld; no department has been excluded."
        : reasons[reason] ?? reasons.insufficient_responses;
    const header = `<div class="page-heading"><div><p class="eyebrow">${manager ? "MANAGER SPACE" : "PEOPLE SPACE"}</p><h1 id="page-title" tabindex="-1">${title}</h1><p class="subtitle">Only aggregated wellbeing information belongs in this space. Individual answers and personal histories stay private.</p></div></div>
        <div class="notice">${icon("shield")}<p>${data.source === "postgres" ? "PostgreSQL aggregates · Latest 8 completed weeks · Only finalized cohorts with sufficient responses are released." : e(reasons[reason] ?? reasons.service_unavailable)}</p></div>
        ${reason && data.source === "postgres" ? `<p class="report-unavailable" role="status">${e(statusMessage)}</p>` : ""}`;
    if (manager) {
        const teams = data.teams?.length ? data.teams : [{ ...emptyOverview(reason), name: "Your team" }];
        return `<div class="reporting-space">${header}${teams.map((team) => `<div class="section-heading"><div><h2>${e(team.name)}</h2><p class="field-help">${team.departmentName ? `${e(departmentLabel(team.departmentName))} &middot; ` : ""}Team</p><p>${team.weekStart ? `Latest completed week: ${e(dateLabel(team.weekStart))}` : "Latest completed weekly cohort"}</p></div><span class="tag">${team.available ? `${team.responseCount} anonymous responses${Number.isFinite(team.participation) ? ` · Participation: ${team.participation}%` : ""}` : "Insights unavailable"}</span></div>${metrics(team)}<div class="report-layout">${trends(team, metric, true)}${focus(team, true)}</div>${challenges(team, data.minimumResponses)}`).join("")}</div>`;
    }
    const scope = reportingScope(data, selectedScope);
    return `<div class="reporting-space">${header}${scope.heading}${metrics(scope.data, true)}<div class="report-layout"><section class="card report-departments"><p class="eyebrow">DEPARTMENT VIEW</p><h2>Wellbeing & participation by department</h2><p class="field-help">Insights use the team membership recorded for that week. Small team cohorts also protect department and organization totals.</p>${data.departments?.length ? `<div class="table-wrap"><table><caption>Latest completed week · department aggregates only</caption><thead><tr><th>Department</th>${REPORT_METRICS.map((item) => `<th>${e(item.label)} / 10</th>`).join("")}<th>Participation</th></tr></thead><tbody>${data.departments.map((department) => `<tr><th>${e(department.name)}</th>${departmentCells(department)}</tr>`).join("")}</tbody></table></div>` : '<div class="empty-state"><p>Department comparisons will appear when eligible aggregate data is available.</p></div>'}</section>${participationPanel(scope.data, scope.data === data)}</div><div class="report-layout">${trends(scope.data, metric)}${focus(scope.data)}</div>${challenges(scope.data, data.minimumResponses)}</div>`;
}

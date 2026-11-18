import { escapeHtml as e, icon, dateLabel, timeLabel, activityStatusLabel as statusLabel, activityRegistrationLabel, monthKey, monthFilterOptions } from "./ui.mjs";
import { REPORT_METRICS } from "./reporting.mjs";

export const ACTIVITY_AREAS = REPORT_METRICS;
export const ACTIVITY_TYPES = Object.freeze(["workshop", "group_activity", "webinar", "other"]);
export const activityTypeLabel = (type) => ({ workshop: "Workshop", group_activity: "Group activity", webinar: "Webinar", other: "Other" })[type] ?? type;
export const ACTIVITY_STATUSES = Object.freeze(["draft", "upcoming", "in_progress", "completed"]);
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export const validId = (value) => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
export function validateActivity(input) {
    const fields = ["departmentId", "area", "type", "title", "description", "startsAt", "duration", "format", "audience", "publication", "sourceWeek"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key)))
        throw invalid("Unexpected activity fields. Individual information and browser-supplied scores are not accepted.");
    if (input.departmentId !== null && !validId(input.departmentId)) throw invalid("Choose an existing department or all departments.");
    if (input.area !== null && !ACTIVITY_AREAS.some((area) => area.key === input.area)) throw invalid("Choose a supported wellbeing area.");
    if (!ACTIVITY_TYPES.includes(input.type)) throw invalid("Choose a supported activity type.");
    for (const [field, max] of [["title", 180], ["description", 2000]])
        if (typeof input[field] !== "string" || !input[field].trim() || input[field].trim().length > max)
            throw invalid(`Provide a ${field} of at most ${max} characters about the activity, without personal information.`);
    if (typeof input.startsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(input.startsAt)
        || input.startsAt.startsWith("0000-") || Number.isNaN(Date.parse(input.startsAt)) || new Date(input.startsAt).toISOString() !== input.startsAt)
        throw invalid("Choose a valid activity date and time.");
    if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 1440) throw invalid("Choose a duration from 1 to 1440 minutes.");
    if (!["online", "in_person"].includes(input.format)) throw invalid("Choose a supported format.");
    if (!["all_employees", "department", "existing"].includes(input.audience) || (input.audience === "department" && input.departmentId === null))
        throw invalid("Choose a valid target audience.");
    if (!["draft", "published"].includes(input.publication)) throw invalid("Choose Draft or Published.");
    if (input.sourceWeek !== undefined && (typeof input.sourceWeek !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.sourceWeek)
        || input.sourceWeek.startsWith("0000-") || Number.isNaN(Date.parse(input.sourceWeek))
        || new Date(input.sourceWeek).toISOString().slice(0, 10) !== input.sourceWeek || new Date(input.sourceWeek).getUTCDay() !== 1))
        throw invalid("Choose a valid aggregate insight week.");
    return { ...input, title: input.title.trim(), description: input.description.trim() };
}
// Select released adverse metrics only. The server obtains its own report when
// creating an activity; the browser cannot assert that a source was released.
export function safeActivityInsights(report) {
    return (report.departments ?? []).flatMap((department) => !department.available || !department.departmentId || !department.weekStart ? []
        : ACTIVITY_AREAS.filter((area) => Number.isFinite(department.scores?.[area.key]) && Number.isFinite(department.monthlyChange?.[area.key])
            && (area.direction === "higher_is_worse" ? department.monthlyChange[area.key] > 0 : department.monthlyChange[area.key] < 0))
            .map((area) => ({ departmentId: department.departmentId, departmentName: department.name, area: area.key, areaLabel: area.label,
                sourceWeek: department.weekStart, value: department.scores[area.key], change: department.monthlyChange[area.key] })));
}
export function comparisonLabel(week) {
    const month = week.slice(0, 7), before = new Date(`${month}-01T12:00:00Z`); before.setUTCMonth(before.getUTCMonth() - 1);
    return `${month} vs ${before.toISOString().slice(0, 7)} · available finalized weeks`;
}
export function createHrActivitiesApi(source) {
    const request = async (path = "", method = "GET", body) => {
        if (source !== "postgres") throw new Error("Activity management requires PostgreSQL access.");
        const response = await fetch(`/api/hr/activities${path}`, { method, credentials: "same-origin", cache: "no-store",
            ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok) throw new Error([400, 401, 403, 404, 409].includes(response.status) && typeof data.error === "string"
            ? data.error : "Activities are unavailable. Please try again.");
        return data;
    };
    return { list: () => request(), create: (body) => request("", "POST", validateActivity(body)),
        update: (id, body) => request(`/${encodeURIComponent(id)}`, "PUT", validateActivity(body)) };
}
const options = (items, selected) => items.map((item) => `<option value="${e(item.key ?? item.id)}"${(item.key ?? item.id) === selected ? " selected" : ""}>${e(item.label ?? item.name)}</option>`).join("");
export function renderHrActivities(data, filters = {}) {
    const list = data.activities.filter((a) => (!filters.departmentId || a.departmentId === filters.departmentId)
        && (!filters.month || monthKey(a.startsAt) === filters.month)
        && (!filters.area || a.area === filters.area) && (!filters.status || a.status === filters.status));
    return `<div class="hr-activities action-plans"><div class="page-heading"><div><p class="eyebrow">ORGANIZATION RESPONSE</p><h1 id="page-title" tabindex="-1">Insights &amp; Activities</h1><p class="subtitle">Turn safe aggregate insights into supportive wellbeing activities.</p></div><button class="button" type="button" data-hr-activity-create>${icon("sparkle")}Create wellbeing activity</button></div>
        <div class="notice">${icon("shield")}<p>Individual answers and histories stay private. Insight-driven activities use released aggregates only; general activities do not imply a hidden measurement.</p></div>
        <section><div class="section-heading"><div><p class="eyebrow">SAFE AGGREGATE INSIGHTS</p><h2>Areas requiring attention</h2></div></div><div class="activity-insights">${data.insights.length ? data.insights.map((i) => `<article class="card activity-insight"><p class="eyebrow">${e(i.departmentName)}</p><h3>${e(i.areaLabel)}</h3><strong>${i.value.toFixed(1)}<small> / 10</small></strong><p>${i.change > 0 ? "Increased" : "Decreased"} ${Math.abs(i.change).toFixed(1)} points</p><p class="field-help">${e(comparisonLabel(i.sourceWeek))}</p><p class="field-help">Released aggregate only. Every constituent cohort meets the existing privacy rules.</p><button type="button" class="action-insight-link" data-hr-activity-insight="${e(i.area)}" data-hr-activity-department="${e(i.departmentId)}" data-hr-activity-week="${e(i.sourceWeek)}">Create wellbeing activity ${icon("arrow")}</button></article>`).join("") : '<div class="card empty-state"><p>No safe adverse monthly comparison is available. A general wellbeing activity can still be created.</p></div>'}</div></section>
        <section class="card action-list"><div class="section-heading"><h2>Wellbeing activities</h2><span class="tag">${list.length} shown</span></div><div class="activity-filters activity-filters--months"><label>Month<select data-hr-activity-filter="month">${monthFilterOptions(data.activities.map((a) => a.startsAt), filters.month)}</select></label>${[["departmentId", "Department", data.departments], ["status", "Status", ACTIVITY_STATUSES.map((key) => ({ key, label: statusLabel(key) }))], ["area", "Related area", ACTIVITY_AREAS]].map(([key, label, items]) => `<label>${label}<select data-hr-activity-filter="${key}"><option value="">All</option>${options(items, filters[key])}</select></label>`).join("")}</div>
        ${list.length ? list.map((a) => `<article class="action-row" data-hr-activity-row="${e(a.id)}"><div class="action-row-heading"><h3>${e(a.title)}</h3><span class="action-status action-status--${e(a.status)}">${statusLabel(a.status)}</span></div><p class="action-area">${e(a.departmentName ?? "All departments")} · ${e(activityTypeLabel(a.type))} · ${e(ACTIVITY_AREAS.find((area) => area.key === a.area)?.label ?? "No related area recorded")}</p><span class="tag">${a.source ? "Insight-driven activity" : "General activity · no measured source"}</span>${a.source ? `<p class="field-help">Saved aggregate · ${a.source.value.toFixed(1)} / 10 · ${a.source.change > 0 ? "+" : ""}${a.source.change.toFixed(1)} points<br>${e(comparisonLabel(a.source.week))}</p>` : ""}<p class="action-description">${e(a.description)}</p><p class="field-help activity-registration-summary">${Number.isSafeInteger(a.registrationCount) ? `${a.registrationCount} ${a.registrationCount === 1 ? "registration" : "registrations"}` : "Registration count unavailable"} &middot; ${activityRegistrationLabel(a.registrationOpen)}</p><div class="action-row-footer"><p>${e(dateLabel(a.startsAt, { year: "numeric" }))} · ${e(timeLabel(a.startsAt))} Lisbon time · ${a.duration} min<br>${a.format === "online" ? "Online" : "In person"} · ${e(a.targetAudience)}<br>Created ${e(dateLabel(a.createdAt, { year: "numeric" }))}</p><button class="button secondary" type="button" data-hr-activity-edit="${e(a.id)}">Manage activity</button></div></article>`).join("") : '<div class="empty-state"><h3>No activities to show</h3><p>Create an activity or adjust the filters.</p></div>'}<p class="field-help">Status follows publication and the scheduled date and duration: Draft, Upcoming, In progress, Completed.</p></section></div>`;
}
export function renderHrActivityForm(data, prefill = {}, activity = null) {
    const insight = activity?.source ? { departmentName: activity.departmentName, areaLabel: ACTIVITY_AREAS.find((a) => a.key === activity.area)?.label,
        sourceWeek: activity.source.week, value: activity.source.value, change: activity.source.change }
        : prefill.sourceWeek ? data.insights.find((i) => i.departmentId === prefill.departmentId && i.area === prefill.area && i.sourceWeek === prefill.sourceWeek) : null;
    if (prefill.sourceWeek && !insight) throw new Error("This aggregate insight is no longer available. Create a general activity instead.");
    const selected = activity ?? prefill, start = activity ? new Date(activity.startsAt) : null;
    const local = start ? new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
    return `<div class="hr-activities"><a class="text-link" href="#activities">← Back to insights &amp; activities</a><div class="page-heading"><div><p class="eyebrow">PEOPLE PROGRAMS</p><h1 id="page-title" tabindex="-1">${activity ? "Manage wellbeing activity" : "Create wellbeing activity"}</h1><p class="subtitle">Publish a supportive activity for employees, without personal wellbeing information.</p></div></div><section class="card hr-activity-form-card"><form id="hr-activity-form" class="action-form">
        <p id="hr-activity-origin" class="notice">${insight ? `Insight-driven activity · ${e(insight.departmentName)} · ${e(insight.areaLabel)} · ${insight.value.toFixed(1)} / 10 · ${insight.change.toFixed(1)} points<br>${e(comparisonLabel(insight.sourceWeek))}` : "General activity. No measured insight is linked."}</p>${insight ? `<input type="hidden" name="sourceWeek" value="${e(insight.sourceWeek)}">` : ""}
        <div class="action-form-pair"><label>Department<select name="departmentId"${activity?.source ? ' data-source-locked' : ""}><option value="">All departments</option>${options(data.departments, selected.departmentId)}</select></label><label>Related wellbeing area<select name="area"${activity?.area === null ? "" : " required"}>${activity?.area === null ? '<option value="">No related area recorded</option>' : ""}${options(ACTIVITY_AREAS, selected.area)}</select></label></div>
        <label>Activity title<input name="title" maxlength="180" required value="${e(activity?.title ?? "")}"></label><label>Description<textarea name="description" maxlength="2000" rows="4" required placeholder="Describe the activity. Do not include employee names, answers or personal information.">${e(activity?.description ?? "")}</textarea></label>
        <div class="action-form-pair"><label>Date and time (your local time)<input name="startsAt" type="datetime-local" required value="${local}"></label><label>Duration (minutes)<input name="duration" type="number" min="1" max="1440" required value="${activity?.duration ?? 45}"></label></div>
        <div class="action-form-pair"><label>Format<select name="format">${options([{ key: "online", label: "Online" }, { key: "in_person", label: "In person" }], activity?.format)}</select></label><label>Target<select name="audience">${options([{ key: "all_employees", label: "All employees" }, { key: "department", label: "Selected department" }, ...(activity?.audience === "existing" ? [{ key: "existing", label: activity.targetAudience }] : [])], activity?.audience)}</select></label></div>
        <div class="action-form-pair"><label>Activity type<select name="type">${ACTIVITY_TYPES.map((type) => `<option value="${type}"${type === activity?.type ? " selected" : ""}>${e(activityTypeLabel(type))}</option>`).join("")}</select></label><label>Publication<select name="publication">${options([{ key: "published", label: "Published" }, { key: "draft", label: "Draft" }], activity?.publication ?? "published")}</select></label></div>
        <p class="field-help">Activity progress follows its scheduled date and duration. Only organizational support activities belong here.</p><p id="hr-activity-form-error" class="form-error" role="alert" hidden></p><div class="dialog-actions"><a href="#activities" class="button secondary">Cancel</a><button class="button" type="submit">${activity ? "Save activity" : "Create wellbeing activity"}</button></div></form></section></div>`;
}

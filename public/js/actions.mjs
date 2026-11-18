import { escapeHtml as e, icon, dateLabel, monthKey, monthFilterOptions } from "./ui.mjs";

export const ACTION_AREAS = Object.freeze([
    { key: "wellbeing", label: "Wellbeing", topic: "wellbeing" },
    { key: "workloadBalance", label: "Workload Balance", topic: "workload" },
    { key: "teamIntegration", label: "Team connection", topic: "team_integration" },
    { key: "psychologicalSafety", label: "Psychological safety", topic: "psychological_safety" }
]);
export const ACTION_STATUSES = Object.freeze([
    { key: "planned", label: "Planned" }, { key: "in_progress", label: "In progress" }, { key: "completed", label: "Completed" }
]);
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export function validateAction(input) {
    const fields = ["teamId", "title", "area", "description", "owner", "targetDate", "status", "sourceWeek"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key)))
        throw invalid("Unexpected action plan fields.");
    const text = (key, max) => {
        if (typeof input[key] !== "string" || !input[key].trim() || input[key].trim().length > max)
            throw invalid(`Please provide ${key === "description" ? "a description" : "a title"} of at most ${max} characters.`);
        return input[key].trim();
    };
    const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000-")
        && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (typeof input.teamId !== "string" || !/^[1-9]\d{0,18}$/.test(input.teamId)) throw invalid("Choose a team.");
    if (!ACTION_AREAS.some((a) => a.key === input.area)) throw invalid("Choose a supported related area.");
    if (input.owner !== "team_manager") throw invalid("The owner must be Team Manager.");
    if (!date(input.targetDate)) throw invalid("Choose a valid target date.");
    if (input.status !== undefined && !ACTION_STATUSES.some((s) => s.key === input.status)) throw invalid("Choose a valid status.");
    if (input.sourceWeek !== undefined && (!date(input.sourceWeek) || new Date(input.sourceWeek).getUTCDay() !== 1))
        throw invalid("Choose a valid aggregate insight week.");
    return { teamId: input.teamId, title: text("title", 180), description: text("description", 2000), area: input.area,
        owner: "team_manager", targetDate: input.targetDate, status: input.status ?? "planned", ...(input.sourceWeek ? { sourceWeek: input.sourceWeek } : {}) };
}
export function createActionsApi(source) {
    const request = async (path = "", method = "GET", body) => {
        if (source !== "postgres") throw new Error("Action plans require PostgreSQL access.");
        const response = await fetch(`/api/manager/actions${path}`, { method, credentials: "same-origin", cache: "no-store",
            ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok) throw new Error([400, 401, 403, 404, 409].includes(response.status) && typeof data.error === "string"
            ? data.error : "Action plans are unavailable. Please try again.");
        return data;
    };
    return { list: () => request(), create: (body) => request("", "POST", validateAction(body)),
        updateStatus: (id, status) => request(`/${encodeURIComponent(id)}/status`, "PATCH", { status }) };
}
export function renderActionPlans(data, month = "") {
    const list = data.actions.filter((action) => !month || monthKey(action.targetDate) === month);
    return `<div class="action-plans"><div class="page-heading"><div><p class="eyebrow">FROM INSIGHT TO ACTION</p><h1 id="page-title" tabindex="-1">Action Plans</h1><p class="subtitle">Turn aggregated team wellbeing insights into thoughtful, team-level improvements.</p></div><button type="button" class="button" data-action-create${data.teams.length ? "" : " disabled"}>${icon("check")}Create action plan</button></div>
        <div class="action-introduction"><div><p class="eyebrow">SHARED INSIGHTS</p><h2>Make a concrete commitment</h2><p>Choose a related area, define a team action, and track its progress with an owner and target date.</p></div><div>${icon("shield")}<p>Only team-level actions belong here. Individual answers, comments and histories stay private.</p></div></div>
        <section class="card action-list"><div class="section-heading"><h2>Team action plans</h2><span class="tag">${list.length} plans</span></div><div class="activity-filters"><label>Month<select data-action-month>${monthFilterOptions(data.actions.map((a) => a.targetDate), month)}</select></label></div>${list.length ? list.map((action) => `<article class="action-row"><div class="action-row-heading"><h3>${e(action.title)}</h3><span class="action-status action-status--${e(action.status)}">${e(ACTION_STATUSES.find((s) => s.key === action.status)?.label ?? "Unavailable")}</span></div><p class="action-area">${e(action.teamName)} · ${e(action.areaLabel)}</p><p class="action-description">${e(action.description ?? "No description was recorded for this existing plan.")}</p><div class="action-row-footer"><p>Owner · ${e(action.owner)}<br>Target date · ${e(dateLabel(action.targetDate, { year: "numeric" }))}</p><div class="action-status-controls"><label for="action-status-${e(action.id)}">Status<select id="action-status-${e(action.id)}">${ACTION_STATUSES.map((s) => `<option value="${s.key}"${s.key === action.status ? " selected" : ""}>${s.label}</option>`).join("")}</select></label><button type="button" class="button secondary" data-action-update="${e(action.id)}">Update status</button></div></div></article>`).join("") : '<div class="empty-state"><h3>No action plans to show</h3><p>Adjust the month filter, create a general team action, or start from an available aggregate insight in Overview &amp; Trends.</p></div>'}</section><p id="action-page-error" class="form-error" role="alert" hidden></p></div>`;
}
export function renderActionForm(data, prefill = {}) {
    const selectedTeam = prefill.teamId ?? data.teams[0]?.id;
    if (!data.teams.some((team) => team.id === selectedTeam)) throw new Error("This team is no longer available.");
    return `<form id="action-form" class="action-form"><p id="action-origin" class="field-help">${prefill.sourceWeek ? `Based on an available aggregate change for the week of ${e(dateLabel(prefill.sourceWeek))}.` : "General team action. No measured insight is linked."}</p>${prefill.sourceWeek ? `<input type="hidden" name="sourceWeek" value="${e(prefill.sourceWeek)}">` : ""}
        <label>Team<select name="teamId" required>${data.teams.map((team) => `<option value="${e(team.id)}"${team.id === selectedTeam ? " selected" : ""}>${e(team.name)}</option>`).join("")}</select></label>
        <label>Title<input name="title" maxlength="180" required autocomplete="off"></label>
        <label>Related area<select name="area" required>${ACTION_AREAS.map((area) => `<option value="${area.key}"${area.key === prefill.area ? " selected" : ""}>${area.label}</option>`).join("")}</select></label>
        <label>Description<textarea name="description" maxlength="2000" rows="3" required placeholder="Describe a team-level improvement, without individual employee information."></textarea></label>
        <div class="action-form-pair"><label>Owner<select name="owner"><option value="team_manager">Team Manager</option></select></label><label>Target date<input type="date" name="targetDate" required></label></div>
        <label>Status<select name="status">${ACTION_STATUSES.map((status) => `<option value="${status.key}">${status.label}</option>`).join("")}</select></label><p id="action-form-error" class="form-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" class="button secondary" data-close-dialog>Cancel</button><button type="submit" class="button">Create action plan</button></div></form>`;
}

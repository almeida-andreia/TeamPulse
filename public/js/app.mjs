import { createEmployeeApi } from "./employee-api.mjs";
import { ANSWER_OPTIONS, CHALLENGES, SCORE_FIELDS, SCORE_DIRECTIONS, validateCheckinStep } from "./checkin.mjs";
import { escapeHtml as e, icon, dateLabel, timeLabel, renderChange, sparkline, downloadFile, activityStatusLabel, activityRegistrationLabel, renderHomeReminders } from "./ui.mjs";
import { PILLARS, pillarLevel, monthlyCompletion } from "./wellbeing.mjs";
import { lisbonDateKey } from "./demo-employee-api.mjs";
import { createReportingApi, emptyOverview, renderOverview } from "./reporting.mjs";
import { createActionsApi, renderActionPlans, renderActionForm } from "./actions.mjs";
import { createHrActivitiesApi, renderHrActivities, renderHrActivityForm } from "./hr-activities.mjs";
import { createEventsApi, renderEventForm } from "./team-events.mjs";

const source = document.querySelector('meta[name="teampulse-data-source"]').content;
const api = createEmployeeApi(source);
const reportingApi = createReportingApi(source);
const actionsApi = createActionsApi(source);
const hrActivitiesApi = createHrActivitiesApi(source);
const eventsApi = createEventsApi(source);
let demoAccessEnabled = source !== "postgres", demoAccessMessage = "", accessSubmitting = false;
let activityFilters = {}, hrActivityPrefill = {}, actionMonth = "";
const activitiesDemo = source === "demo";
const supportDemo = source === "demo";
const main = document.querySelector("main");
const dialog = document.querySelector("#detail-dialog");
const navigation = [
    ["home", "Home", "home"], ["check-in", "Check-in", "check"],
    ["history", "My Wellbeing", "chart"], ["support", "Support", "heart"]
];
const ACCESS_KEY = "teampulse.prototype-role.v1";
const roleNames = { employee: "Employee", manager: "Manager", hr: "People" };
// This remembers DEMO navigation only. It grants no API/backend permissions.
let rememberedRole = null;
try { const saved = sessionStorage.getItem(ACCESS_KEY); if (["demo", "postgres"].includes(source) && Object.hasOwn(roleNames, saved)) rememberedRole = saved; } catch { /* A prototype also works without storage. */ }
const state = { role: rememberedRole, employee: null, step: 0, period: "30days", draft: { challenges: [], comment: "" }, renderId: 0,
    reportingAccessError: false, reportingData: null, reportMetric: "wellbeing", reportScope: null };
let toastTimer;
const privacy = () => `<div class="notice">${icon("shield")}<p><strong>Your response is anonymous.</strong><br>Managers and HR see grouped results only. Your personal history stays private.</p></div>`;
const heading = (title, subtitle, eyebrow = "YOUR WORKSPACE") => `<div class="page-heading"><div><p class="eyebrow">${e(eyebrow)}</p><h1 id="page-title" tabindex="-1">${e(title)}</h1><p class="subtitle">${e(subtitle)}</p></div></div>`;
function toast(message) {
    const target = document.querySelector("#toast"); target.textContent = message; target.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { target.hidden = true; }, 5000);
}
function showError(error, target = main) {
    target.innerHTML = `<div class="error-panel" role="alert"><p>${e(error.message || "Something went wrong. Please try again.")}</p><button class="button secondary" data-retry>Try again</button></div>`;
}
function activeRoute() { return [...navigation.map(([id]) => id), "sessions"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "home"; }
function navigate(route) { if (location.hash === `#${route}`) render(); else location.hash = route; }
function metric(label, value, delta, symbol, direction) {
    return `<article class="card metric"><div class="metric-top"><span class="metric-icon">${icon(symbol)}</span>${e(label)}</div><div class="metric-value"><strong>${Number(value).toFixed(1)}<small>/ 10</small></strong><span class="level">${value >= 7 ? "Upper range" : value >= 4 ? "Mid-range" : "Lower range"}</span></div><span class="change">${renderChange(delta, direction)}</span></article>`;
}
function activityRow(activity) {
    return `<article class="activity-row"><div class="activity-date"><b>${e(dateLabel(activity.startsAt, { day: "numeric", month: undefined }))}</b><small>${e(dateLabel(activity.startsAt, { day: undefined, month: "short" }))}</small></div><div><h3>${e(activity.title)}</h3><p>${e(activity.type)} · ${activity.duration} min · ${e(activity.format)}</p></div><button class="icon-button" data-activity="${e(activity.id)}" aria-label="View ${e(activity.title)}">${icon("chevron")}</button></article>`;
}
function historyMetrics(history) {
    const last = history.latest;
    if (!last) return `<div class="card empty-state">${icon("pulse")}<h3>Your first reflection starts here.</h3><p>Complete your first weekly check-in to begin your private wellbeing history.</p><a href="#check-in" class="button">Take my first check-in ${icon("arrow")}</a></div>`;
    return `<div class="metrics">${metric("Wellbeing", last.wellbeing, history.monthlyChange.wellbeing, "sun", SCORE_DIRECTIONS.wellbeing)}${metric("Workload pressure", last.workload, history.monthlyChange.workload, "layers", SCORE_DIRECTIONS.workload)}${metric("Team connection", last.teamIntegration, history.monthlyChange.teamIntegration, "people", SCORE_DIRECTIONS.teamIntegration)}</div>`;
}
function completionCard(history) {
    const progress = history.monthlyCompletion ?? monthlyCompletion(history.entries, lisbonDateKey());
    const completed = Math.min(4, Math.max(0, progress.completed));
    return `<div class="completion-card monthly-completion" aria-label="Check-ins completed this month: ${completed} out of 4"><div><strong>${completed}<small> / 4</small></strong><span>check-ins completed<br>this month</span></div></div>`;
}
function corePillars(history) {
    return `<aside class="card pillars-card"><h2>Core Pillars</h2><p class="field-help">Your latest recorded check-in across the five measured dimensions.</p>${PILLARS.map((pillar) => {
        const value = history.latest?.[pillar.key];
        return `<div class="wellbeing-pillar"><div><h3>${e(pillar.label)}</h3><strong>${Number.isFinite(value) ? `${value.toFixed(1)} / 10` : "Unavailable"}</strong></div>${Number.isFinite(value) ? `<progress max="10" value="${value}" aria-label="${e(pillar.label)}: ${value} out of 10"></progress>` : '<div class="report-muted-bar" aria-hidden="true"></div>'}<span class="pillar-level">${e(pillarLevel(value, pillar.direction))}</span><p>${e(pillar.hint)}</p></div>`;
    }).join("")}<p class="field-help">Missing answers remain unavailable. These ranges are not health assessments.</p></aside>`;
}
async function homeView() {
    const [status, history, activities, appointments] = await Promise.all([api.getCheckinStatus(), api.getHistory("30days"), api.getActivities(), api.getAppointmentReminders()]);
    const recommended = activities.find((activity) => activity.recommended) ?? activities[0];
    const monthMetric = (label, key) => {
        const value = history.latest[key], delta = history.monthlyChange?.[key];
        return `<article class="card month-metric"><h3>${label}</h3><strong>${Number(value).toFixed(1)}<small>/ 10</small></strong><p class="change">${renderChange(delta, SCORE_DIRECTIONS[key])}</p>${sparkline(history.entries.slice(-5).map((entry) => ({ wellbeing: entry[key] })))}</article>`;
    };
    return `<div class="employee-home">${heading("Your Wellbeing Space", "A quiet moment to reflect on your experience at work.", "PRIVATE EMPLOYEE SPACE")}
        ${renderHomeReminders(status, activities, appointments)}
        <section class="home-month"><div class="section-heading"><div><p class="eyebrow">YOUR PRIVATE VIEW</p><h2>My month</h2></div><a href="#history" class="text-link">View history ${icon("arrow")}</a></div>
        ${history.latest ? `<div class="month-grid">${completionCard(history)}${monthMetric("Wellbeing", "wellbeing")}${monthMetric("Workload", "workload")}${monthMetric("Team integration", "teamIntegration")}</div><p class="month-caption">Last 30 days · Latest scores shown. Higher workload means more pressure.</p>` : `${completionCard(history)}${historyMetrics(history)}`}</section>
        <section class="home-recommendations"><div class="section-heading"><div><p class="eyebrow">SELECTED FOR YOU</p><h2>Recommended for you</h2></div></div>${recommended ? `<article class="card recommended-card"><div class="recommended-art" aria-hidden="true">${icon("sparkle")}</div><div><span class="tag">${e(recommended.type)} · ${recommended.duration} min</span><h3>${e(recommended.title)}</h3><p>${e(recommended.description)}</p></div><button class="button secondary" data-activity="${e(recommended.id)}">View activity</button></article>` : '<p class="muted">Support activities will appear here when available.</p>'}</section></div>`;
}
let checkinSubmitting = false;
function scoreQuestion(key, title, hint, low, high) {
    return `<div class="checkin-scale-section"><fieldset class="scale-question ${key === "stress" ? "stress-question" : "safety-question"}" aria-describedby="${key}-hint"><legend><h2>${e(title)}</h2></legend><p id="${key}-hint" class="question-hint">${e(hint)}</p><div class="score-options">${Array.from({ length: 5 }, (_, i) => i + 1).map((score) => `<label class="score-choice"><input type="radio" name="${key}" value="${score}" required ${state.draft[key] === score ? "checked" : ""}><span>${score}</span></label>`).join("")}</div><div class="scale-labels"><span>${e(low)}</span><span>${e(high)}</span></div></fieldset></div>`;
}
function categoricalQuestion(key, title, hint) {
    return `<fieldset class="checkin-question" aria-describedby="${key}-hint"><legend><h1 id="page-title" tabindex="-1">${e(title)}</h1></legend><p id="${key}-hint" class="question-hint">${e(hint)}</p><div class="categorical-options">${ANSWER_OPTIONS[key].map((choice) => `<label class="choice-card"><input type="radio" name="${key}" value="${choice.id}" required ${state.draft[key] === choice.id ? "checked" : ""}><span class="choice-body"><span class="choice-copy"><span>${e(choice.label)}</span>${choice.description ? `<small>${e(choice.description)}</small>` : ""}</span><span class="choice-indicator" aria-hidden="true"></span></span></label>`).join("")}</div></fieldset>`;
}
function saveDraft(form) {
    const data = new FormData(form);
    for (const key of SCORE_FIELDS) if (data.has(key)) state.draft[key] = Object.hasOwn(ANSWER_OPTIONS, key) ? data.get(key) : Number(data.get(key));
    if (state.step === 3) { state.draft.challenges = data.getAll("challenges"); state.draft.comment = String(data.get("comment") || ""); }
}
async function checkinView() {
    const status = await api.getCheckinStatus();
    if (status.submitted) return `<section class="checkin-confirmation">${heading("Your Wellbeing Space", "A quiet moment to reflect on your experience at work.", "PRIVATE EMPLOYEE SPACE")}<div class="card submitted-card"><div class="submitted-copy"><p class="submitted-label"><span>${icon("check")}</span>CHECK-IN SUBMITTED</p><h2>Thank you for checking in.</h2><p>Your weekly check-in has been submitted successfully. You're all set for this week.</p></div><aside class="submitted-privacy">${icon("shield")}<strong>Your response is anonymous.</strong><p>Only aggregated insights are shared. Your individual responses are not shared with your manager or HR.</p></aside><div class="submitted-footer"><span class="completed-badge">${icon("check")}Completed</span><div><strong>Weekly Check-in · This week</strong><p>Come back next week for another moment to reflect.</p></div><a href="#history" class="button">View my wellbeing ${icon("arrow")}</a></div></div><p class="field-help">Your next weekly check-in opens on ${e(dateLabel(status.nextOpensOn ?? status.nextWeek, { weekday: "long" }))}.</p></section>`;
    if (status.available === false) return `${heading("Weekly Check-in", "A quiet moment to reflect on your experience at work.")}<div class="notice">${icon("calendar")}<p><strong>Opens Friday</strong><br>Your weekly check-in opens on ${e(dateLabel(status.opensOn, { weekday: "long" }))}. You can respond through Sunday, Lisbon time.</p></div>`;
    const step = state.step;
    const titles = ["Overall wellbeing", "Workload & stress", "Team connection", "Current challenges"];
    const questions = [
        () => categoricalQuestion("wellbeing", "How have you been feeling at work recently?", "Choose the answer that best reflects your recent experience. Take a breath and answer freely."),
        () => categoricalQuestion("workload", "How manageable has your workload been recently?", "Choose the answer that best reflects your recent experience.") + scoreQuestion("stress", "How much work-related stress have you experienced recently?", "Rated from 1 (minimal tension) to 5 (overwhelming pressure).", "Very low", "Very high"),
        () => categoricalQuestion("teamIntegration", "How connected do you currently feel with your team?", "Choose the answer that best reflects your recent experience.") + scoreQuestion("psychologicalSafety", "How easily can you ask teammates or your lead for help when needed?", "Considers psychological safety, approachable leadership, and willingness to share blockers.", "Difficult to reach out", "Effortless & welcoming"),
        () => `<fieldset class="checkin-question" aria-describedby="challenges-hint"><legend><h1 id="page-title" tabindex="-1">What is currently affecting your work experience?</h1></legend><p id="challenges-hint" class="question-hint">Choose all options that apply (multiple choice).</p><div class="challenge-options">${CHALLENGES.map((choice) => `<label class="challenge-choice"><span>${e(choice.label)}</span><input type="checkbox" name="challenges" value="${e(choice.id)}" ${state.draft.challenges.includes(choice.id) ? "checked" : ""}></label>`).join("")}</div></fieldset><div class="checkin-context"><label class="field-label" for="checkin-comment">ADD CONTEXT (OPTIONAL)</label><p id="comment-hint">Anything else you would like to share? Responses are aggregated into thematic insights only.</p><textarea id="checkin-comment" name="comment" maxlength="2000" rows="3" aria-describedby="comment-hint comment-limit" placeholder="Share only what you feel comfortable sharing…">${e(state.draft.comment)}</textarea><p id="comment-limit" class="field-help">Please avoid names or identifying details. Maximum 2,000 characters.</p></div>`
    ];
    return `<section class="checkin-layout weekly-checkin" aria-label="Weekly check-in"><div class="checkin-topline">${step ? `<button type="button" class="checkin-back" data-back>${icon("arrow")}Back</button>` : `<a class="checkin-back" href="#home">${icon("arrow")}Back</a>`}<span>${icon("clock")}About 2 minutes</span></div>
        <div class="checkin-progress-labels"><span>Step ${step + 1} of 4</span><strong>${titles[step]}</strong></div><div class="progress-track" role="progressbar" aria-label="Check-in progress" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${step + 1}" aria-valuetext="Step ${step + 1} of 4"><div class="progress-fill" style="width:${(step + 1) * 25}%"></div></div>
        <div class="card question-card"><p class="question-number" aria-hidden="true">0${step + 1}${step === 3 ? '<span>MULTI-SELECT PROMPT</span>' : ""}</p><form id="checkin-form">${questions[step]()}<p id="checkin-error" class="form-error" role="alert" hidden></p><div class="form-footer"><span class="checkin-anonymity">${icon("lock")}Your response is anonymous.</span><div class="checkin-actions">${step ? `<button type="button" class="button ghost" data-back>Back</button>` : ""}<button type="submit" class="button">${step === 3 ? "Submit check-in" : "Continue"}${icon("arrow")}</button></div></div></form></div></section>`;
}
function bindCheckin() {
    const form = document.querySelector("#checkin-form"); if (!form) return;
    form.addEventListener("change", () => saveDraft(form));
    document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", async () => { if (checkinSubmitting) return; saveDraft(form); state.step--; await render(); }));
    form.addEventListener("submit", async (event) => {
        event.preventDefault(); if (checkinSubmitting) return; saveDraft(form);
        const error = document.querySelector("#checkin-error");
        try { validateCheckinStep(state.draft, state.step); error.hidden = true; }
        catch (problem) { error.textContent = problem.message; error.hidden = false; return; }
        if (state.step < 3) { state.step++; await render(); return; }
        checkinSubmitting = true;
        const button = form.querySelector('[type="submit"]'); button.disabled = true; button.textContent = "Saving your check-in…";
        try { await api.submitCheckin({ ...state.draft }); state.draft = { challenges: [], comment: "" }; state.step = 0; await render(); }
        catch (error) { const target = document.querySelector("#checkin-error"); if (target) { target.textContent = error.message; target.hidden = false; } button.disabled = false; button.innerHTML = `Submit check-in${icon("arrow")}`; }
        finally { checkinSubmitting = false; }
    });
}
async function render() {
    const id = ++state.renderId;
    dialog.close();
    if (!location.hash || location.hash === "#auth") {
        setPrototypeRole(null);
        try { await api.endPrototypeSession?.(); } catch { /* Access still stays closed if the service is unavailable. */ }
    }
    if (!state.role) { showAccess(); return; }
    // No Employee API calls or private data are used in the other role entries.
    if (state.role !== "employee") {
        setWorkspaceVisible(true);
        const manager = state.role === "manager", route = manager ? "manager" : "organization";
        const actionPlans = manager && location.hash === "#action-plans";
        const activityForm = !manager && (location.hash === "#activity-create" || /^#activity-edit-[1-9]\d*$/.test(location.hash));
        const activities = !manager && (location.hash === "#activities" || activityForm);
        const title = activities ? "Insights & Activities" : actionPlans ? "Action Plans" : manager ? "Overview & Trends" : "Organization";
        document.querySelector("#employee-nav").innerHTML = `<a href="#${route}" class="nav-link"${!actionPlans ? ' aria-current="page"' : ""}>${icon("chart")}${manager ? "Overview & Trends" : "Organization"}</a>${manager ? `<a href="#action-plans" class="nav-link"${actionPlans ? ' aria-current="page"' : ""}>${icon("check")}Action Plans</a>` : ""}`;
        document.title = `${title} · TeamPulse`;
        if (!manager) document.querySelector("#employee-nav").innerHTML = `<a href="#organization" class="nav-link"${!activities ? ' aria-current="page"' : ""}>${icon("building")}Organization</a><a href="#activities" class="nav-link"${activities ? ' aria-current="page"' : ""}>${icon("sparkle")}Insights &amp; Activities</a>`;
        main.setAttribute("aria-busy", "true");
        if (activities) {
            try {
                const data = await hrActivitiesApi.list();
                if (id !== state.renderId) return;
                if (activityForm) {
                    const editId = location.hash.startsWith("#activity-edit-") ? location.hash.slice(15) : null;
                    const existing = editId ? data.activities.find((a) => a.id === editId) : null;
                    if (editId && !existing) throw new Error("This activity is unavailable.");
                    main.innerHTML = renderHrActivityForm(data, hrActivityPrefill, existing); bindHrActivityForm(existing);
                } else { main.innerHTML = renderHrActivities(data, activityFilters); bindHrActivities(); }
            } catch (error) { if (id === state.renderId) showError(error); }
            finally { if (id === state.renderId) main.removeAttribute("aria-busy"); }
            document.querySelector("#page-title")?.focus({ preventScroll: true });
            return;
        }
        if (actionPlans) {
            try {
                const data = await actionsApi.list();
                if (id !== state.renderId) return;
                main.innerHTML = renderActionPlans(data, actionMonth); bindActionPlans();
            } catch (error) { if (id === state.renderId) showError(error); }
            finally { if (id === state.renderId) main.removeAttribute("aria-busy"); }
            document.querySelector("#page-title")?.focus({ preventScroll: true });
            return;
        }
        try {
            const data = state.reportingData ?? (state.reportingAccessError ? emptyOverview() : await reportingApi.getOverview(state.role));
            if (id !== state.renderId) return;
            state.reportingData = data;
            main.innerHTML = renderOverview(state.role, data, state.reportMetric, state.reportScope);
        } catch { if (id === state.renderId) main.innerHTML = renderOverview(state.role, emptyOverview(), state.reportMetric); }
        finally { if (id === state.renderId) main.removeAttribute("aria-busy"); }
        document.querySelectorAll("[data-report-metric]").forEach((button) => button.addEventListener("click", async () => {
            state.reportMetric = button.dataset.reportMetric; await render();
        }));
        document.querySelector("[data-report-scope]")?.addEventListener("change", async (event) => {
            state.reportScope = event.currentTarget.value; await render();
        });
        document.querySelectorAll("[data-action-insight]").forEach((button) => button.addEventListener("click", () => {
            showActionForm({ teamId: button.dataset.actionTeam, area: button.dataset.actionInsight, sourceWeek: button.dataset.actionWeek }).catch((error) => toast(error.message));
        }));
        bindHrActivityInsights();
        document.querySelectorAll("[data-event-create]").forEach((button) => button.addEventListener("click", () => {
            const team = state.reportingData?.teams?.find((item) => item.teamId === button.dataset.eventCreate);
            if (state.role !== "manager" || !team) return;
            openDialog("Add team event", renderEventForm(team));
            const form = document.querySelector("#team-event-form");
            form.addEventListener("submit", async (event) => {
                event.preventDefault(); const save = form.querySelector('[type="submit"]'); save.disabled = true;
                try {
                    await eventsApi.create({ teamId: team.teamId, ...Object.fromEntries(new FormData(form)) });
                    dialog.close(); state.reportingData = null; await render(); toast("Team event saved.");
                } catch (error) {
                    const message = form.querySelector("#team-event-error"); message.textContent = error.message; message.hidden = false;
                } finally { if (save.isConnected) save.disabled = false; }
            });
        }));
        document.querySelector("#page-title")?.focus({ preventScroll: true });
        return;
    }
    if (!state.employee) {
        try {
            const employee = await api.getEmployee();
            if (employee.role !== "employee") throw new Error("This workspace is available to Employees only.");
            if (id !== state.renderId) return;
            state.employee = employee;
        } catch (error) { if (id === state.renderId) { setPrototypeRole(null); showAccess(error.message); } return; }
    }
    const route = activeRoute(), selected = route === "sessions" ? "support" : route;
    setWorkspaceVisible(true);
    document.querySelector("#employee-nav").innerHTML = navigation.map(([key, title, symbol]) => `<a href="#${key}" class="nav-link" ${key === selected ? 'aria-current="page"' : ""}>${icon(symbol)}${e(title)}</a>`).join("");
    document.title = `${route === "sessions" ? "Support" : navigation.find(([key]) => key === route)[1]} · TeamPulse`;
    main.setAttribute("aria-busy", "true");
    try {
        const views = { home: homeView, "check-in": checkinView, history: historyView, support: supportView, sessions: sessionsView };
        const content = await views[route]();
        if (id !== state.renderId) return;
        main.innerHTML = content;
        if (route === "check-in") bindCheckin();
        if (route === "history") bindHistory();
        document.querySelector("#page-title")?.focus({ preventScroll: true });
        window.scrollTo({ top: 0 });
    } catch (error) { if (id === state.renderId) showError(error); }
    finally { if (id === state.renderId) main.removeAttribute("aria-busy"); }
}
function historyChart(entries) {
    if (!entries.length) return `<div class="empty-state">${icon("chart")}<h3>A little more time, a little more perspective.</h3><p>Your check-ins will appear here as you complete them.</p></div>`;
    const x = (i) => 42 + i * 680 / Math.max(entries.length - 1, 1), y = (value) => 210 - Number(value) * 18;
    const line = (key) => entries.map((entry, i) => `${x(i)},${y(entry[key])}`).join(" ");
    return `<svg class="history-chart" viewBox="0 0 760 245" role="img" aria-labelledby="chart-title chart-description"><title id="chart-title">Your wellbeing and workload over time</title><desc id="chart-description">Weekly scores out of ten. The solid green line shows wellbeing; the dashed amber line shows workload pressure. Exact values are available in the table below.</desc>
        ${[0, 2, 4, 6, 8, 10].map((tick) => `<line x1="42" y1="${y(tick)}" x2="722" y2="${y(tick)}" stroke="#e9ede6" stroke-dasharray="3 5"/><text x="22" y="${y(tick) + 4}" fill="#65746e" font-size="10">${tick}</text>`).join("")}
        <polyline points="${line("workload")}" fill="none" stroke="#b48342" stroke-width="2.3" stroke-dasharray="6 5" stroke-linejoin="round"/>
        <polyline points="${line("wellbeing")}" fill="none" stroke="#4d8167" stroke-width="2.5" stroke-linejoin="round"/>
        ${entries.map((entry, i) => `<circle cx="${x(i)}" cy="${y(entry.wellbeing)}" r="4" fill="white" stroke="#4d8167" stroke-width="2"/><circle cx="${x(i)}" cy="${y(entry.workload)}" r="3" fill="#b48342"/>${entries.length <= 8 || i % 2 === 0 || i === entries.length - 1 ? `<text x="${x(i)}" y="236" fill="#65746e" font-size="10" text-anchor="middle">${e(dateLabel(entry.weekStart))}</text>` : ""}`).join("")}</svg>`;
}
async function historyView() {
    const history = await api.getHistory(state.period), last = history.latest;
    return `${heading("Your wellbeing, over time.", "Your own story, one check-in at a time. This space is visible only to you.", "MY WELLBEING")}
        <div class="notice">${icon("lock")}<p>Your individual history and personal exports are private from your manager and HR.</p></div>
        <div class="toolbar"><div class="period-tabs" role="group" aria-label="History period">${[["30days", "30 days"], ["quarter", "This quarter"], ["year", "Year to date"]].map(([value, label]) => `<button type="button" data-period="${value}" aria-pressed="${state.period === value}">${label}</button>`).join("")}</div><button class="button secondary" data-export ${history.entries.length ? "" : "disabled"}>${icon("download")}Export my summary</button></div>
        <section class="card history-completion">${completionCard(history)}<div><h2>Check-ins completed this month</h2><p>Weekly check-ins are counted in the month containing their Monday, independently of the selected history period.</p><p class="field-help">The monthly display target is 4. A fifth eligible weekly check-in remains valid.</p></div></section>
        <div class="wellbeing-layout">
        <section class="card"><div class="section-heading" style="margin-top:0"><div><h2>A little perspective</h2><p>Weekly check-ins · scores out of 10</p></div><div class="chart-legend"><span><i class="legend-line"></i>Wellbeing</span><span><i class="legend-line workload"></i>Workload</span></div></div>${historyChart(history.entries)}<p class="chart-caption">A higher workload score means more pressure. These reflections are not a health assessment.</p>
        <details><summary>View chart values as a table</summary><div class="table-wrap"><table><caption>Personal check-in scores for the selected period</caption><thead><tr><th scope="col">Week of</th><th scope="col">Wellbeing</th><th scope="col">Workload pressure</th><th scope="col">Stress</th><th scope="col">Connection</th><th scope="col">Psychological safety</th></tr></thead><tbody>${history.entries.map((entry) => `<tr><th scope="row">${e(dateLabel(entry.weekStart))}</th>${SCORE_FIELDS.map((key) => `<td>${Number.isFinite(entry[key]) ? entry[key].toFixed(1) : "Unavailable"}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details></section>
        ${corePillars(history)}</div><div class="section-heading"><div><h2>Your latest reflections</h2><p>${last ? `Week of ${e(dateLabel(last.weekStart))} · labels describe score ranges, not health conditions.` : "Your first check-in is the beginning of your personal history."}</p></div></div>${historyMetrics(history)}
        <p class="field-help">Monthly change compares the average for your latest check-in’s calendar month with the previous calendar month, using available check-ins.</p>`;
}
function bindHistory() {
    document.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", async () => {
        state.period = button.dataset.period; await render();
        document.querySelector(`[data-period="${state.period}"]`)?.focus({ preventScroll: true });
    }));
    document.querySelector("[data-export]")?.addEventListener("click", async (event) => {
        const button = event.currentTarget; button.disabled = true;
        try {
            const history = await api.getHistory(state.period);
            const rows = [["Week of", "Wellbeing (0-10)", "Workload pressure (0-10)", "Stress (0-10)", "Team connection (0-10)", "Psychological safety (0-10)"],
                ...history.entries.map((item) => [item.weekStart, ...SCORE_FIELDS.map((key) => Number.isFinite(item[key]) ? item[key] : "Unavailable")])];
            const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
            downloadFile(csv, `teampulse-my-summary-${state.period}.csv`, "text/csv;charset=utf-8");
            toast("Your personal summary is ready.");
        } catch (error) { toast(error.message); }
        finally { button.disabled = false; }
    });
}
function activityCard(activity) {
    return `<article class="card activity-card"><div class="activity-art ${e(activity.art || "balance")}" aria-hidden="true">${icon(activity.art === "connection" ? "people" : activity.art === "focus" ? "compass" : "leaf")}</div><div class="activity-body"><span class="tag">${activity.recommended ? "Recommended for you" : activity.featured ? "Featured activity" : e(activity.type)}</span><h3>${e(activity.title)}</h3><p>${e(activity.description)}</p><div class="activity-meta"><span>${icon("calendar")}${e(dateLabel(activity.startsAt))} · ${e(timeLabel(activity.startsAt))}</span><span>${icon("clock")}${activity.duration} min</span><span>${e(activity.format)}</span></div><p class="field-help">${e(activityStatusLabel(activity.status))} · ${activityRegistrationLabel(activity.registrationOpen !== false)}</p><button class="button ${activity.registered ? "secondary" : ""}" data-activity="${e(activity.id)}">${activity.registered ? `${icon("check")}You’re registered` : `View activity ${icon("arrow")}`}</button></div></article>`;
}
async function supportView() {
    const activities = await api.getActivities();
    return `${heading("Support that fits your week.", "Small opportunities to connect, find perspective, and make space for yourself.", "SUPPORT & ACTIVITIES")}
        <div class="section-heading"><div><h2>Featured & upcoming</h2><p>Recommendations are private to you and never shared with your manager.</p></div></div>
        <div class="activity-grid">${activities.length ? activities.map(activityCard).join("") : '<p class="empty-state">No activities are available right now. Please check back soon.</p>'}</div>
        <aside class="support-callout">${icon("message")}<div><h2>A conversation can be a good place to start.</h2><p>Explore confidential sessions with a psychologist, online or in person.</p></div><a class="button secondary" href="#sessions">Explore sessions ${icon("arrow")}</a></aside>`;
}
function openDialog(title, body, actions = "") {
    document.querySelector("#dialog-content").innerHTML = `<div class="dialog-inner"><div class="dialog-heading"><h2 id="dialog-title">${e(title)}</h2><button class="icon-button" data-close-dialog aria-label="Close dialog">${icon("close")}</button></div>${body}<p class="form-error" id="dialog-error" role="alert" hidden></p>${actions ? `<div class="dialog-actions">${actions}</div>` : ""}</div>`;
    if (!dialog.open) dialog.showModal();
}
async function showActionForm(prefill = {}) {
    if (state.role !== "manager") return;
    const data = await actionsApi.list();
    if (state.role !== "manager") return;
    openDialog("Create action plan", renderActionForm(data, prefill));
    const form = document.querySelector("#action-form");
    form.addEventListener("change", (event) => {
        if (["teamId", "area"].includes(event.target.name) && form.elements.sourceWeek) {
            form.elements.sourceWeek.remove();
            document.querySelector("#action-origin").textContent = "General team action. No measured insight is linked.";
        }
    });
    form.addEventListener("submit", async (event) => {
        event.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
        try {
            await actionsApi.create(Object.fromEntries(new FormData(form)));
            dialog.close(); navigate("action-plans"); toast("Action plan created.");
        } catch (error) {
            const message = document.querySelector("#action-form-error");
            if (message) { message.textContent = error.message; message.hidden = false; }
        } finally { if (button.isConnected) button.disabled = false; }
    });
}
function bindActionPlans() {
    document.querySelector("[data-action-month]")?.addEventListener("change", (event) => { actionMonth = event.target.value; render(); });
    document.querySelector("[data-action-create]")?.addEventListener("click", () => showActionForm().catch((error) => toast(error.message)));
    document.querySelectorAll("[data-action-update]").forEach((button) => button.addEventListener("click", async () => {
        button.disabled = true;
        try {
            await actionsApi.updateStatus(button.dataset.actionUpdate, document.querySelector(`#action-status-${button.dataset.actionUpdate}`).value);
            await render(); toast("Action status updated.");
        } catch (error) {
            const message = document.querySelector("#action-page-error");
            if (message) { message.textContent = error.message; message.hidden = false; }
        } finally { if (button.isConnected) button.disabled = false; }
    }));
}
function bindHrActivityInsights() {
    document.querySelectorAll("[data-hr-activity-insight]").forEach((button) => button.addEventListener("click", () => {
        hrActivityPrefill = { departmentId: button.dataset.hrActivityDepartment, area: button.dataset.hrActivityInsight, sourceWeek: button.dataset.hrActivityWeek };
        navigate("activity-create");
    }));
}
function bindHrActivityForm(existing) {
    const form = document.querySelector("#hr-activity-form");
    if (existing?.source) {
        for (const name of ["departmentId", "area"]) {
            const select = form.elements[name];
            const hidden = document.createElement("input"); hidden.type = "hidden"; hidden.name = name; hidden.value = select.value;
            select.disabled = true; form.append(hidden);
        }
    }
    form.addEventListener("change", (event) => {
        if (!existing && ["departmentId", "area"].includes(event.target.name) && form.elements.sourceWeek) {
            form.elements.sourceWeek.remove();
            hrActivityPrefill = {};
            document.querySelector("#hr-activity-origin").textContent = "General activity. No measured insight is linked.";
        }
    });
    form.addEventListener("submit", async (event) => {
        event.preventDefault(); const button = form.querySelector('[type="submit"]'); button.disabled = true;
        try {
            const input = Object.fromEntries(new FormData(form));
            input.departmentId ||= null; input.area ||= null;
            input.duration = Number(input.duration); input.startsAt = new Date(input.startsAt).toISOString();
            if (existing) await hrActivitiesApi.update(existing.id, input); else await hrActivitiesApi.create(input);
            activityFilters = {}; hrActivityPrefill = {}; navigate("activities"); toast("Wellbeing activity saved.");
        } catch (error) {
            const message = document.querySelector("#hr-activity-form-error");
            if (message) { message.textContent = error.message; message.hidden = false; }
        } finally { if (button.isConnected) button.disabled = false; }
    });
}
function bindHrActivities() {
    bindHrActivityInsights();
    document.querySelector("[data-hr-activity-create]")?.addEventListener("click", () => { hrActivityPrefill = {}; navigate("activity-create"); });
    document.querySelectorAll("[data-hr-activity-filter]").forEach((select) => select.addEventListener("change", () => {
        activityFilters[select.dataset.hrActivityFilter] = select.value; render();
    }));
    document.querySelectorAll("[data-hr-activity-edit]").forEach((button) => button.addEventListener("click", () => {
        hrActivityPrefill = {}; navigate("activity-edit-" + button.dataset.hrActivityEdit);
    }));
}
async function showActivity(id) {
    const activity = (await api.getActivities()).find((item) => item.id === id);
    if (!activity) throw new Error("This activity is no longer available.");
    const open = activity.registrationOpen !== false; // Demo DTOs predate the server availability field.
    openDialog(activity.title, `<span class="tag">${e(activity.type)}</span><p class="subtitle">${e(activity.description)}</p><dl class="detail-list"><dt>When</dt><dd>${e(dateLabel(activity.startsAt, { weekday: "long" }))} · ${e(timeLabel(activity.startsAt))} Lisbon time</dd><dt>Duration</dt><dd>${activity.duration} minutes</dd><dt>Format</dt><dd>${e(activity.format)}</dd><dt>Audience</dt><dd>${e(activity.audience)}</dd><dt>Status</dt><dd>${e(activityStatusLabel(activity.status))} · ${activityRegistrationLabel(open)}</dd></dl>${activity.registered ? `<div class="notice">${icon("check")}<p>You’re registered. You’ll find this activity marked in your support page.</p></div>` : !open ? '<p class="field-help">Registration is closed for this activity.</p>' : `<p class="field-help">${activitiesDemo ? "Demo registration only. No real place is reserved." : "Your registration is private from your manager."}</p>`}`,
    activity.registered || !open ? `${activity.registered && open && !activitiesDemo ? `<button class="button secondary" data-cancel-registration="${e(id)}">Cancel registration</button>` : ""}<button class="button secondary" data-close-dialog>Done</button>` : `<button class="button" data-register="${e(id)}">${activitiesDemo ? "Register in demo" : "Register for activity"}${icon("arrow")}</button>`);
}
async function showAppointment(id) {
    // Refresh the same session-owned PostgreSQL reminder source. Never route a
    // persisted appointment into the unrelated browser-demo booking workflow.
    const appointment = (await api.getAppointmentReminders()).find((item) => item.id === id
        && item.status === "booked" && Date.parse(item.startsAt) > Date.now());
    if (!appointment) throw new Error("This appointment is no longer upcoming.");
    const canChange = Date.parse(appointment.startsAt) - Date.now() >= 7200000;
    openDialog("Your psychologist appointment", `<p class="subtitle">Your consultation is scheduled.</p><dl class="detail-list"><dt>When</dt><dd>${e(dateLabel(appointment.startsAt, { weekday: "long", year: "numeric" }))} · ${e(timeLabel(appointment.startsAt))} Lisbon time</dd><dt>Format</dt><dd>${e(appointment.format)}${appointment.location ? ` · ${e(appointment.location)}` : ""}</dd></dl><div class="notice">${icon("lock")}<p>Your appointment is private from your manager and HR.</p></div><p class="field-help">Changes close two hours before the appointment.</p>`,
        `<button class="button secondary" type="button" data-appointment-reschedule="${e(id)}"${canChange ? "" : " disabled"}>Reschedule appointment</button><button class="button secondary" type="button" data-appointment-cancel="${e(id)}"${canChange ? "" : " disabled"}>Cancel appointment</button><button class="button secondary" type="button" data-close-dialog>Done</button>`);
}
async function showAppointmentReschedule(id) {
    const [appointments, slots] = await Promise.all([api.getAppointmentReminders(), api.getAppointmentSlots()]);
    if (!appointments.some((a) => a.id === id)) throw new Error("This appointment is no longer upcoming.");
    openDialog("Reschedule appointment", `<p class="subtitle">Your current appointment stays booked until you confirm the new time.</p>${slots.length ? `<label class="field-label" for="appointment-slot">Choose another available slot</label><select id="appointment-slot">${slots.map((slot) => `<option value="${e(slot.id)}">${e(dateLabel(slot.startsAt, { year: "numeric" }))} · ${e(timeLabel(slot.startsAt))} Lisbon time · ${e(slot.format)}</option>`).join("")}</select>` : '<p>No other appointment slots are available right now.</p>'}`,
        `<button class="button secondary" data-appointment="${e(id)}">Keep appointment</button>${slots.length ? `<button class="button" data-appointment-review="${e(id)}">Review new time ${icon("arrow")}</button>` : ""}`);
}
async function reviewAppointmentReschedule(id, slotId) {
    const slot = (await api.getAppointmentSlots()).find((s) => s.id === slotId);
    if (!slot) throw new Error("That slot is no longer available. Please choose another.");
    openDialog("Confirm new appointment time", `<p class="subtitle">${e(dateLabel(slot.startsAt, { weekday: "long", year: "numeric" }))} · ${e(timeLabel(slot.startsAt))} Lisbon time<br>${e(slot.format)}${slot.location ? ` · ${e(slot.location)}` : ""}</p><p class="field-help">Your existing appointment will move to this slot when confirmed.</p>`,
        `<button class="button secondary" data-appointment="${e(id)}">Keep appointment</button><button class="button" data-appointment-confirm="${e(id)}" data-appointment-slot="${e(slot.id)}">Confirm reschedule</button>`);
}
function bookingCard(booking) {
    const active = booking.status === "booked";
    let videoLink = "";
    if (active && booking.format === "Online") {
        let url; try { const candidate = new URL(booking.videoUrl); if (candidate.protocol === "https:") url = candidate.href; } catch { /* No live link in demo bookings. */ }
        videoLink = url ? `<a class="text-link" href="${e(url)}" target="_blank" rel="noopener noreferrer">${icon("video")}Open video link</a>` : `<button class="button ghost" data-demo-video>${icon("video")}Demo video room</button>`;
    }
    return `<article class="booking-card"><span class="tag">${active ? "Confirmed" : "Cancelled"}${booking.demo ? " · Demo" : ""}</span><h3>${e(booking.psychologist)}</h3><p>${e(dateLabel(booking.startsAt, { weekday: "short" }))} · ${e(timeLabel(booking.startsAt))} · ${booking.duration} min<br>${e(booking.format)}${booking.location ? ` · ${e(booking.location)}` : ""}</p>${videoLink}${active ? `<div class="button-row"><button class="button secondary" data-calendar="${e(booking.id)}">${icon("download")}Add to calendar</button><button class="button ghost" data-reschedule="${e(booking.id)}" ${booking.canChange ? "" : "disabled"}>Reschedule</button><button class="button ghost" data-cancel-booking="${e(booking.id)}" ${booking.canChange ? "" : "disabled"}>Cancel</button></div>${booking.canChange ? "" : '<p class="field-help">Changes close two hours before the session.</p>'}` : ""}</article>`;
}
async function sessionsView() {
    const [slots, bookings] = await Promise.all([api.getSlots(), api.getBookings()]);
    const available = slots.filter((slot) => slot.available);
    const ordered = [...bookings].sort((a, b) => (a.status === "cancelled") - (b.status === "cancelled") || a.startsAt.localeCompare(b.startsAt));
    return `${heading("A private space to talk.", "Choose a session that works for you. There’s no need to share a reason for booking.", "PSYCHOLOGIST SESSIONS")}
        <div class="notice">${icon("shield")}<p><strong>Your session is confidential.</strong> Booking information is not shared with your manager or HR.${supportDemo ? " This preview does not create real appointments." : ""}</p></div>
        <div class="session-grid"><section class="card"><div class="section-heading" style="margin-top:0"><div><h2>Available sessions</h2><p>All times shown in Lisbon time.</p></div></div>${available.length ? available.map((slot) => `<article class="slot"><div><h3>${e(slot.psychologist)}</h3><p>${e(dateLabel(slot.startsAt, { weekday: "short" }))} · ${e(timeLabel(slot.startsAt))} · ${slot.duration} min</p><span class="tag">${e(slot.format)}</span></div><button class="button secondary" data-slot="${e(slot.id)}">Choose session ${icon("arrow")}</button></article>`).join("") : '<p class="empty-state">There are no available sessions right now. Please check back soon.</p>'}</section>
        <aside class="card"><h2>Your sessions</h2><p class="field-help">Only you can see these bookings.</p>${ordered.length ? ordered.map(bookingCard).join("") : `<div class="empty-state">${icon("calendar")}<h3>Your next step, in your own time.</h3><p>Your confirmed sessions will appear here.</p></div>`}<p class="field-help">You can reschedule or cancel up to two hours before a session.</p></aside></div>`;
}
async function showBookingReview(slotId, bookingId = "") {
    const slot = (await api.getSlots()).find((item) => item.id === slotId && item.available);
    if (!slot) throw new Error("That session is no longer available. Please choose another.");
    openDialog(bookingId ? "Confirm your new session" : "A little time, just for you.", `<p class="subtitle">Review your session before confirming.</p><dl class="detail-list"><dt>Psychologist</dt><dd>${e(slot.psychologist)}</dd><dt>When</dt><dd>${e(dateLabel(slot.startsAt, { weekday: "long" }))} · ${e(timeLabel(slot.startsAt))} Lisbon time</dd><dt>Duration</dt><dd>${slot.duration} minutes</dd><dt>Format</dt><dd>${e(slot.format)}${slot.location ? ` · ${e(slot.location)}` : ""}</dd></dl><div class="notice">${icon("lock")}<p>${supportDemo ? "This is a demo booking. No actual appointment or video room will be created." : "This booking is private and is not shared with your manager or HR."}</p></div>`,
        `<button class="button secondary" data-close-dialog>Not now</button><button class="button" data-confirm-slot="${e(slot.id)}" data-booking-id="${e(bookingId)}">${bookingId ? "Confirm reschedule" : supportDemo ? "Confirm demo booking" : "Confirm booking"}${icon("check")}</button>`);
}
async function showReschedule(id) {
    const available = (await api.getSlots()).filter((slot) => slot.available);
    openDialog("Find another time", `<p class="subtitle">Your current session stays booked until the new time is confirmed.</p>${available.length ? `<label class="field-label" for="new-slot">Choose a new session</label><select id="new-slot">${available.map((slot) => `<option value="${e(slot.id)}">${e(dateLabel(slot.startsAt))} · ${e(timeLabel(slot.startsAt))} · ${e(slot.psychologist)} · ${e(slot.format)}</option>`).join("")}</select>` : '<p>No other sessions are available right now.</p>'}`,
        available.length ? `<button class="button secondary" data-close-dialog>Keep my session</button><button class="button" data-review-reschedule="${e(id)}">Review new time ${icon("arrow")}</button>` : `<button class="button secondary" data-close-dialog>Close</button>`);
}
async function exportCalendar(id) {
    const booking = (await api.getBookings()).find((item) => item.id === id && item.status === "booked");
    if (!booking) throw new Error("This booking is no longer available.");
    const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const text = (value) => String(value).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
    const startsAt = new Date(booking.startsAt), endsAt = new Date(startsAt.getTime() + booking.duration * 60000);
    const calendar = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TeamPulse//Employee Support//EN", "BEGIN:VEVENT", `UID:${text(booking.id)}@teampulse.local`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(startsAt)}`, `DTEND:${stamp(endsAt)}`, `SUMMARY:${booking.demo ? "Demo - " : ""}TeamPulse private session`, "CLASS:PRIVATE", `DESCRIPTION:${text(booking.demo ? "Demo only. No real session has been booked." : "Your private TeamPulse support session.")}`, `LOCATION:${text(booking.location || "Online")}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
    downloadFile(calendar, "teampulse-private-session.ics", "text/calendar;charset=utf-8");
    toast("Calendar file ready. Choose where to add your private session.");
}

document.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.hasAttribute("data-close-dialog")) { dialog.close(); return; }
    if (button.dataset.policy) {
        const messages = {
            privacy: ["Your privacy", `Individual check-ins and personal history stay private. Managers and HR receive aggregated insights only. ${source === "postgres" ? "This MVP saves fictional check-ins, activities and private appointments in PostgreSQL." : "This prototype uses fictional data saved in this browser tab."}`],
            security: ["Prototype access", "These buttons open a local prototype. They do not connect to Microsoft, Google, or an email service. Production access must be verified by the server."],
            accessibility: ["Accessibility", "Use Tab to move between controls, arrow keys to select a role, and Enter or Space to activate buttons. Charts also provide a table of values."],
            support: ["Prototype support", "For help with this academic prototype, contact your TeamPulse project team. No external support service is connected."]
        };
        const information = messages[button.dataset.policy];
        if (information) openDialog(information[0], `<p class="subtitle">${information[1]}</p>`);
        return;
    }
    if (button.hasAttribute("data-retry")) { if (state.employee) render(); else start(); return; }
    if (state.role !== "employee") return;
    try {
        if (button.dataset.activity) await showActivity(button.dataset.activity);
        else if (button.dataset.appointment) await showAppointment(button.dataset.appointment);
        else if (button.dataset.cancelRegistration) openDialog("Cancel registration?", '<p class="subtitle">You will no longer be registered for this activity.</p>',
            `<button class="button secondary" data-activity="${e(button.dataset.cancelRegistration)}">Keep registration</button><button class="button danger" data-confirm-registration-cancel="${e(button.dataset.cancelRegistration)}">Cancel registration</button>`);
        else if (button.dataset.confirmRegistrationCancel) {
            button.disabled = true; await api.cancelActivityRegistration(button.dataset.confirmRegistrationCancel);
            dialog.close(); await render(); toast("Your registration has been cancelled.");
        } else if (button.dataset.appointmentReschedule) await showAppointmentReschedule(button.dataset.appointmentReschedule);
        else if (button.dataset.appointmentReview) await reviewAppointmentReschedule(button.dataset.appointmentReview, document.querySelector("#appointment-slot").value);
        else if (button.dataset.appointmentConfirm) {
            button.disabled = true; await api.rescheduleAppointment(button.dataset.appointmentConfirm, button.dataset.appointmentSlot);
            dialog.close(); await render(); toast("Your appointment has been rescheduled.");
        } else if (button.dataset.appointmentCancel) openDialog("Cancel appointment?", '<p class="subtitle">Your appointment will be cancelled and the slot will become available again.</p>',
            `<button class="button secondary" data-appointment="${e(button.dataset.appointmentCancel)}">Keep appointment</button><button class="button danger" data-appointment-cancel-confirm="${e(button.dataset.appointmentCancel)}">Cancel appointment</button>`);
        else if (button.dataset.appointmentCancelConfirm) {
            button.disabled = true; await api.cancelAppointment(button.dataset.appointmentCancelConfirm);
            dialog.close(); await render(); toast("Your appointment has been cancelled.");
        }
        else if (button.dataset.register) {
            button.disabled = true;
            const id = button.dataset.register;
            await api.registerActivity(id); await render(); await showActivity(id);
            toast(activitiesDemo ? "You’re registered in this demo." : "You’re registered.");
        } else if (button.dataset.slot) await showBookingReview(button.dataset.slot);
        else if (button.dataset.confirmSlot) {
            button.disabled = true;
            const booking = button.dataset.bookingId
                ? await api.rescheduleBooking(button.dataset.bookingId, button.dataset.confirmSlot)
                : await api.bookSlot(button.dataset.confirmSlot);
            await render();
            openDialog(button.dataset.bookingId ? "Your session has been rescheduled." : "Your session is confirmed.",
                `<div class="confirmation-mark">${icon("check")}</div><p class="subtitle">${e(booking.psychologist)}<br>${e(dateLabel(booking.startsAt, { weekday: "long" }))} · ${e(timeLabel(booking.startsAt))} Lisbon time<br>${e(booking.format)} · ${booking.duration} minutes</p><div class="notice">${icon("lock")}<p>${booking.demo ? "This is a demo confirmation. No real appointment has been created." : "Your booking is private and is not shared with your manager or HR."}</p></div>`,
                `<button class="button secondary" data-calendar="${e(booking.id)}">${icon("download")}Add to calendar</button><button class="button" data-close-dialog>Done</button>`);
        } else if (button.dataset.reschedule) await showReschedule(button.dataset.reschedule);
        else if (button.dataset.reviewReschedule) await showBookingReview(document.querySelector("#new-slot").value, button.dataset.reviewReschedule);
        else if (button.dataset.cancelBooking) openDialog("Cancel this session?", `<p class="subtitle">Your session will be cancelled and the time will become available again. You can choose another session whenever you’re ready.</p>`, `<button class="button secondary" data-close-dialog>Keep my session</button><button class="button danger" data-confirm-cancel="${e(button.dataset.cancelBooking)}">Confirm cancellation</button>`);
        else if (button.dataset.confirmCancel) {
            button.disabled = true; await api.cancelBooking(button.dataset.confirmCancel); await render(); toast("Your session has been cancelled.");
        } else if (button.dataset.calendar) await exportCalendar(button.dataset.calendar);
        else if (button.hasAttribute("data-demo-video")) toast("Demo preview only. No live video room or actual appointment has been created.");
    } catch (error) {
        const target = dialog.open ? document.querySelector("#dialog-error") : null;
        if (target) { target.textContent = error.message; target.hidden = false; }
        else toast(error.message);
    } finally { if (button.isConnected) button.disabled = false; }
});
window.addEventListener("hashchange", render);
document.querySelector("#today-label").textContent = dateLabel(new Date().toISOString(), { weekday: "short", year: "numeric" });
document.querySelectorAll("[data-icon]").forEach((item) => { item.innerHTML = icon(item.dataset.icon); });
function setPrototypeRole(role) {
    state.role = role; state.employee = null;
    state.reportingData = null; state.reportingAccessError = false; state.reportMetric = "wellbeing"; state.reportScope = null;
    activityFilters = {}; hrActivityPrefill = {}; actionMonth = "";
    // Do not touch teampulse.employee-demo.v1: check-ins/bookings survive entry changes.
    if (["demo", "postgres"].includes(source)) { try { sessionStorage.setItem(ACCESS_KEY, role ?? ""); } catch { /* In-memory prototype navigation remains available. */ } }
}
function setWorkspaceVisible(visible) {
    const access = document.querySelector("#prototype-access"); if (access) access.hidden = visible;
    for (const selector of [".sidebar", ".workspace"]) { const node = document.querySelector(selector); if (node) node.hidden = !visible; }
    document.body?.classList.toggle("auth-mode", !visible);
    const skip = document.querySelector(".skip-link"); if (skip) skip.setAttribute("href", visible ? "#main-content" : "#prototype-content");
    const role = document.querySelector("#role-badge"); if (role) role.innerHTML = `${icon("people")}<span>${roleNames[state.role] ?? "Employee"}</span>`;
    const privacyLabel = document.querySelector("#privacy-label"); if (privacyLabel) privacyLabel.textContent = state.role === "employee" ? "Anonymous space" : "Aggregated view";
    const notice = document.querySelector(".demo-notice");
    if (notice) {
        // Retain the approved footer's layout while accurately identifying which
        // data now persists on the server. No styling or check-in copy changes.
        notice.hidden = !["demo", "postgres"].includes(source);
        if (source === "postgres") notice.textContent = state.role === "employee" ? "MVP demo · Check-ins, activities and private appointments saved in PostgreSQL."
            : "Prototype · Aggregated data only; unavailable insights stay hidden.";
    }
    const brand = document.querySelector(".brand"); if (brand) brand.setAttribute("href", state.role === "manager" ? "#manager" : state.role === "hr" ? "#organization" : "#home");
}
function updateDemoControls() {
    document.querySelectorAll('#prototype-form input, #prototype-form button[type="submit"]').forEach((node) => {
        node.disabled = !demoAccessEnabled || accessSubmitting;
    });
}
function showAccess(message = demoAccessMessage) {
    setWorkspaceVisible(false); main.innerHTML = "";
    document.querySelector("#employee-nav").innerHTML = "";
    document.title = "Demo Access · TeamPulse";
    const error = document.querySelector("#access-error"); if (error) { error.textContent = message; error.hidden = !message; }
    updateDemoControls();
}
document.querySelector("#prototype-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!demoAccessEnabled || accessSubmitting) return;
    const role = event.currentTarget.querySelector('input[name="role"]:checked')?.value;
    if (!Object.hasOwn(roleNames, role)) return;
    if (source === "http" && role !== "employee") { showAccess("Manager and People prototype access requires demo mode. Browser role selection cannot grant API access."); return; }
    accessSubmitting = true; updateDemoControls();
    try {
        if (role === "employee") await api.startPrototypeSession?.();
        else { await api.endPrototypeSession?.(); await reportingApi.startSession(role); }
        // Only enter a role space after the backend has created its session.
        setPrototypeRole(role);
        location.hash = role === "employee" ? "#home" : role === "manager" ? "#manager" : "#organization";
        await render();
    } catch (error) { setPrototypeRole(null); showAccess(error.message); }
    finally { accessSubmitting = false; updateDemoControls(); }
});
async function start() {
    if (source === "postgres") {
        try {
            demoAccessEnabled = (await api.getDemoAccess()).enabled;
            if (!demoAccessEnabled) demoAccessMessage = "Demo access is disabled on this deployment.";
        } catch (error) { demoAccessMessage = error.message; }
    }
    updateDemoControls();
    await render();
}
await start();

// Reuse the existing Lisbon calendar watcher for Friday opening, Monday cohort
// rollover and monthly history. The backend remains authoritative for eligibility.
// No API calls occur until the Lisbon date changes.
let displayedDay = lisbonDateKey();
const calendarWatcher = setInterval(() => {
    const day = lisbonDateKey();
    if (day !== displayedDay) { displayedDay = day; if (state.role === "employee" && ["home", "history", "check-in"].includes(activeRoute())) render(); }
}, 1000);
calendarWatcher.unref?.();

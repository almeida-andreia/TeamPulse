import { escapeHtml as e, dateLabel } from "./ui.mjs";

// Context is dated independently of score availability. Never position an event
// at a score value or infer that it caused a wellbeing change.
export function evolutionEvents(weeks, events = []) {
    return events.flatMap((event) => {
        const index = weeks.findIndex((week) => week.weekStart === event.weekStart);
        return index < 0 ? [] : [{ ...event, index }];
    });
}
export function eventMarkers(weeks, events) {
    const grouped = new Map();
    for (const event of evolutionEvents(weeks, events)) {
        if (!grouped.has(event.index)) grouped.set(event.index, []);
        grouped.get(event.index).push(event);
    }
    return [...grouped].map(([index, items]) => {
        const x = 38 + index * 640 / Math.max(weeks.length - 1, 1);
        const label = items.map((event) => `${event.date}: ${event.title}`).join("; ");
        return `<g class="report-event-marker" tabindex="0" role="img" aria-label="${e(label)}" data-event-week="${e(items[0].weekStart)}"><title>${e(label)}</title><path d="M ${x} 213 l 5 5 l -5 5 l -5 -5 Z" fill="#257b78" stroke="white" stroke-width="1.5"/></g>`;
    }).join("");
}
export function eventContext(team) {
    const events = evolutionEvents(team.weeks ?? [], team.events);
    return `<div class="report-event-context"><div class="report-event-heading"><h3>Team events</h3>${team.teamId ? `<button type="button" class="button ghost" data-event-create="${e(team.teamId)}">Add team event</button>` : ""}</div>${events.length
        ? `<ul class="report-event-list">${events.map((event) => `<li><span class="report-event-dot" aria-hidden="true">◆</span><div><strong>${e(event.title)}</strong><span>${e(dateLabel(event.date, { year: "numeric" }))} · Week of ${e(dateLabel(event.weekStart))}</span></div></li>`).join("")}</ul>`
        : '<p class="field-help">No team events in these eight completed weeks.</p>'}<p class="field-help">Team context only. Events do not change scores or explain individual experiences.</p></div>`;
}
export function renderEventForm(team) {
    return `<form id="team-event-form" class="action-form"><p class="field-help">${e(team.name)} · Add team context, without employee names or individual wellbeing information. Events appear when their week is in the completed eight-week view.</p><label>Event title<input name="title" maxlength="160" required autocomplete="off"></label><label>Event date<input type="date" name="date" required></label><p class="form-error" id="team-event-error" role="alert" hidden></p><div class="button-row"><button type="button" class="button secondary" data-close-dialog>Cancel</button><button type="submit" class="button">Save event</button></div></form>`;
}
export function createEventsApi(source) {
    return { async create(input) {
        if (source !== "postgres") throw new Error("Team events require PostgreSQL access.");
        const response = await fetch("/api/manager/events", { method: "POST", credentials: "same-origin", cache: "no-store",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
        const body = await response.json();
        if (!response.ok) throw new Error([400, 403, 409].includes(response.status) ? body.error : "Team event could not be saved. Please try again.");
        return body;
    } };
}

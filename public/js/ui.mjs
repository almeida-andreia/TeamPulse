export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const paths = {
    building: '<path d="M4 21V3h12v18M16 9h4v12M7 7h6M7 11h6M7 15h3m1 6v-5h3"/>',
    sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
    chart: '<path d="M4 3v17h17M7 14l4-4 4 3 6-7"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m2 10v-3a6 6 0 0 0-2-4"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8zm-9 10 9 5 9-5M3 18l9 5 9-5"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/>',
    message: '<path d="M21 11a8 8 0 0 1-8 8H8l-5 3V11a9 9 0 0 1 18 0zM7 10h10m-10 4h7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-4v12l-6-4"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0z"/><circle cx="12" cy="10" r="2.5"/>',
    leaf: '<path d="M20 3C9 2 3 7 5 14c3 7 15 5 15-11zM4 21 16 8"/>'
};
export function icon(name, className = "") { return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.pulse}</svg>`; }
export function dateLabel(value, options = {}) { return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", day: "numeric", month: "short", ...options }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value)); }
export function timeLabel(value) { return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
// Activity timestamps use the displayed Lisbon month; date-only action targets
// already describe a calendar date and must not shift with the browser timezone.
export function monthKey(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.slice(0, 7);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit" }).formatToParts(new Date(value));
    return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
}
export function monthFilterOptions(dates, selected = "") {
    return '<option value="">All months</option>' + [...new Set(dates.map(monthKey))].sort().reverse().map((month) =>
        `<option value="${month}"${selected === month ? " selected" : ""}>${dateLabel(`${month}-15`, { day: undefined, month: "long", year: "numeric" })}</option>`).join("");
}
function renderEventReminder(a, kind, title) {
    return `<article class="registration-card${kind === "appointment" ? " appointment-reminder" : ""}" data-${kind}-notice="${escapeHtml(a.id)}">
            <time class="registration-calendar" datetime="${escapeHtml(a.startsAt)}"><span class="sr-only">${escapeHtml(dateLabel(a.startsAt, { year: "numeric" }))}</span><span class="registration-calendar-month" aria-hidden="true">${escapeHtml(dateLabel(a.startsAt, { day: undefined, month: "short" }).toUpperCase())}</span><span class="registration-calendar-day" aria-hidden="true">${escapeHtml(dateLabel(a.startsAt, { day: "numeric", month: undefined }))}</span></time>
            <div class="registration-copy"><p class="registration-title${kind === "appointment" ? " appointment-title" : ""}">${kind === "appointment" ? icon("heart") : ""}<span>${escapeHtml(title)}</span></p><div class="registration-meta"><span>${icon("clock")}<span>${escapeHtml(timeLabel(a.startsAt))} (Lisbon time)</span></span><span class="registration-mode"><span class="registration-separator" aria-hidden="true">·</span>${icon(a.format === "Online" ? "video" : "pin")}<span>${escapeHtml(a.format)}${a.location ? ` · ${escapeHtml(a.location)}` : ""}</span></span></div><button type="button" class="reminder-action" data-${kind === "appointment" ? "appointment" : "activity"}="${escapeHtml(a.id)}" aria-label="${escapeHtml(kind === "appointment" ? `Manage appointment on ${dateLabel(a.startsAt, { year: "numeric" })}` : `Manage registration for ${a.title}`)}">Manage ${kind === "appointment" ? "appointment" : "registration"}${icon("arrow")}</button></div>
        </article>`;
}
export function renderRegistrationNotices(activities, now = Date.now()) {
    const upcoming = activities.filter((a) => a.registered && a.registrationOpen && a.status === "upcoming" && Date.parse(a.startsAt) > now);
    return upcoming.length ? `<section class="registration-notices" aria-label="Your upcoming registrations">${upcoming.map((a) =>
        renderEventReminder(a, "registration", `You're registered for ${a.title}.`)).join("")}</section>` : "";
}
export function renderAppointmentNotices(appointments, now = Date.now()) {
    const upcoming = appointments.filter((a) => a.status === "booked" && Date.parse(a.startsAt) > now)
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    if (!upcoming.length) return "";
    // Reuse the compact calendar component; no clinician identity, booking
    // reason or video link belongs in the Home reminder.
    return `<section class="registration-notices" aria-label="Your upcoming psychologist appointments">${upcoming.map((a) =>
        renderEventReminder(a, "appointment", `Upcoming psychologist appointment${a.demo ? " · Demo" : ""}`)).join("")}</section>`;
}

export function renderHomeReminders(status, activities, appointments = []) {
    const weekly = `<section class="weekly-hero"><span class="weekly-icon">${icon(status.submitted ? "check" : "leaf")}</span><p class="eyebrow">THIS WEEK</p><h2>${status.submitted ? "Thank you for checking in" : "Weekly Check-in"}</h2><p>${status.submitted ? "Your check-in is complete. Your personal history stays private." : status.available === false ? `Your weekly check-in opens on ${escapeHtml(dateLabel(status.opensOn, { weekday: "long" }))}.` : "Take 1–2 minutes to reflect on your current work experience."}</p><div class="weekly-footer"><span>${icon("clock")}${status.submitted ? "Completed this week" : "Estimated time: 2 min"}</span>${status.available === false && !status.submitted ? `<span class="tag">Opens Friday</span>` : `<a class="button" href="${status.submitted ? "#history" : "#check-in"}">${icon("arrow")}${status.submitted ? "View my wellbeing" : "Start Check-in"}</a>`}</div></section>`;
    const available = !status.submitted && status.available !== false;
    return (available ? weekly : "") + renderAppointmentNotices(appointments) + renderRegistrationNotices(activities) + (available ? "" : weekly);
}
export function changeLabel(value) { return value == null ? "Not enough monthly history" : `${value > 0 ? "+" : ""}${value.toFixed(1)} vs last month`; }
export const activityStatusLabel = (status) => ({ draft: "Draft", upcoming: "Upcoming", in_progress: "In progress", completed: "Completed" })[status] ?? "Demo activity";
export const activityRegistrationLabel = (open) => open ? "Registration open" : "Registration closed";
// Presentation only: preserve the supplied delta and its metric's direction.
// The arrow shows movement; color and the accessible label show favorability.
export function renderChange(value, direction, { comparison = "vs last month", unavailable = "Not enough monthly history" } = {}) {
    if (!Number.isFinite(value)) return `<span class="change-context">${escapeHtml(unavailable)}</span>`;
    const known = ["higher_is_better", "higher_is_worse"].includes(direction);
    const improved = direction === "higher_is_worse" ? value < 0 : value > 0;
    const tone = value === 0 || !known ? "neutral" : improved ? "positive" : "negative";
    const label = value === 0 ? "Unchanged" : !known ? "Changed" : improved ? "Improved" : "Worsened";
    const arrow = value === 0 ? "→" : value > 0 ? "↑" : "↓";
    const title = value === 0 ? "Unchanged: 0.0 points" : `${label}: ${value > 0 ? "increased" : "decreased"} by ${Math.abs(value).toFixed(1)} points`;
    return `<span class="change-indicator change-indicator--${tone}" title="${escapeHtml(title)}"><span class="sr-only">${label}: </span><span class="change-symbol" aria-hidden="true">${arrow}</span><span>${value > 0 ? "+" : ""}${value.toFixed(1)}</span></span><span class="change-context"> ${escapeHtml(comparison)}</span>`;
}
export function sparkline(entries) {
    const points = entries.map((entry, i) => `${i * 200 / Math.max(entries.length - 1, 1)},${58 - entry.wellbeing * 5}`).join(" ");
    return `<svg class="sparkline" viewBox="0 0 200 70" aria-hidden="true"><path d="M0 60h200" stroke="#e5ebf4"/><polyline points="${points}" fill="none" stroke="#638eff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
export function downloadFile(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a"); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

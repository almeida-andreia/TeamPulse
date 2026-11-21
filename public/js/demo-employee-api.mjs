// Fictional Employee-only fixtures. No database, requests, or Manager/HR data.
// Tab storage is a DEMO convenience, never production authentication/persistence.
import { normalizeCheckin, SCORE_FIELDS as SCORES } from "./checkin.mjs";
import { monthlyCompletion } from "./wellbeing.mjs";
const STORE = "teampulse.employee-demo.v1";
export function lisbonDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(key, days) {
    const date = new Date(`${key}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
export function weekKey(date = new Date()) {
    const key = lisbonDateKey(date);
    return addDays(key, -(new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7);
}
const problem = (message, status = 400) => Object.assign(new Error(message), { status });
const copy = (value) => JSON.parse(JSON.stringify(value));
const nextId = () => globalThis.crypto?.randomUUID?.() ?? `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function createDemoEmployeeApi({ storage, now = () => new Date() } = {}) {
    if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
    let state = { version: 1, checkins: [], registrations: [], bookings: [] };
    try {
        const saved = JSON.parse(storage?.getItem(STORE) ?? "null");
        if (saved?.version === 1 && [saved.checkins, saved.registrations, saved.bookings].every(Array.isArray)) state = saved;
    } catch { /* Unavailable/old browser storage starts a fresh preview. */ }
    function persist() {
        try { storage?.setItem(STORE, JSON.stringify(state)); }
        catch { /* Keep the preview usable in memory when storage is disabled. */ }
    }
    function checkinStatus() {
        const date = now(), today = lisbonDateKey(date), weekStart = weekKey(date);
        const nextWeek = addDays(weekStart, 7), opensOn = addDays(weekStart, 4);
        const submitted = state.checkins.some((entry) => entry.weekStart === weekStart);
        // Match the persisted flow's Lisbon cohort/window, never elapsed time
        // since the previous response. This does not restrict a fifth week.
        return { weekStart, nextWeek, opensOn, nextOpensOn: addDays(nextWeek, 4), submitted,
            available: !submitted && today >= opensOn && today < nextWeek };
    }
    function allHistory() {
        const wellbeing = [6.6, 6.8, 6.5, 7.1, 7.0, 7.4, 7.2, 7.6];
        const workload = [7.2, 6.8, 7.3, 6.6, 6.7, 6.1, 6.5, 5.8];
        const entries = wellbeing.map((score, i) => ({ weekStart: addDays(weekKey(now()), (i - 8) * 7),
            wellbeing: score, workload: workload[i], teamIntegration: [6.8, 7, 6.7, 7.2, 7.3, 7.5, 7.4, 7.8][i],
            psychologicalSafety: [7, 7.2, 7, 7.4, 7.4, 7.6, 7.5, 8][i], stress: null }));
        const byWeek = new Map(entries.map((entry) => [entry.weekStart, entry]));
        state.checkins.forEach((entry) => byWeek.set(entry.weekStart, entry));
        return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    }
    function history(period) {
        if (!["30days", "quarter", "year"].includes(period)) throw problem("Please choose a supported period.");
        const today = lisbonDateKey(now()), year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
        const start = period === "quarter" ? `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`
            : period === "year" ? `${year}-01-01` : addDays(today, -29);
        const all = allHistory(), last = all.at(-1);
        const priorDate = new Date(`${last.weekStart.slice(0, 7)}-01T12:00:00Z`);
        priorDate.setUTCMonth(priorDate.getUTCMonth() - 1);
        const prior = all.filter((entry) => entry.weekStart.startsWith(priorDate.toISOString().slice(0, 7)));
        const current = all.filter((entry) => entry.weekStart.startsWith(last.weekStart.slice(0, 7)));
        // Legacy history is not re-normalized or backfilled. Missing stress is
        // unavailable, never zero; each metric uses only its answered records.
        const average = (entries, key) => {
            const values = entries.map((entry) => entry[key]).filter(Number.isFinite);
            return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        };
        const monthlyChange = Object.fromEntries(SCORES.map((key) => {
            const before = average(prior, key), after = average(current, key);
            return [key, before === null || after === null ? null : after - before];
        }));
        // The history DTO excludes free text and challenge selections.
        const select = (entry) => Object.fromEntries(["weekStart", ...SCORES].map((key) => [key, entry[key] ?? null]));
        return { entries: all.filter((entry) => entry.weekStart >= start && entry.weekStart <= today).map(select), latest: select(last), monthlyChange,
            // Count recorded tab submissions, never the illustrative trend fixtures.
            monthlyCompletion: monthlyCompletion(state.checkins, today) };
    }
    function activities() {
        const start = weekKey(now());
        return [
            { key: "sustainable-workday", title: "A more balanced workday", description: "Practical ways to make space for focused work, useful breaks, and realistic priorities.", type: "Workshop", days: 8, duration: 60, format: "Online", audience: "All employees", featured: true, recommended: true, art: "balance" },
            { key: "team-connection", title: "Good conversations, stronger connections", description: "An informal, facilitated space to meet colleagues and explore what helps a team feel connected.", type: "Group activity", days: 10, duration: 45, format: "In person", audience: "All employees", featured: true, recommended: false, art: "connection" },
            { key: "clear-priorities", title: "Make room for what matters", description: "Simple ways to clarify expectations, share priorities, and ask for support at work.", type: "Workshop", days: 15, duration: 75, format: "Online", audience: "Delivery teams", featured: false, recommended: true, art: "focus" }
        ].map(({ key, days, ...activity }) => {
            const id = `${key}-${addDays(start, days)}`;
            return { ...activity, id, startsAt: `${addDays(start, days)}T14:00:00Z`, registered: state.registrations.includes(id) };
        });
    }
    function slots() {
        return Array.from({ length: 6 }, (_, i) => {
            const date = addDays(weekKey(now()), i + 7), id = `slot-${date}-${i + 1}`;
            return { id, psychologist: i < 3 ? "Dr. Maria Barros" : "Dr. Rui Matos",
                startsAt: `${date}T${i % 2 ? "14" : "10"}:00:00Z`, duration: 50,
                format: i % 3 === 2 ? "In person" : "Online", location: i % 3 === 2 ? "Private consultation room A" : null,
                available: !state.bookings.some((booking) => booking.slotId === id && booking.status === "booked") };
        });
    }
    function bookingDetails(booking) {
        return { ...booking, canChange: booking.status === "booked" && new Date(booking.startsAt).getTime() - now().getTime() >= 7200000 };
    }
    function resolveSlot(id) {
        const slot = slots().find((item) => item.id === id);
        if (!slot?.available) throw problem("That session is no longer available. Please choose another.", 409);
        return slot;
    }
    return {
        async getEmployee() { return { firstName: "Ana", displayName: "Ana Silva", role: "employee" }; },
        async getCheckinStatus() { return checkinStatus(); },
        async submitCheckin(answers) {
            const status = checkinStatus(), weekStart = status.weekStart;
            if (status.submitted) throw problem("You’ve already checked in this week. Thank you.", 409);
            if (!status.available) throw problem("Your weekly check-in opens on Friday. Please come back then.", 409);
            const normalized = normalizeCheckin(answers);
            state.checkins.push({ weekStart, ...normalized });
            persist(); return { weekStart };
        },
        async getHistory(period = "30days") { return copy(history(period)); },
        async getActivities() { return copy(activities()); },
        async registerActivity(id) {
            if (!activities().some((item) => item.id === id)) throw problem("This activity is unavailable.", 404);
            if (!state.registrations.includes(id)) { state.registrations.push(id); persist(); }
            return { activityId: id, registered: true };
        },
        async getSlots() { return copy(slots()); },
        async getBookings() { return copy(state.bookings.map(bookingDetails)); },
        // Home appointment reminders have one source of truth: authenticated
        // PostgreSQL appointments. Tab-only demo bookings never feed this feature.
        async getAppointmentReminders() { return []; },
        async bookSlot(slotId) {
            const slot = resolveSlot(slotId);
            const booking = { id: nextId(), slotId, psychologist: slot.psychologist, startsAt: slot.startsAt, duration: slot.duration, format: slot.format, location: slot.location, videoUrl: null, status: "booked", demo: true };
            state.bookings.push(booking); persist(); return copy(bookingDetails(booking));
        },
        async rescheduleBooking(id, slotId) {
            const booking = state.bookings.find((item) => item.id === id);
            if (!booking || !bookingDetails(booking).canChange) throw problem("Sessions can only be changed up to two hours before their start.");
            const slot = resolveSlot(slotId);
            Object.assign(booking, { slotId, psychologist: slot.psychologist, startsAt: slot.startsAt, duration: slot.duration, format: slot.format, location: slot.location });
            persist(); return copy(bookingDetails(booking));
        },
        async cancelBooking(id) {
            const booking = state.bookings.find((item) => item.id === id);
            if (!booking || !bookingDetails(booking).canChange) throw problem("Sessions can only be cancelled up to two hours before their start.");
            booking.status = "cancelled"; persist(); return copy(bookingDetails(booking));
        }
    };
}

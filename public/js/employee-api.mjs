import { createDemoEmployeeApi } from "./demo-employee-api.mjs";
import { createCheckinPayload } from "./checkin.mjs";

// Views depend on async Employee DTOs, not Express or demo storage. The server
// authenticates ownership, validates all writes and enforces privacy.
// HTTP errors NEVER silently fall back to demo data or pretend a write succeeded.
export class ApiError extends Error {
    constructor(message, status = 0) { super(message); this.status = status; }
}
export function createHttpEmployeeApi(base = "/api/employee") {
    async function request(path, method = "GET", body) {
        let response;
        try {
            response = await fetch(`${base}${path}`, {
                method, credentials: "same-origin", cache: "no-store",
                headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) })
            });
        } catch { throw new ApiError("We couldn’t reach the service. Please try again."); }
        if (!response.ok) throw new ApiError(response.status === 401 ? "Please sign in again to continue."
            : response.status === 409 ? "This has already been submitted or is no longer available."
                : "We couldn’t complete that request. Please try again.", response.status);
        if (response.status === 204) return null;
        try { return await response.json(); }
        catch { throw new ApiError("The service returned an unexpected response. Please try again."); }
    }
    return {
        getEmployee: () => request("/me"),
        getCheckinStatus: () => request("/check-ins/current"),
        // Send raw answer codes and 1..5 ratings only. The endpoint independently
        // validates/normalizes and resolves ownership server-side.
        submitCheckin: async (answers) => request("/check-ins", "POST", createCheckinPayload(answers)),
        getHistory: (period = "30days") => request(`/history?period=${encodeURIComponent(period)}`),
        getActivities: () => request("/activities"),
        getAppointmentReminders: () => request("/appointment-reminders"),
        registerActivity: (id) => request(`/activities/${encodeURIComponent(id)}/registrations`, "POST", {}),
        cancelActivityRegistration: (id) => request(`/activities/${encodeURIComponent(id)}/registrations`, "DELETE", {}),
        getAppointmentSlots: () => request("/appointment-slots"),
        rescheduleAppointment: (id, slotId) => request(`/appointments/${encodeURIComponent(id)}`, "PATCH", { slotId }),
        cancelAppointment: (id) => request(`/appointments/${encodeURIComponent(id)}`, "DELETE", {}),
        getSlots: () => request("/psychologist-slots"),
        getBookings: () => request("/bookings"),
        bookSlot: (slotId) => request("/bookings", "POST", { slotId }),
        rescheduleBooking: (id, slotId) => request(`/bookings/${encodeURIComponent(id)}`, "PATCH", { slotId }),
        cancelBooking: (id) => request(`/bookings/${encodeURIComponent(id)}`, "DELETE")
    };
}
export function createEmployeeApi(source = "demo") {
    if (source === "demo") return createDemoEmployeeApi();
    if (source === "http") return createHttpEmployeeApi();
    if (source === "postgres") {
        const http = createHttpEmployeeApi();
        async function session(method) {
            let response;
            try {
                response = await fetch("/api/prototype/employee-session", {
                    method, credentials: "same-origin", cache: "no-store",
                    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {})
                });
            } catch { throw new ApiError("We couldn’t reach the service. Please try again."); }
            if (!response.ok) {
                let code;
                try { code = (await response.json()).code; } catch { /* Keep unknown service errors generic. */ }
                // Whitelist this safe configuration code; never show raw SQL,
                // connection details, or arbitrary server messages in the UI.
                throw new ApiError(code === "DEMO_AUTH_DISABLED" ? "Demo access is disabled on this deployment."
                    : code === "DATABASE_NOT_CONFIGURED" ? "Demo access requires a configured PostgreSQL connection."
                    : "Employee demo access is unavailable. Please try again.", response.status);
            }
        }
        // Every persisted Employee flow uses the authenticated PostgreSQL API.
        return { ...http, getEmployee: http.getEmployee, getCheckinStatus: http.getCheckinStatus,
            submitCheckin: http.submitCheckin, getHistory: http.getHistory,
            getActivities: http.getActivities, registerActivity: http.registerActivity,
            getAppointmentReminders: http.getAppointmentReminders,
            cancelActivityRegistration: http.cancelActivityRegistration, getAppointmentSlots: http.getAppointmentSlots,
            rescheduleAppointment: http.rescheduleAppointment, cancelAppointment: http.cancelAppointment,
            async getDemoAccess() {
                try {
                    const response = await fetch("/api/demo-access", { credentials: "same-origin", cache: "no-store" });
                    if (!response.ok) throw new Error();
                    return { enabled: (await response.json()).enabled === true };
                } catch { throw new ApiError("Demo access is unavailable. Please try again."); }
            },
            startPrototypeSession: () => session("POST"), endPrototypeSession: () => session("DELETE") };
    }
    throw new Error("Unknown Employee data source.");
}

const express = require("express");
const session = require("express-session");
const { randomBytes } = require("node:crypto");
const { createEmployeeCheckins } = require("./employee-checkins");
const { createReporting } = require("./reporting");
const { createTeamActions } = require("./team-actions");
const { createHrActivities } = require("./hr-activities");
const { createEmployeeAppointments } = require("./employee-appointments");
const { createActivitySupport } = require("./activity-support");
const { createTeamEvents } = require("./team-events");
const { readApplicationConfig } = require("./config");

function installEmployeeRoutes(app, { getPool = () => require("./db").pool,
    sessionSecret, sessionStore, prototypeAccess, demoAuthEnabled,
    minimumResponses = () => process.env.MIN_RESPONSES } = {}) {
    const config = readApplicationConfig();
    sessionSecret ??= config.sessionSecret;
    // An injected legacy prototype option keeps its local-only meaning.
    demoAuthEnabled ??= prototypeAccess === undefined ? config.demoAuthEnabled : false;
    prototypeAccess ??= config.prototypeAccess;
    if (config.mode === "production") {
        if (!(typeof sessionSecret === "string" && sessionSecret.length >= 32))
            throw Object.assign(new Error("Production requires SESSION_SECRET with at least 32 characters, generated from secure random bytes."), { code: "CONFIGURATION_INVALID" });
        if (!demoAuthEnabled && (!sessionStore || sessionStore instanceof session.MemoryStore))
            throw Object.assign(new Error("Production requires a persistent sessionStore integration; the local MemoryStore is development-only."), { code: "CONFIGURATION_INVALID" });
    }
    sessionSecret ||= randomBytes(32).toString("hex");
    const service = createEmployeeCheckins(getPool);
    const reporting = createReporting(getPool, { minimumResponses });
    const actions = createTeamActions(getPool, { minimumResponses });
    const hrActivities = createHrActivities(getPool, { minimumResponses });
    const activitySupport = createActivitySupport(getPool);
    const appointments = createEmployeeAppointments(getPool);
    const events = createTeamEvents(getPool);
    // MemoryStore is allowed only for development or the explicitly enabled,
    // single-process fictional demo. Restarting it requires signing in again.
    // Real production authentication still requires a persistent store.
    app.use("/api", session({
        name: "teampulse.sid", secret: sessionSecret, resave: false, saveUninitialized: false,
        ...(sessionStore ? { store: sessionStore } : {}),
        cookie: { httpOnly: true, sameSite: "strict", secure: config.mode === "production", maxAge: 8 * 60 * 60 * 1000 }
    }));
    app.use("/api", (req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
            // Same-origin writes only. Do not trust forwarded host/IP headers.
            if (req.get("Sec-Fetch-Site") === "cross-site") return res.status(403).json({ error: "This request is not permitted." });
            if (req.get("Origin")) {
                let origin;
                try { origin = new URL(req.get("Origin")); } catch { return res.status(403).json({ error: "This request is not permitted." }); }
                if (origin.host !== req.get("host") || origin.protocol !== `${req.protocol}:`)
                    return res.status(403).json({ error: "This request is not permitted." });
            }
            if (!req.is("application/json") && req.method !== "DELETE")
                return res.status(415).json({ error: "Please send JSON answers." });
        }
        next();
    });
    const demoAvailable = (req) => {
        // An external academic demo must be explicitly enabled. Production
        // requires HTTPS, recognized only directly or via an explicitly trusted proxy.
        if (demoAuthEnabled) return config.mode !== "production" || req.secure;
        const address = req.socket.remoteAddress;
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
        const host = req.hostname;
        return prototypeAccess && config.mode !== "production" && local
            && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
    };
    app.get("/api/demo-access", (req, res) => res.json({ enabled: demoAvailable(req) }));
    const requireDemoAccess = (req, res, next) => {
        if (!demoAvailable(req)) return res.status(403).json({ code: "DEMO_AUTH_DISABLED", error: "Demo access is disabled on this deployment." });
        next();
    };
    const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    const save = (req) => new Promise((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    const destroy = (req) => new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
    // Retain the existing session URLs/contracts; this is a demo authentication
    // boundary, never an SSO callback or an authorization override.
    app.post("/api/prototype/employee-session", requireDemoAccess, async (req, res) => {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)
            return res.status(400).json({ error: "Unexpected access fields." });
        const userId = await service.prototypeEmployee();
        await regenerate(req); // prevent session fixation
        req.session.employeeId = userId;
        await save(req);
        res.status(204).end();
    });
    for (const role of ["manager", "hr"]) {
        app.post(`/api/prototype/${role}-session`, requireDemoAccess, async (req, res) => {
            if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)
                return res.status(400).json({ error: "Unexpected access fields." });
            // Browser role selection only chooses a fixed fictional demo account.
            // Its actual role/active status must match PostgreSQL; no DB means no
            // reporting session and no authorization. Remote entry is explicit opt-in.
            const id = await reporting.prototypeAccount(role);
            await regenerate(req); req.session.userId = id; await save(req);
            res.status(204).end();
        });
    }
    app.delete("/api/prototype/employee-session", async (req, res) => {
        await destroy(req);
        res.clearCookie("teampulse.sid", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production" });
        res.status(204).end();
    });
    const router = express.Router();
    router.use(async (req, res, next) => {
        const id = req.session.userId ?? req.session.employeeId;
        if (!id) return res.status(401).json({ error: "Please sign in again to continue." });
        // Role and active status are read from PostgreSQL on EVERY request.
        // Browser role selectors, headers and user_id parameters grant no access.
        req.employee = await service.employee(id);
        next();
    });
    router.get("/me", (req, res) => res.json({
        displayName: req.employee.display_name, firstName: req.employee.display_name.split(" ")[0], role: "employee"
    }));
    router.get("/check-ins/current", async (req, res) => res.json(await service.status(req.employee.user_id)));
    router.post("/check-ins", async (req, res) => res.status(201).json(await service.submit(req.employee.user_id, req.body)));
    router.get("/history", async (req, res) => {
        // Reject identity filters rather than suggesting arbitrary history is supported.
        if (Object.keys(req.query).some((key) => key !== "period")) return res.status(400).json({ error: "Unsupported history filter." });
        res.json(await service.history(req.employee.user_id, req.query.period));
    });
    router.get("/activities", async (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Activity filters are not supported." });
        res.json(await activitySupport.list(req.employee.user_id));
    });
    router.get("/appointment-reminders", async (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Appointment filters are not supported." });
        res.json(await appointments.upcoming(req.employee.user_id));
    });
    router.post("/activities/:id/registrations", async (req, res) => res.json(await activitySupport.register(req.employee.user_id, req.params.id, req.body)));
    router.delete("/activities/:id/registrations", async (req, res) => res.json(await activitySupport.cancel(req.employee.user_id, req.params.id, req.body)));
    router.get("/appointment-slots", async (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Slot filters are not supported." });
        res.json(await appointments.slots());
    });
    router.patch("/appointments/:id", async (req, res) => res.json(await appointments.reschedule(req.employee.user_id, req.params.id, req.body)));
    router.delete("/appointments/:id", async (req, res) => res.json(await appointments.cancel(req.employee.user_id, req.params.id, req.body)));
    router.get("/psychologist-slots", async (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Slot filters are not supported." });
        res.json(await appointments.sessions());
    });
    router.get("/bookings", async (req, res) => {
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Booking filters are not supported." });
        res.json(await appointments.bookings(req.employee.user_id));
    });
    router.post("/bookings", async (req, res) => res.status(201).json(await appointments.book(req.employee.user_id, req.body)));
    router.patch("/bookings/:id", async (req, res) => {
        await appointments.reschedule(req.employee.user_id, req.params.id, req.body);
        res.json((await appointments.bookings(req.employee.user_id)).find((b) => b.id === req.params.id));
    });
    router.delete("/bookings/:id", async (req, res) => res.json(await appointments.cancel(req.employee.user_id, req.params.id, req.body ?? {})));
    app.use("/api/employee", router);
    for (const role of ["manager", "hr"]) {
        app.get(`/api/${role}/overview`, async (req, res) => {
            const id = req.session.userId ?? req.session.employeeId;
            if (!id) return res.status(401).json({ error: "Please sign in again to continue." });
            const user = await service.account(id);
            if (user.role !== role) return res.status(403).json({ error: "This reporting space is not available to your role." });
            if (Object.keys(req.query).length) return res.status(400).json({ error: "Reporting filters are not supported." });
            const result = await reporting.overview(role, user.user_id);
            if (role === "manager") {
                const context = await events.list(user.user_id);
                result.teams = result.teams.map((team) => ({ ...team,
                    events: context.filter((event) => event.teamId === team.teamId
                        && team.weeks?.some((week) => week.weekStart === event.weekStart)) }));
            }
            res.json(result);
        });
    }
    const eventsRouter = express.Router();
    eventsRouter.use(async (req, res, next) => {
        const id = req.session.userId ?? req.session.employeeId;
        if (!id) return res.status(401).json({ error: "Please sign in again to continue." });
        const user = await service.account(id);
        if (user.role !== "manager") return res.status(403).json({ error: "Team events are available only to Managers." });
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Team event filters are not supported." });
        req.managerId = user.user_id; next();
    });
    eventsRouter.get("/", async (req, res) => res.json(await events.list(req.managerId)));
    eventsRouter.post("/", async (req, res) => res.status(201).json(await events.create(req.managerId, req.body)));
    app.use("/api/manager/events", eventsRouter);
    const actionsRouter = express.Router();
    actionsRouter.use(async (req, res, next) => {
        const id = req.session.userId ?? req.session.employeeId;
        if (!id) return res.status(401).json({ error: "Please sign in again to continue." });
        const user = await service.account(id);
        if (user.role !== "manager") return res.status(403).json({ error: "Action plans are available only to Managers." });
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Action plan filters are not supported." });
        req.managerId = user.user_id; next();
    });
    actionsRouter.get("/", async (req, res) => res.json(await actions.list(req.managerId)));
    actionsRouter.post("/", async (req, res) => res.status(201).json(await actions.create(req.managerId, req.body)));
    actionsRouter.patch("/:id/status", async (req, res) => res.json(await actions.updateStatus(req.managerId, req.params.id, req.body)));
    app.use("/api/manager/actions", actionsRouter);
    const activitiesRouter = express.Router();
    activitiesRouter.use(async (req, res, next) => {
        const id = req.session.userId ?? req.session.employeeId;
        if (!id) return res.status(401).json({ error: "Please sign in again to continue." });
        const user = await service.account(id);
        if (user.role !== "hr") return res.status(403).json({ error: "Activity management is available only to HR." });
        if (Object.keys(req.query).length) return res.status(400).json({ error: "Activity API filters are not supported." });
        req.hrId = user.user_id; next();
    });
    activitiesRouter.get("/", async (req, res) => res.json(await hrActivities.list(req.hrId)));
    activitiesRouter.post("/", async (req, res) => res.status(201).json(await hrActivities.create(req.hrId, req.body)));
    activitiesRouter.put("/:id", async (req, res) => res.json(await hrActivities.update(req.hrId, req.params.id, req.body)));
    app.use("/api/hr/activities", activitiesRouter);
    app.use("/api", (req, res) => res.status(404).json({ error: "This service is unavailable." }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Please send valid JSON answers." });
        if (error.type === "entity.too.large") return res.status(413).json({ error: "This request is too large." });
        if (error.code === "DATABASE_NOT_CONFIGURED") return res.status(503).json({
            code: "DATABASE_NOT_CONFIGURED",
            error: "Local access requires a configured PostgreSQL connection."
        });
        // Only deliberate application errors can reach the caller. No raw SQL,
        // driver messages, stack traces, credentials or submitted answers are logged.
        if ([400, 401, 403, 404, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
        console.error("TeamPulse service request failed.");
        res.status(503).json({ error: "The TeamPulse service is unavailable. Please try again." });
    });
}
module.exports = { installEmployeeRoutes };

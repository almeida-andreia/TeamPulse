# TeamPulse architecture

This document describes the implemented academic MVP, not a proposed framework. Product behaviour is defined in [SPEC.md](../SPEC.md); operational setup is in [DEPLOYMENT.md](../DEPLOYMENT.md).

## Request path and actual modules

```text
Browser
  ↓ HTML / CSS / JavaScript (public/)
  ↓ same-origin JSON requests with session cookie
Express API (server/app.js, server/employee-routes.js)
  ↓ business modules / parameterized SQL (server/*.js)
  ↓ pg connection pool (server/db.js)
PostgreSQL (identity, private, wellbeing, operations)
```

The server serves only `public/`. There is no frontend framework/build step, ORM, separate repository layer or separate reporting server. Business modules contain their SQL; this diagram does not imply unimplemented controller/service/repository folders.

| File/module | Actual responsibility |
| --- | --- |
| `server/app.js` | Express composition, static files and health endpoints |
| `server/start.js` | Configuration validation, SELECT-only connection check, listener and graceful shutdown |
| `server/config.js`, `server/db.js` | Environment validation, optional verified database TLS and bounded connection pool |
| `server/employee-routes.js` | Session middleware, demo entry/logout, role checks and Employee/Manager/HR routes |
| `server/employee-checkins.js` | Active account lookup, Employee ownership, weekly eligibility/submission and history |
| `server/reporting.js` | Scoped SQL aggregates, completed-week calendar, release/suppression and aggregate DTOs |
| `server/team-actions.js` | Assigned Manager's general/insight-linked Action Plans and status updates |
| `server/team-events.js` | Assigned Manager's dated team context, creation and eight-week event retrieval; no score calculations |
| `server/hr-activities.js` | HR activity catalogue, drafts/publication, department targeting and safe source snapshots |
| `server/activity-support.js` | Employee-eligible upcoming activities, registration and cancellation |
| `server/employee-appointments.js` | PostgreSQL slot availability, Employee bookings, reminders and booking changes |
| `public/js/app.mjs` | Browser screen composition, navigation and interactions |
| `public/js/employee-api.mjs` | Live API adapter using the session; no silent mock fallback |
| `public/js/demo-employee-api.mjs` | Explicit browser preview adapter; not live persistence |
| Other `public/js/*.mjs` | Shared questionnaire/validation, history helpers and role-specific presentation |

## Authentication and role authorization

The login is clearly marked Demo Access. `DEMO_AUTH_ENABLED=true` opts into the three existing fictional identities; absent/false does not enable remote demo login. The legacy local prototype flag remains a separate restricted compatibility path. There is no Microsoft/FEUP authentication integration and no stored application password.

The existing `/api/prototype/*-session` endpoints resolve fixed issuer/subject pairs in PostgreSQL, verify role/active status and regenerate the session. `express-session` keeps `userId` or the compatible `employeeId` on the server; the browser receives a signed HttpOnly, SameSite=Strict cookie with an eight-hour lifetime. Logout destroys the session. Browser role hints are navigation state, never authorization.

Protected requests reload the active account/role from PostgreSQL. Employee, Manager and HR endpoints are separate; selecting an account cannot broaden its database role or scope. Same-origin write checks and JSON validation apply server-side. Production requires a strong secret and secure cookies; proxy trust must match the actual HTTPS proxy. The in-memory session store is allowed for the explicitly enabled single-process fictional demo; real-user production needs a persistent store/bootstrap and verified identity integration.

## Employee ownership and check-ins

The API uses the session's Employee ID, not a caller-supplied user ID. It traverses `private.employee_weekly_checkins` to reach only that Employee's responses. `wellbeing.wellbeing_responses` has **no user_id**. The private eligibility/ownership row contains the link and the frozen team/week; an unanswered row also supplies the participation denominator.

The shared raw-answer contract in `public/js/checkin.mjs` is imported by the backend. Five answers are normalized independently; challenge codes and optional context are validated. The server resolves the current Lisbon Monday, enforces Friday–Sunday, locks the eligibility row, inserts the response/challenges and attaches ownership in one transaction. The `(user_id, week_start)` primary key, unique response link and reciprocal deferred foreign keys enforce weekly uniqueness and one owner at commit. Finalized cohort/history mutations are guarded by database triggers.

Private history returns an Employee-owned score projection; it does not expose response IDs, ownership links or other Employees. Missing historical stress remains null. The monthly completion display uses the week's Monday in the current Lisbon month and caps the display at four without rejecting a valid fifth week.

## Manager, HR and the privacy boundary

- **Manager:** `identity.teams.manager_user_id` resolves the authorized team. Mara sees Platform, a team inside Engineering. She does not inherit the department's other teams.
- **HR:** organization and department aggregates only. Engineering includes its Platform and Product teams; Customer Experience and People and Operations are separate departments. No HR team drill-through or Action Plan access is implied.
- **Historical scope:** `wellbeing.team_weeks.department_id` snapshots the department; private eligibility rows snapshot each Employee's team for the week. Transfers do not rewrite old reporting populations.

The trusted API can join identity/ownership internally for private history and distinct-person privacy checks. It never sends those joins or individual responses/comments/challenge choices/bookings to Manager/HR. PostgreSQL schema names are organizational namespaces, **not permissions or irreversible anonymization**. There is no database RLS/grant layer installed by `schema.sql`; restricted runtime credentials and separate maintenance privileges must be provisioned before using real data. End users must not receive database credentials.

### Reporting

`server/reporting.js` issues scoped aggregate SQL and assembles the approved releases. It uses the latest eight completed Lisbon weeks and finalized cohorts; missing/unfinalized weeks are gaps. Department/organization means use response sums/counts, not averages of team averages. Five measures remain independent; Workload Balance is `10 - mean(workload pressure)` before rounding. Higher stress/pressure is adverse; higher wellbeing/connection/safety/balance is favourable. Attention signals are adverse monthly changes, not diagnoses.

Threshold configuration is validated server-side and fails closed if invalid. The approved current value is `MIN_RESPONSES=5`. Cohort/metric availability, missing stress, complete scope coverage and complementary/residual checks protect counts, rates, changes and trends. Participation is checked independently of score availability. Organization totals must not disclose a protected department by subtraction.

Shared Themes first aggregates measured answers across the eight completed weeks. Its percentage counts responses selecting a challenge; responses can select multiple themes, so percentages need not total 100%. Distinct-person and selector/non-selector protections also apply; repeated weekly responses are not independent people for privacy. Historical unasked factors are not zero prevalence. Only safely released percentages reach presentation; unavailable themes are omitted with explanatory policy/empty states. There is no comment analysis or clinical inference.

**FR5 team events:** Manager-only `/api/manager/events` GET/POST reuse `operations.team_events`. Creation checks and locks the assigned active Manager/team in one SQL statement. The creator is session-derived and omitted from returned data. Retrieval covers the same eight completed Lisbon weeks, with event dates grouped by Monday. After obtaining the unchanged reporting DTO, the route attaches each team's authorized events; `server/reporting.js` itself is unchanged. The browser draws teal week markers and an accessible dated title list. Multiple events share one week's marker; unavailable scores remain gaps, while independent team context can still be read. HR/Employee cannot use these endpoints, and HR reporting receives no events. The small creation form warns against names/individual answers; there is no edit/delete workflow or causal/clinical interpretation.

## Action Plans and wellbeing activities

Action Plans use `operations.team_actions`, only through assigned-Manager endpoints. They can be general actions or linked to an authorized aggregate insight; they contain owner, deadline, description and status. Historical month filters retain completed/old actions. HR uses activities, not these plans.

HR creates/edits the existing `operations.activities` records. Publication time, scheduled start, duration and department targeting remain authoritative; display statuses are derived. An optional insight source is a server-validated safe adverse department metric snapshot, not an individual response. There is no separate intervention entity in the current runtime.

Employee activity SQL requires publication already reached, start still in the future, and eligible department/organization targeting. Past activities are hidden from Employee available lists/Home reminders but retained in HR history and its Month filter. Registration uses `(activity_id, user_id)` uniqueness; the API derives the owner from the session. Upcoming cancellation affects only that owner's registration. Expiry does not delete existing registrations. HR receives registration counts, not attendees.

## Psychologist bookings

Providers and slots are operational data; providers are not an additional application role. Booking records are in `private.psychologist_bookings` and have no link to wellbeing responses. Availability, named-provider booking, confirmation/history and Home reminders all use PostgreSQL in the live app.

The Employee API limits retrieval/change to the session owner. Public-to-Employee availability omits other owners and private meeting links. Owner confirmation may include the online link; Home reminders expose only necessary scheduling information. Only future `booked` appointments appear as upcoming reminders. Past and cancelled bookings remain private history.

Transactions, slot locks, a partial unique active-slot index and database validation reject conflicts. Rescheduling/cancellation obey the existing two-hour cutoff. Rescheduling keeps the booking identity/owner; cancellation retains the row and frees the active slot. Browser preview records are not a second source for live bookings. Fictional `.invalid` links are not real psychologist services.

## Actual folder structure

```text
TeamPulse/
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/                  # app, API adapters, questionnaire, UI/reporting modules
│   └── assets/              # Self-hosted font and TeamPulse logo assets
├── server/                  # Modules listed above; no ORM/repository layer
│   ├── routes/              # Empty placeholder; routes are currently in employee-routes.js
│   └── services/            # Empty placeholder; business modules are directly in server/
├── db/
│   ├── schema.sql           # Consolidated fresh model: 15 tables
│   ├── seed.sql             # Base fictional data
│   ├── manage.cjs           # Guarded init/migration check/demo seed commands
│   ├── expand-demo.cjs      # Original additive local fixture maintenance
│   ├── finalize-weeks.cjs   # Explicit elapsed-cohort finalization
│   ├── migrations/          # Two approved upgrades already consolidated in schema.sql
│   └── README.md
├── tests/                   # node:test + Supertest; opt-in rollback PostgreSQL tests
├── docs/
│   ├── ARCHITECTURE.md
│   └── mockups/             # 17 Assignment 1 visual references
├── README.md
├── SPEC.md
├── AGENTS.md
├── CLAUDE.md
├── DEPLOYMENT.md
├── .env.example             # Template; private .env is not web-served or committed
└── package.json / package-lock.json
```

See [db/README.md](../db/README.md) for keys, constraints and legacy differences. Weekly finalization requires an external scheduler/operator; startup never migrates, seeds or finalizes. FEUP hosting, HTTPS, database grants, backups and process supervision remain infrastructure tasks.

## Deterministic PostgreSQL regression fixtures

Reporting-dependent integrations and the FR5 integration use `tests/helpers/postgres-fixture.cjs`. Each creates a randomly named `teampulse_test_*` database, initializes the current schema/full seed, and drops only that database at cleanup. The test identity needs `CREATEDB` and ownership of these disposable databases; do not grant this privilege to the deployed runtime account.

The helper fixes JavaScript Date and SQL timestamp expressions (including disposable schema defaults/trigger bodies) to Friday 13 November 2026. One millisecond separates private snapshot filenames without changing the calendar. This exists only in test code: no production clock override, reporting formula, finalization rule or check-in schedule changes. Assertions still exercise actual PostgreSQL constraints and compare independent SQL aggregates. Live demo cohorts are neither finalized nor rewritten to satisfy tests. Other PostgreSQL lifecycle tests use rollback-only fixtures; unit tests retain fixed small/privacy-protected cases.

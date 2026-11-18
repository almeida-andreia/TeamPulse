# TeamPulse

Privacy-first employee wellbeing MVP for the Information Systems Architecture course. TeamPulse connects private weekly reflections with safe team/department reporting and access to support. It does not diagnose mental health conditions or evaluate Employee performance.

## Roles and demo access

| Role | Existing fictional demo account | Scope |
| --- | --- | --- |
| Employee | Beatriz Sousa / `employee-05` | Own check-in, history, activities, registrations and psychologist bookings; Engineering / Platform |
| Manager | Mara Duarte / `manager-platform` | Platform team aggregates and Manager-only Action Plans |
| HR / People | Marta Pinto / `hr-marta` | Organization/department aggregates, participation, Insights & Activities |

Platform is a **team inside the Engineering department**. HR department access does not grant team-level reporting access. Managers and HR cannot retrieve individual wellbeing responses or bookings.

The academic MVP uses **Demo access → choose account → Enter demo**, not Microsoft or FEUP SSO. Set `DEMO_AUTH_ENABLED=true` explicitly to enable it. It defaults off, including production. Anyone allowed into the demo can select any of its three fictional accounts; never enable this mechanism against real employee data. Each selection creates a server session with the existing account's actual database permissions.

## Stack and architecture

- Node.js **22+**, Express, PostgreSQL **13+** (locally verified with PostgreSQL 18.3).
- HTML, CSS and native browser JavaScript modules; self-hosted Inter/logo; SVG charts.
- `pg` connection pool, `dotenv` configuration, `express-session` sessions.
- Built-in `node:test` and Supertest; no frontend build step.

```text
Browser: public/index.html + CSS + JavaScript modules
    ↓ same-origin JSON /api requests
Express: server/app.js + server/employee-routes.js
    ↓ authorized business modules and parameterized SQL in server/*.js
PostgreSQL: identity / private / wellbeing / operations schemas
```

See [architecture and folder structure](docs/ARCHITECTURE.md) and the [database model](db/README.md).

```text
TeamPulse/
├── public/             # Only web-served directory: HTML, css/, js/, assets/
├── server/             # Express startup/routes, business modules and database pool
├── db/                 # Schema, demo seed, maintenance tools and approved migrations
├── tests/              # Unit/API tests and opt-in PostgreSQL integrations
├── docs/               # ARCHITECTURE.md and Assignment 1 visual references in mockups/
├── SPEC.md             # Requirements and approved MVP decisions
├── AGENTS.md           # Development/privacy rules
├── CLAUDE.md           # Additional development instructions
├── DEPLOYMENT.md       # Configuration and deployment preparation
├── .env.example        # Configuration template; no real credentials
└── package.json        # Runtime dependencies and npm commands
```

## Local setup

Install Node.js/npm and PostgreSQL first. From the project root:

```sh
npm ci
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env`; use `npm.cmd` if execution policy blocks `npm.ps1`. Do not overwrite an already configured `.env`. Fill `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` privately. Use the actual supplied port; 5432 in the example is not a runtime default. Keep the approved `MIN_RESPONSES=5` and explicitly enable fictional demo access as needed. Never commit `.env`.

For a **new empty dedicated demo database only**, provision the database with an administrator, then:

```sh
npm run db:init
npm run db:migrate -- --check
npm run db:seed:demo
```

These commands are not an instruction to reset the existing local database. Fresh initialization creates 15 tables; the demo command runs the base seed, deterministic expansion and catalogue fixtures transactionally. Seeding requires empty tables and is forbidden in production. Existing installations need a backup and a reviewed upgrade, not another seed. See [database documentation](db/README.md) for historical differences.

Start the configured application:

```sh
npm start
```

Open `http://127.0.0.1:3000` (or the configured `HOST`/`PORT`). Startup validates configuration and checks the database with SELECT; it does not seed, migrate or finalize cohorts. `/api/health` checks the application; `/api/health/db` checks connectivity without exposing passwords.

## Tests

```sh
npm test
```

This runs `node --test --test-concurrency=1`. To include PostgreSQL integrations against a **fictional test/demo database**:

```sh
TEAMPULSE_TEST_POSTGRES=1 npm test
```

PowerShell:

```powershell
$env:TEAMPULSE_TEST_POSTGRES='1'
npm.cmd test
```

Without the opt-in variable the database integrations report skips. Integration fixtures use rollback; PostgreSQL identity sequences may still advance. Do not run the suite against real employee data. `TEAMPULSE_DEMO_BASELINE`, if used, is an optional private maintenance snapshot, not an invariant after legitimate later registrations or submissions. Static dated demo cohorts do not automatically move forward as the calendar advances.

Reporting-dependent integrations now use disposable PostgreSQL databases and a fixed test clock rather than the live demo's calendar state. The test account needs `CREATEDB`; the deployed runtime account does not. The full regression after FR5 reports **216 passed / 0 failed / 0 skipped** (207 previous tests plus nine new FR5 tests/subtests). See [database verification notes](db/README.md#documentation-verification-on-16-november-2026) for the earlier calendar-dependent failures and their resolution. Unset `TEAMPULSE_DEMO_BASELINE` when running isolated fixtures; a live maintenance snapshot is not their expected dataset.

## Operations and scope

The check-in opens Friday–Sunday in Europe/Lisbon. Manager/HR reporting covers finalized completed weeks, with the configured threshold and complementary disclosure protections. Missing historical stress is unavailable, never zero. Ongoing operation requires an administrator to schedule `npm run db:finalize-weeks` after Monday 00:00 Lisbon; startup does not run it. Do not run maintenance commands merely to refresh a presentation without reviewing their effect.

**FR5 / US6:** Managers can add dated events for their assigned team and see titles/week markers on the existing evolution chart. Events are context only, do not affect reporting values and are not exposed to HR/Employees. The seeded events are reused; no new demo records are required.

External hosting is not configured by local setup. See [DEPLOYMENT.md](DEPLOYMENT.md) for HTTPS/proxy trust, database TLS/credentials, secrets, single-instance demo sessions versus persistent production sessions, and FEUP infrastructure questions. The stack remains Node.js + Express + PostgreSQL.

Requirements: [SPEC.md](SPEC.md). Development rules: [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md). Visual references: [docs/mockups/](docs/mockups/).

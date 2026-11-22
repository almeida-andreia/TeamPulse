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

The current public academic/demo deployment is live using **GitHub → Render Web Service → Node.js/Express → Neon PostgreSQL**. Render provides HTTPS and runs the application; Neon stores its persisted data. It uses the same explicitly enabled Demo Access described above. The Neon database has already been initialized and seeded; routine redeployments do not initialize or seed it again.

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
├── DEPLOYMENT.md       # Render + Neon configuration and deployment runbook
├── .env.example        # Configuration template; no real credentials
└── package.json / package-lock.json  # Dependencies, npm commands and locked versions
```

## Local setup

Use Node.js 22+, npm and an available PostgreSQL database. PostgreSQL can run locally or be supplied by an authorized managed service; the application uses its installed `pg` driver and does not require `psql`. From the project root:

```sh
npm ci
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env`; use `npm.cmd` if execution policy blocks `npm.ps1`. Do not overwrite an already configured `.env`. Fill `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` privately. Injected environment variables override `.env`; the application does not use `DATABASE_URL`. Use the supplied port; 5432 in the example is not a runtime default. Neon requires `DB_SSL=true` with certificate verification. Keep the approved `MIN_RESPONSES=5` and explicitly enable fictional demo access as needed. Never commit `.env`.

For a **new empty dedicated demo database only**, provision the database with an administrator, then:

```sh
npm run db:init
npm run db:migrate -- --check
npm run db:seed:demo
```

These commands are not an instruction to reset the existing local or Neon database. Fresh initialization creates 15 tables; the demo command runs the base seed, deterministic expansion and catalogue fixtures transactionally. Seeding requires empty TeamPulse tables and is forbidden when `NODE_ENV=production`. Existing installations need a backup and a reviewed upgrade, not another seed. Shared databases have a separate explicit `npm run db:init -- --shared` path; see [database documentation](db/README.md) for its safeguards and historical differences.

Start the configured application:

```sh
npm start
```

Open `http://127.0.0.1:3000` (or the configured `HOST`/`PORT`). Startup validates configuration and checks the database with SELECT; it does not seed, migrate or finalize cohorts. `/api/health` checks the application; `/api/health/db` checks connectivity without exposing passwords.

## Tests

```sh
npm test
```

This runs `node --test --test-concurrency=1`. Without `TEAMPULSE_TEST_POSTGRES=1`, PostgreSQL integrations report skips. The **current verified complete baseline is 252 total / 252 passed / 0 failed / 0 skipped**, verified on 21 November 2026, including FR5, shared initialization, check-in consistency and the HR activity lifecycle, ordering and Lisbon timezone regressions.

The full suite requires a **separately initialized and seeded disposable local baseline**. First configure `DB_HOST` to loopback and `DB_NAME` to that disposable database, with its test credentials in the test shell. Never point the suite at Neon, FEUP, the existing local demo or real employee data. The test identity needs DDL and `CREATEDB` privileges; the deployed runtime identity does not. Then:

```sh
TEAMPULSE_TEST_POSTGRES=1 npm test
```

PowerShell:

```powershell
$env:TEAMPULSE_TEST_POSTGRES='1'
# DB_* must already select the disposable local baseline.
Remove-Item Env:TEAMPULSE_DEMO_BASELINE -ErrorAction SilentlyContinue
npm.cmd test
```

Reporting/FR5 tests create and remove additional disposable databases with a fixed test clock. Other integrations roll back writes but can still advance sequences in the configured baseline. Full integration testing therefore cannot run under a no-initialization/no-seed/no-database-writes restriction. Fixed historical dates are intentional test fixtures; live demo cohorts do not roll forward automatically. See [database verification notes](db/README.md#current-verified-test-baseline).

## Operations and scope

The check-in opens Friday–Sunday in Europe/Lisbon. Manager/HR reporting covers finalized completed weeks, with the configured threshold and complementary disclosure protections. Missing historical stress is unavailable, never zero. Ongoing operation requires an administrator to schedule `npm run db:finalize-weeks` after Monday 00:00 Lisbon; startup does not run it. Do not run maintenance commands merely to refresh a presentation without reviewing their effect.

**FR5 / US6:** Managers can add dated events for their assigned team and see titles/week markers on the existing evolution chart. Events are context only, do not affect reporting values and are not exposed to HR/Employees. The seeded events are reused; no new demo records are required.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the current Render + Neon runbook, verified database TLS, secrets, HTTPS/proxy trust and the known single-instance academic/demo MemoryStore limitation. Restarts require signing in again; application data remains in PostgreSQL. FEUP is an alternative assignment infrastructure option, not the current production database.

Requirements: [SPEC.md](SPEC.md). Development rules: [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md). Visual references: [docs/mockups/](docs/mockups/).

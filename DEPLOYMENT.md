# TeamPulse deployment — Render + Neon

The current public academic/demo deployment is **GitHub → Render Web Service →
Node.js + Express → Neon PostgreSQL**. Render hosts the process and provides
HTTPS; Neon is the external database. Demo Access is explicitly enabled for
fictional accounts; real SSO is not a prerequisite for this MVP.

**The current Neon database has already been initialized and seeded.** Routine
Render redeployments run `npm ci` and `npm start` only: never add `db:init`, seed,
expansion, migration or finalization commands to build/start/pre-deploy steps.
New-database procedures below are reference instructions, not a request to rerun
setup against the existing Neon or local demo database. FEUP is a separately
labelled alternative assignment infrastructure option, not current production.

## Clean development/demo installation

Requirements: Node.js 22 or later, npm, and an **empty dedicated PostgreSQL 13+
database** for a new installation only (local PostgreSQL or a new Neon database).
For Neon maintenance/initialization use its direct endpoint and `DB_SSL=true`.
Shared databases use the separate explicit
initialization path documented below. Verification used Node 26.13 and PostgreSQL
18.3. The database must
already exist; its maintenance account needs permission to create schemas,
tables, functions, triggers and indexes. Provisioning database roles/grants is
an infrastructure task, not part of the application seed.

```sh
npm ci
cp .env.example .env
```

On PowerShell use `Copy-Item .env.example .env`. If execution policy blocks
`npm.ps1`, use `npm.cmd` for every npm command below; no policy change is needed.
`npm install` also works, but `npm ci` installs the exact committed lockfile.

Edit `.env`: fill all five `DB_*` connection fields for your supplied database.
The example port 5432 is not a runtime default; use your actual PostgreSQL port.
Keep `MIN_RESPONSES=5` for the approved demo. Do not copy another person's secrets.
Have an administrator provision the empty local database, or use a new managed
database explicitly reserved for this installation. TeamPulse's
Node setup commands do not depend on `psql`, `createdb`, a Windows installation
directory, or shell-specific SQL quoting.

```sh
npm run db:init
npm run db:migrate -- --check
npm run db:seed:demo
npm start
```

Open `http://127.0.0.1:3000` or `http://localhost:3000`. Select Employee, Manager
or HR under **Demo access**, then **Enter demo**. Requests use relative `/api/...`
URLs and the same origin. No Microsoft, FEUP, Google or email login is involved.

Run all tests, including PostgreSQL, sequentially against a separately initialized
and seeded **disposable local baseline**, never Neon, FEUP or the existing demo.
The test/maintenance login needs DDL and `CREATEDB` privileges: reporting tests
create and remove additional disposable databases. Explicitly configure `DB_HOST`
to loopback, `DB_NAME` to that baseline and its test credentials in the test shell
before running; do not inherit a live deployment connection:

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

Without that variable the PostgreSQL tests explicitly report skips; unit/API
fixtures still run. Do not run this integration suite against real employee data.
Its transaction fixtures roll back, but generated identity sequences may advance
in the configured baseline, which is why that baseline must also be disposable.
The current verified complete baseline is **243 total / 243 passed / 0 failed /
0 skipped**, verified on 20 November 2026. Set `TEAMPULSE_TEST_POSTGRES=0` for
non-database verification. A no-DDL/no-seed/no-database-writes task cannot safely
reproduce the complete run; do not change tests to hide that limitation.

## Configuration contract

Server environment variables override `.env`. Both app and database resolve the
optional `.env` relative to this repository, regardless of the working directory.
Only `public/` is served. No credential values are logged.

| Variable | Meaning |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | All required. No implicit pg user/database/port fallback. Unix socket hosts are also supported by pg. |
| `DB_SSL` | `true` enables TLS with certificate verification; default `false` for local PostgreSQL. |
| `DB_SSL_CA_FILE` | Optional readable CA file when TLS is enabled; absolute or relative to repository root. Verification is never disabled. |
| `DB_POOL_MAX` | Pool limit, 1–100; default 5. Timeouts retain the existing bounded MVP settings. |
| `NODE_ENV` | `development` (default), `test`, or `production`. Invalid values fail. |
| `HOST` | Bind address; default `127.0.0.1`. Set an infrastructure-appropriate address explicitly. |
| `PORT` | Integer 1–65535; default 3000. |
| `DEMO_AUTH_ENABLED` | Strict `true`/`false`. Explicit `true` enables the three fixed fictional accounts, including external visitors and an academic production deployment. Explicit `false` disables every demo login. Remote demo access defaults off, including production. Never enable against real employee data. |
| `ENABLE_PROTOTYPE_ACCESS` | Legacy explicit local-only opt-in when `DEMO_AUTH_ENABLED` is absent. Defaults off; never permits remote hosts or production. The new flag takes precedence. |
| `SESSION_SECRET` | Optional in development (existing random per-process fallback); required in production, at least 32 characters generated from secure random bytes. |
| `TRUST_PROXY` | Default `false`. Otherwise explicit comma-separated IPs/CIDRs or Express subnet names. `1` explicitly trusts only the immediate managed proxy; use only with controlled forwarded headers and no public path bypassing that proxy. Blanket `true` and other hop counts are rejected. |
| `MIN_RESPONSES` | Required at process startup; approved demo value **5**. No setup command changes it. Existing reporting validation/suppression remains authoritative. |

Generate a new session secret privately, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store it in the server's secret configuration, never source control. Normal
production also requires a persistent `express-session` store supplied by a
trusted bootstrap through `startServer({ sessionStore })` /
`createApp({ sessionStore })`. Default or explicit MemoryStore is rejected unless
the fictional demo is explicitly enabled. No store vendor is assumed.

### Neon connection settings and endpoint types

The application uses separate `DB_*` fields through `pg`, not `DATABASE_URL`.
Copy only the selected endpoint hostname into `DB_HOST`; put the supplied port,
database and role into `DB_PORT`, `DB_NAME` and `DB_USER`. Enter `DB_PASSWORD`
privately and set `DB_SSL=true`. The existing client verifies certificates;
a publicly trusted certificate needs no `DB_SSL_CA_FILE`. Do not paste a full
connection string into source, documentation, logs or the hostname field.

Neon offers direct and pooled endpoints. Pooled hostnames contain `-pooler` and
use transaction pooling, which limits session-dependent features. Use the direct
endpoint for initialization, migrations and maintenance. For runtime, retain the
configured working endpoint; choosing pooling is a separate operational decision.
Both use the same `DB_*` contract and verified TLS. Keep `DB_POOL_MAX=5` unless an
authorized connection-budget change is required; it limits the application's
own `pg` pool even with a pooled endpoint. See [Neon pooling](https://neon.com/docs/connect/connection-pooling)
and [secure connections](https://neon.com/docs/connect/connect-securely).

### Render deployment

The current architecture is **GitHub → Render Web Service → Node.js + Express →
Neon PostgreSQL**. This runbook documents the deployed academic/demo configuration;
editing it does not change Render settings or execute a deployment. No backend
conversion, frontend URL change, schema change or SSO integration is required.

| Environment | Application | Database |
| --- | --- | --- |
| Development | `http://localhost:3000` by default, or the configured local `PORT` | Local PostgreSQL, or an explicitly authorized managed development connection |
| Academic production | The HTTPS URL assigned to the Render Web Service | The existing initialized/seeded Neon PostgreSQL database, with verified TLS |

1. **GitHub:** review and push the application to your repository, including
   `package-lock.json`. Exclude `.env`, credentials, backups and `node_modules/`.
   Include `tests/database-initialization.test.js` along with the other legitimate
   tests. No commit or push is performed by this documentation pass.
2. **Render service configuration:** retain the existing service for routine
   redeployment. For a new service, choose **New > Web Service**, connect the
   GitHub repository and select the reviewed branch. Choose the **Node** runtime and the repository
   root as Root Directory. Use **Build Command: `npm ci`**, **Start Command:
   `npm start`**, and **Health Check Path: `/api/health`**. There is no frontend
   compilation step. Keep a single instance for the existing in-memory demo
   sessions. Leave pre-deploy/database commands empty. The existing Neon database
   is already set up; redeployments must not reinitialize or seed it.
3. **Environment:** configure the following in Render before the first deploy.
   Use Render's secret fields for passwords/session secrets, never source files.

   | Variable | Render value |
   | --- | --- |
   | `NODE_VERSION` | `26.13.0`, the locally verified version; explicitly select a supported tested version instead of relying on the open-ended package engine range |
   | `NODE_ENV` | `production` |
   | `HOST` | `0.0.0.0` |
   | `PORT` | Let Render supply it; do not copy the local 3000/3001 setting |
   | `DEMO_AUTH_ENABLED` | `true` for this fictional academic demonstration |
   | `ENABLE_PROTOTYPE_ACCESS` | Omit, or `false` |
   | `MIN_RESPONSES` | `5`, unchanged |
   | `SESSION_SECRET` | A fresh secret generated from at least 32 cryptographically random bytes, e.g. the command above |
   | `TRUST_PROXY` | `1` for the immediately upstream Render managed ingress, subject to the conditions below |
   | `DB_HOST` | The selected Neon endpoint hostname, without a URL or credentials |
   | `DB_PORT` | The supplied Neon PostgreSQL port, normally `5432` |
   | `DB_NAME` | The supplied Neon database name |
   | `DB_USER` | The supplied Neon application database role |
   | `DB_PASSWORD` | That login's password, entered privately in Render |
   | `DB_SSL` | `true`, required for Neon; certificate verification remains enabled |
   | `DB_SSL_CA_FILE` | Normally omitted for Neon's publicly trusted certificate; only supply a readable custom CA file when required by the administrator |
   | `DB_POOL_MAX` | `5`, within the authorized database connection budget |

   The five connection variables are mandatory. TLS keeps certificate verification
   enabled; there is no insecure certificate-bypass option. A publicly trusted CA
   needs no custom CA file. Do not place real Neon connection details/secrets in
   `.env.example` or commit a credential file. Neither a Render URL nor
   `DATABASE_URL` is needed by this app.

   Render requires the public listener on `0.0.0.0`; the existing `HOST` setting
   provides that explicitly while preserving loopback as the local default.
   The existing startup reads Render's `PORT`; neither 3000 nor 3001 is required.
   Express serves `public/` and `/api/...` from the same origin. Keep the app at
   the origin root and retain root-relative frontend API/assets.

   **HTTPS and proxy boundary:** Render terminates public TLS and forwards HTTP
   to Node. `TRUST_PROXY=1` trusts only the directly connected peer, allowing
   `X-Forwarded-Proto: https` to make `req.secure` true. This is an explicit
   topology setting, not automatic trust based on a platform variable. Use it
   only when the managed ingress controls forwarded protocol/host headers and
   all public traffic reaches Node through that ingress. Do not expose a direct
   public route to the Node listener. Reassess trust if you add another public
   path or proxy; alternatively use verified proxy IPs/CIDRs. `TRUST_PROXY=true`
   remains invalid. Same-origin checks compare against the original `Host`
   header, not a client-supplied forwarded host. Verify this boundary in step 6.

   Production cookies remain `Secure`, `HttpOnly`, `SameSite=Strict`, with the
   existing eight-hour lifetime and session ID regeneration on sign-in. Explicit
   fictional demo mode retains its existing single-process MemoryStore exception:
   restarts, redeploys and instance replacement require signing in again. Ordinary
   production without demo mode still rejects MemoryStore and requires a trusted
   persistent session-store integration. No new session architecture is added.

4. **Routine redeployment:** deploy the reviewed GitHub revision through the
   existing Render service using the build/start commands above. Keep the
   existing working Neon connection and secret settings; do not run database
   setup or change settings merely for a documentation update.
   Startup makes a SELECT-only connection check before listening; unavailable
   PostgreSQL makes startup fail safely. It never initializes/migrates/seeds.
   An empty but reachable database can pass process health while role APIs still
   need setup. Step 5 applies only to a new installation; the current Neon
   database has already completed it.
5. **New database setup only:** from a trusted workstation or authorized one-off
   maintenance shell with Node/npm, the reviewed source, Neon's direct endpoint
   and maintenance credentials injected privately into that process.
   Keep the deployed service's runtime login separate from schema-maintenance
   privileges. Do not give the runtime login superuser or `CREATEDB` privileges.

   For a new, empty, dedicated database only:

   ```sh
   npm run db:init
   npm run db:migrate -- --check
   ```

   `db:init` creates the consolidated schema and refuses nonempty databases.
   **Alternative/historical assignment infrastructure — shared FEUP database:**
   FEUP is not the current production database. VPN/private-network-only access
   from a laptop does not establish Render reachability; any future FEUP option
   needs an administrator-supported network route, TLS and grants. No VPN bypass
   is assumed. For a shared FEUP database such as `mesg2607`, use this alternative only
   after FEUP confirms that `identity`, `private`, `wellbeing`, and `operations`
   are available and reserved for TeamPulse.

   ```sh
   npm run db:init -- --shared
   ```

   On PowerShell, use `npm.cmd run db:init -- --shared` if needed. The existing
   environment variables select the database; the flag does not select FEUP or
   supply credentials. This is a future alternative maintenance step, not a
   command for the current Neon deployment or this documentation pass.

   Shared mode permits unrelated `public` tables and other projects' schemas
   because the existing TeamPulse objects use schema-qualified names. It checks
   all four target names through `pg_catalog.pg_namespace`, including names not
   exposed by `information_schema`. If any target schema exists, even empty or
   owned by someone else, initialization stops before application DDL. It never
   reuses, drops, renames or repairs an occupied namespace. Do not remove another
   project's schema to make this command succeed; resolve reservations with FEUP.

   The existing schema body runs in one transaction under the existing setup
   advisory lock. A creation error rolls back all TeamPulse objects created by
   that attempt. Shared mode uses a transaction-local trusted search path and
   preserves unrelated objects/data. It creates the same four schemas and 15
   tables as dedicated mode, with no credentials, grants or application rows.
   **Demo seed/expansion, migrations and week finalization are not part of shared
   initialization. Do not run demo seeding/expansion against FEUP as part of this
   procedure.** Existing `npm run db:init` without the flag retains its empty-
   dedicated-database restriction. `--shared` is rejected for other commands.

   Fresh schema already contains both approved migrations. For an existing
   database, take a private backup, omit `db:init`, inspect with the same migration
   check and run `npm run db:migrate` only if it reports pending approved upgrades.
   Unsupported/partial older schemas need review rather than automatic repair.

   If this is the first setup of an **empty, dedicated fictional demo database
   (local or new Neon)**, seed the existing approved fixtures once, through its
   direct connection in a separate maintenance process only. This does not apply
   to the current already-seeded Neon database:

   ```sh
   NODE_ENV=development npm run db:seed:demo
   ```

   That is POSIX shell syntax. On PowerShell set `$env:NODE_ENV='development'`
   only in the maintenance shell, run `npm.cmd run db:seed:demo`, then close that
   shell. The deployed Render service stays `NODE_ENV=production`; production
   seeding remains forbidden. The seeder refuses nonempty TeamPulse tables and
   requires `MIN_RESPONSES=5`. Do not seed an existing demo or real employee data.
   It reuses the existing fixtures, not a new account/data-generation feature.
   No initialization, migration or seed against any database is performed by this
   documentation task.

   Have the administrator apply the existing runtime access policy to the
   initialized schemas/functions/tables. Database credentials belong only to the
   trusted API/maintenance operators; Manager/HR users never receive them.
6. **Verify the deployment:** open the assigned HTTPS URL; `/api/health` should
   return 200 with only the process status/message. This endpoint performs no
   database query and is the existing safe health endpoint, so `/health` is not
   needed. `/api/health/db` returns only generic connection status in production;
   check it manually after setup. A green process check alone does not prove
   schema readiness, data availability or authorization.

   Confirm `/api/demo-access` is enabled over HTTPS, sign into each of the three
   existing fictional accounts, and check its authorized dashboard. In browser
   developer tools confirm the session cookie has Secure/HttpOnly/SameSite=Strict,
   authenticated requests retain the session, cross-role APIs are denied, and
   API/assets use the same origin. Confirm HTTP redirects to HTTPS at Render's
   edge. Check that an altered forwarded host cannot satisfy an unrelated Origin;
   do not loosen proxy/cookie settings to resolve a failed login. Preserve the
   weekly submission window and all reporting suppression; do not create test
   check-ins in the deployed database just to verify startup. Review sanitized
   logs for startup errors, then restart once and confirm demo sign-in works again.

After initial setup, the existing `npm run db:finalize-weeks` remains an explicit
maintenance operation after Monday 00:00 Europe/Lisbon (or a separately configured
scheduler). It is not part of build/start and does not fabricate answers. Do not
run the PostgreSQL integration tests against Neon, FEUP or the existing local demo:
they require disposable local
databases and test-only DDL privileges. Local complete tests use
`TEAMPULSE_TEST_POSTGRES=1 npm test` with a disposable configured baseline too,
so rollback tests cannot advance sequences in the existing local demo database.

Platform references: [Render Web Services](https://render.com/docs/web-services),
[Node version selection](https://render.com/docs/node-version),
[Render TLS forwarding](https://render.com/tutorials/web-service-vs-static-site/web-services),
[health checks](https://render.com/docs/health-checks), and
[Express proxy trust](https://expressjs.com/en/guide/behind-proxies/).

Historical local Render-preparation verification on 18 November 2026: `npm ci` succeeded;
the complete suite reported **216 tests, 216 passed, 0 failed, 0 skipped** with
PostgreSQL enabled and a disposable baseline. A separate `npm start` smoke check
used `NODE_ENV=production`, `HOST=0.0.0.0`, an injected non-default `PORT`, a random
session secret and `TRUST_PROXY=1`. Process/database health, frontend/assets,
HTTPS recognition, all three existing demo logins, secure cookie flags and
authorized dashboard reads passed against local test PostgreSQL. Forwarded HTTPS
was simulated locally; that historical pass did not connect to FEUP or deploy
externally. The application has since been deployed successfully to Render with
Neon, and local application testing against Neon succeeded. Those deployment
facts are the approved project state, not new checks executed by this document
cleanup. The current verified complete test baseline is 243/243, recorded above.

## External academic MVP demo access

Configure the existing application process explicitly for a fictional demo:

```dotenv
NODE_ENV=production
DEMO_AUTH_ENABLED=true
HOST=0.0.0.0
MIN_RESPONSES=5
TRUST_PROXY=1
DB_SSL=true
```

Let Render provide `PORT`; do not pin the local port in production. Also supply
the existing Neon `DB_*` settings and a privately generated
`SESSION_SECRET` of at least 32 characters. There are no demo passwords. Do not
publish `.env`, credentials, database access, or the Node port directly.

Serve the application at the root of an HTTPS origin through the deployment's
TLS reverse proxy. The current Render setup uses `TRUST_PROXY=1` only for its
immediate managed ingress, with the boundary conditions above. An alternative
verified proxy can use its actual trusted IP/CIDR. Without trusted
HTTPS, production demo sign-in is refused; arbitrary forwarded headers do not
enable it. Same-origin checks, HttpOnly/SameSite=Strict/Secure cookies, session
regeneration and the existing eight-hour session lifetime remain in force.

For the minimal single-process academic demo, explicit demo mode permits the
existing in-memory session store. Reloads, navigation and logout/login work;
process restarts clear sessions, so visitors sign in again. Application records
remain in PostgreSQL. Use one process/instance or supply a shared persistent
session store for multiple instances. No session-store tables are created here.

The professor opens the deployed HTTPS URL, selects a named fictional account,
and presses **Enter demo**. No developer action or external account is needed.
Anyone with access to this demo URL can choose any of the three demo accounts;
this is explicitly for fictional data. Once a role is selected, its existing
server-side permissions remain unchanged. It is not authentication for real
employees. Turn it off with `DEMO_AUTH_ENABLED=false` and restart the process;
production without the flag also has no demo login. Future verified identity
integration must use the existing session/authorization boundary separately.

`GET /api/demo-access` returns only the request's demo availability. A disabled or
unreachable service keeps the login controls disabled. Login does not insert or
modify users: the three subjects must already exist and be active in PostgreSQL.
The public deployment uses Render HTTPS; this documentation pass does not
provision hosting, change settings or redeploy it.

Startup validates configuration, performs a SELECT-only PostgreSQL check, and
then binds the listener. It does not initialize, migrate or seed a database.
Configuration and binding failures are actionable; connection failures are
sanitized. SIGINT/SIGTERM close the listener and pool. `/api/health` is unchanged;
production `/api/health/db` omits database/user diagnostics.

## Schema, migrations and reproducible data

`db:init` applies the **current consolidated** `db/schema.sql` transactionally,
only to an empty dedicated database by default. `npm run db:init -- --shared`
explicitly allows unrelated objects in a shared database, but still requires all
four target namespaces to be absent. Both paths refuse to reset/reuse occupied
TeamPulse schemas. Confirm namespace reservations before FEUP initialization;
shared mode does not seed or expand data. See the Render manual setup above.
Fresh databases contain 15 application tables. An unused legacy intervention
table in the existing local database is deliberately not recreated.

The two files in `db/migrations/` are upgrades for older databases. Their changes
are already in `schema.sql`; do not blindly run every file after a fresh init.
`db:migrate -- --check` reads the existing shape. `npm run db:migrate` applies only
missing approved Manager/HR feature upgrades, atomically. Partial upgrades fail
for review. This is a small shape-based runner for the two existing migrations,
not a general migration framework. Older databases without `stress_score` require
a separately reviewed questionnaire upgrade; no historical stress is backfilled.
Take an administrator backup before upgrading an existing installation.

`db:seed:demo` is explicit, forbidden in production, and requires empty TeamPulse
tables. One transaction runs:

1. The existing `seed.sql`: departments, teams, 24 fictional Employees, six
   Manager/HR accounts, eight completed weeks, open current week, five-score
   responses, challenges, events, actions, activities, registrations and bookings.
2. The existing deterministic expansion: 28 more fictional Employees and 192
   responses, using the approved questionnaire mappings and independent stress.
   Its narrow historical-import exception is restored before commit.
3. Three department activity examples through the existing HR service, with real
   safe aggregate sources (Engineering/CX published; People and Operations Draft),
   plus the completed Platform capacity example through the Manager service.

The fresh scenario has 52 Employees / 58 users, **358 responses**, 8 activities,
17 registrations and 5 action plans. Ana's current week is open for a demo.
It reconstructs the intended scenario, not a byte-for-byte backup of live local
data: it excludes the later QA activity/registration and Ana's manual submission.
All freshly generated responses have independently generated stress. Existing
legacy NULL stress in the local database is never changed by these commands.

Given the Lisbon execution week, people, participation patterns, scores and
choices are deterministic. Dates are relative to that Monday; opaque response
and generated user UUIDs remain random by design. Reseeding nonempty tables is
refused. Failure rolls back the whole seed; sequences may advance. Snapshot files
written by the existing expansion contain fictional private data and stay in the
OS temporary directory, outside public/ and version control.

The existing `db/expand-demo.cjs` CLI retains its intentional `localhost` /
`teampulse` safety restriction for the original maintenance use case. The new
empty-database seed is the portable rebuild path; no safety restriction was
silently removed. A static demo is not a recurring cohort finalization scheduler.

## Authentication integration boundary

### Presentation accounts

Use **Demo access** at `http://localhost:3000` or the configured demo URL and its
**Enter demo** button. This starts a server session; it does not contact
Microsoft, Google, FEUP, or another SSO provider. No password is required.

| Role selection | Fictional account | Internal login identifier | Scope |
| --- | --- | --- | --- |
| Employee | Beatriz Sousa | `employee-05` | Engineering / Platform |
| Manager | Mara Duarte | `manager-platform` | Engineering / Platform only |
| HR / People | Marta Pinto | `hr-marta` | Organization / department aggregates |

These existing active accounts use the fictional issuer
`https://sso.example.invalid`. The identifiers are resolved server-side, not
accepted as login fields from the browser. Other seeded users remain intact.
The Employee already has private history and a persisted appointment. Weekly
check-in availability follows Friday-to-Sunday in Lisbon and remains limited to
one submission per week; do not reset a completed submission for a presentation.

### Existing session boundary

`server/employee-routes.js` installs sessions and the gated demo endpoints (which
retain their existing `/api/prototype/*-session` URLs for compatibility).
Those endpoints resolve fixed fictional SSO subjects via PostgreSQL, regenerate
the session and save `employeeId` or `userId`. Browser role selection never grants
API permission. Existing sessions read `userId ?? employeeId`.

Every protected request reloads the active account/role through
`server/employee-checkins.js`. Employee queries use that authenticated account;
Manager scope is `identity.teams.manager_user_id`; HR departments and historical
team membership come from the reporting service and `wellbeing.team_weeks`.
The frontend cannot supply identity or broaden those scopes.

Future production authentication must verify the actual identity, map its issuer/subject to
`identity.users`, regenerate/save the same server session, and replace the
prototype sign-in action. Mount the provider callbacks after session middleware,
before the `/api` fallback. Preserve the authorization/service contracts. Do not
accept roles, teams or user IDs from an unverified browser claim.

The SSO callback contract, identity provisioning, logout, CSRF/state handling and
cookie requirements depend on the real provider. No FEUP protocol is assumed.

## Preserved implementation decisions and real-user limitations

- Runtime database endpoints/credentials were already environment-based. Added
  strict validation, explicit TLS/CA support and configurable pool/bind settings.
- Root-relative assets/API paths intentionally require a dedicated origin or a
  root-preserving reverse proxy. A future subpath mount needs target-specific work.
- `.invalid` SSO/session URLs and `teampulse.local` calendar UIDs are deliberate
  fictional identifiers, not external services or deploy-time host settings.
- `Europe/Lisbon` is the approved check-in/reporting calendar policy, not a
  machine-specific timezone setting; it remains unchanged.
- Fonts/logo are self-hosted. Filesystem paths use Node path/os APIs; Windows
  paths in the old database README were illustrative operator examples only.
- Random session secrets remain development-only. Production demo login requires
  explicit `DEMO_AUTH_ENABLED=true`, a strong secret and HTTPS. MemoryStore is
  permitted only for that single-process fictional demo, not normal production.
- Removed unused Chart.js and Jest. Runtime imports are declared; tests use
  built-in `node:test` plus dev-only Supertest. Remaining dependency versions were
  not upgraded. `npm test` now runs the actual suite in sequence.

**Real-user requirements, not academic MVP deployment blockers:** provider-specific
SSO integration and a persistent session-store adapter/bootstrap are required
before using real identities. The current fictional Demo Access deployment
intentionally uses neither real SSO nor a new session store.
For ongoing use, operate `npm run db:finalize-weeks` after Monday 00:00 Lisbon,
or periodically using the deployment scheduler. It is idempotent and closes only
elapsed open cohorts using the existing database locks/triggers. It never changes
answers or reconstructs historical membership; missing/incomplete or small cohorts
remain suppressed by the unchanged reporting layer. Startup does not run it.
The command was verified inside a rolled-back transaction, not applied to the
live local demo. Scheduling and maintenance credentials are deployment operations.
Support booking, Home reminders, rescheduling and cancellation now share the
Employee-owned PostgreSQL records. Browser-only preview data is used only by the
explicit static demo adapter, never as fallback for the PostgreSQL application.

**Current hosting and ongoing operations:** Render supplies Node process hosting
and public HTTPS; Neon supplies PostgreSQL. Preserve restricted runtime access,
separate maintenance privileges, verified TLS and private secrets. Backups and
any cohort-maintenance schedule remain operator responsibilities. Multiple
instances or real-user use require persistent sessions; the known academic/demo
MemoryStore limitation is documented above. This pass changes no infrastructure.

**Alternative assignment infrastructure:** FEUP PostgreSQL is not the current
production database. A future FEUP deployment needs confirmation of network
reachability from its chosen app host, PostgreSQL grants and TLS/CA requirements.
The shared initialization option is preserved; it is not a reason to reconnect,
seed or otherwise change FEUP. Real SSO remains outside the academic demo.

The public Render + Neon academic demo is deployed. Authentication for real users
is not implemented and is not claimed by Demo Access.

## Local handoff checklist

- [ ] Runtime: Node.js **22+**, PostgreSQL **13+** (verified locally with Node
  26.13 and PostgreSQL 18.3), npm and the committed `package-lock.json`.
- [ ] Include `server/`, `public/`, `package.json`, `package-lock.json`,
  `.env.example`, this document and the database scripts below. Exclude `.env`,
  `node_modules`, temporary snapshots, logs and private backups from the handoff.
- [ ] Base schema: `db/schema.sql`. Existing upgrades:
  `db/migrations/20261111_manager_action_plans.sql` and
  `db/migrations/20261111_activity_insights.sql`; use the shape check before
  upgrading. Do not apply them blindly after a fresh schema installation.
- [ ] Optional alternative FEUP setup only: reserve/confirm the four target schema names, then use
  the explicit `npm run db:init -- --shared` manual path. Never use it to reset
  an existing TeamPulse installation; no demo seed/expansion is included.
- [ ] Demo seed sources: `db/seed.sql`, `db/expand-demo.cjs`, and the catalogue
  preparation in `db/manage.cjs`. Run the documented clean-install commands only
  against a dedicated empty database. No automatic reseed/reset on startup.
- [ ] Required database configuration: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
  `DB_PASSWORD`; configure `DB_SSL`/`DB_SSL_CA_FILE` if required by infrastructure.
- [ ] Application configuration: `NODE_ENV`, `HOST`, `PORT`,
  `DEMO_AUTH_ENABLED=true` for the fictional academic demo, `MIN_RESPONSES=5`,
  private `SESSION_SECRET`, and `TRUST_PROXY` matching the real TLS proxy.
- [ ] Verify the three existing demo identities and their persisted scopes;
  never create duplicate accounts or use real employee data with public demo login.
- [ ] Configure HTTPS, process supervision and connectivity on the supplied host.
  A single-process academic demo can use its explicit in-memory session mode;
  multiple instances/real-user production need a shared persistent session store.
- [ ] Schedule `db/finalize-weeks.cjs` through the documented npm command using a
  restricted maintenance identity. It must not change reporting privacy policy.
- [ ] Before upgrades, take a private PostgreSQL backup and test restoring it to
  a separate database. Configure retention, access and recovery with the host's
  administrator; no backups or private data were uploaded by this QA pass.

The clean install was actually exercised in an isolated temporary project and
database (`npm ci`, `db:init`, `db:migrate -- --check`, `db:seed:demo`, `npm start`
and all three role logins). The temporary database was removed afterwards.
The final local QA uses transactions/rollback for functional writes and compares
all original table fingerprints, trigger definitions and reporting results.
An old `TEAMPULSE_DEMO_BASELINE` file is a historical maintenance snapshot, not a
current runtime fixture: after legitimate operational changes, do not use it as
the current database's expected registration/activity count. The integration
tests still take and compare their own current snapshots; no test is disabled.

References: [Express sessions](https://expressjs.com/en/resources/middleware/session/),
[proxy trust](https://expressjs.com/en/guide/behind-proxies/),
[pg TLS](https://node-postgres.com/features/ssl),
[npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/).

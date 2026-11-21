# TeamPulse database model and fictional data

The current consolidated [schema.sql](schema.sql) defines **15 application tables** in four PostgreSQL schemas. [seed.sql](seed.sql) is a fresh fictional base fixture; neither is a migration or a backup of the existing local database. The trusted Express modules use parameterized SQL through `pg`; see [architecture](../docs/ARCHITECTURE.md) and [deployment setup](../DEPLOYMENT.md).

The current public academic/demo deployment is **GitHub → Render → Node.js/Express → Neon PostgreSQL**. Its Neon database has already been initialized and seeded. Routine redeployment does not initialize, migrate or seed it. The FEUP shared-database procedure below is an optional assignment infrastructure alternative, not the current production setup. Local historical observations below do not describe Neon's current row counts.

## Tables, keys and relationships

`user_id`, `response_id` and `booking_id` are UUIDs. Catalogue/entity IDs are generated numeric identities. Composite keys are listed explicitly.

| Table | Primary key | Important foreign keys / purpose |
| --- | --- | --- |
| `identity.departments` | `department_id` | Department catalogue; unique non-empty name |
| `identity.users` | `user_id` | Optional `team_id → teams`; role/active status and fictional issuer/subject identity |
| `identity.teams` | `team_id` | `department_id → departments`; `manager_user_id → users`; unique department/name |
| `wellbeing.team_weeks` | `(team_id, week_start)` | Team and historical department FKs; Monday-based cohort and finalization |
| `private.employee_weekly_checkins` | `(user_id, week_start)` | User FK; composite team/week FK; unique nullable `response_id` and matching response/team/week FK; frozen eligibility/ownership |
| `wellbeing.wellbeing_responses` | `response_id` | Composite team/week FK and reciprocal private-owner FK; five scores and optional context; **no user_id** |
| `wellbeing.challenge_factors` | `challenge_factor_id` | Unique code and non-empty display label |
| `wellbeing.response_challenges` | `(response_id, challenge_factor_id)` | FKs to response and factor; multiple distinct choices per response |
| `operations.team_events` | `team_event_id` | Team and creator-user FKs; date/title; Manager-only FR5 creation/retrieval and evolution annotations |
| `operations.team_actions` | `team_action_id` | Optional composite source team/week FK; owner/creator user FKs; optional challenge-factor FK; Manager-only actions |
| `operations.activities` | `activity_id` | Optional department FK; HR creator FK; publication/schedule/targeting and optional aggregate insight snapshot |
| `private.activity_registrations` | `(activity_id, user_id)` | Activity/user FKs; private registration timestamp |
| `operations.psychologists` | `psychologist_id` | Provider catalogue; no application login role or clinical records |
| `operations.psychologist_slots` | `slot_id` | Provider FK; schedule, online/in-person modality and meeting details |
| `private.psychologist_bookings` | `booking_id` | Employee-user and slot FKs; independent from wellbeing responses |

Organization scope covers the department catalogue; there is no separate organization table in this single-organization MVP. Engineering contains Platform and Product; Customer Experience and People and Operations are separate departments. Managers are assigned through `teams.manager_user_id`, not through an Employee team membership.

### Important constraints and indexes

- Accounts have unique `(sso_issuer, sso_subject)` and roles `employee`, `manager`, `hr`. Employees require a team; other roles do not hold Employee membership. Triggers validate assigned Manager roles and prevent unsupported role changes.
- Cohort `week_start` must be Monday. Finalization cannot precede the next Lisbon Monday. Private membership/team-week snapshots and finalized cohorts are protected by immutability/consistency triggers; transfers do not reassign historical answers.
- All five fresh scores are `numeric(3,1) NOT NULL` with 0–10 checks. Workload is pressure and stress is independent. Workload Balance is derived, not stored; there is no composite wellbeing index. Range checks deliberately permit continuous historical scores. Optional context has a 2,000-character limit.
- The weekly ownership PK forbids a second Employee/week record. Unique `response_id` forbids shared ownership. Deferred composite and reciprocal FKs ensure every committed response has exactly one private owner in the same team/week. Submission locks the eligibility row and commits the response, challenge choices and ownership together.
- Challenges use a join-table PK to prevent repeated choices. Answers/choices and completed ownership links have mutation guards; new raw submissions are additionally validated/normalized by the API.
- Action statuses are `planned`, `in_progress`, `completed`. A challenge source requires its factor and other topics forbid that factor. Nullable source week means a general action. The database trigger enforces the assigned Manager as creator and preserves team/creator scope even when the composite source FK is null. It also permits legacy owners who are Employees in the team or have the HR role; it does not enforce Manager-only ownership for every historical row. The API authorizes only assigned Managers to create/use plans and assigns new plans to that Manager. These legacy owner relationships grant no Employee/HR API access. Legacy nullable descriptions are valid; the new-action API requires a description.
- Activity duration is positive; modality is online/in-person and publication cannot be later than scheduled start. Optional source week/value/change fields must form a valid aggregate source snapshot; department insight provenance is validated by the HR service. No individual response FK exists on an activity. Eligibility and private registration triggers enforce the existing Employee flow.
- Slots end after they start. The named format constraint requires a video URL and no location for online slots, or a location and no video URL for in-person slots. Provider/start uniqueness plus a GiST exclusion constraint reject overlapping provider slots, including concurrent insertion.
- The partial unique index on `psychologist_bookings(slot_id) WHERE status = 'booked'` prevents double-booking. Status is booked/cancelled; triggers validate Employee ownership, schedule and the two-hour change cutoff. Cancellation retains history and releases the active slot. Slots with booking history cannot be silently rewritten.
- Indexes cover Employee team lookup, Manager assignment, department/week and team/week reporting, factor/response lookup, team event dates, action status/deadline, activity scheduling/targeting and Employee-owned registrations/bookings. See `schema.sql` for exact definitions.

## Privacy and ownership

`identity.users` contains identifiable account data. `wellbeing.wellbeing_responses` contains scores/context but no direct identity; challenge selections are separate. The **private ownership bridge** can reconnect the authenticated Employee to their own history. This is pseudonymization, not irreversible anonymity; free text and small team/week cohorts can themselves be identifying.

Manager/HR requests never retrieve individual rows, ownership links, comments, selections, attendee identities or bookings. The reporting module evaluates the configured threshold (approved demo: `MIN_RESPONSES=5`), distinct respondents, missing measurements and complementary/residual disclosure checks before releasing aggregates. Repeated check-ins do not count as distinct people for privacy. Missing historical stress and historically unasked themes are unavailable, never fabricated zeros.

The schemas are namespaces, **not access-control roles**. `schema.sql` creates no database users/grants/RLS policies. Currently the trusted API enforces session/role/ownership boundaries; deployment must provision restricted database access and separate maintenance privileges. End users must not receive the database credential or direct SQL access. Psychologist bookings and activity registrations are private, even though their operational catalogues are shared.

## Fresh model versus the current historical local database

Preserve the historical local data. These known differences are not instructions to delete, reseed, rename or backfill records:

- A fresh schema requires stress for every response. The local historical database retains legacy null stress; its additional not-valid non-null check guards new writes without inventing historical answers. Existing four-score synthetic values may be continuous and must not be forced onto questionnaire categories.
- The fresh seed has eight current challenge factors. The local catalogue also retains legacy ID **6**, `tools_processes`, and its old selections. ID 6 must not be reused for a new concept. Existing IDs are preserved: Workload 1, Lack of clarity 2, Team communication 3, Lack of support 4, Work-life balance 5; new Deadlines 7, Difficulty integrating 8, Organizational changes 9.
- The local database additionally retains unused `operations.department_interventions` from an earlier implementation. It is not one of the 15 fresh-schema tables, is not recreated by current setup and is not used by the current HR workflow. Do not drop it as documentation cleanup.
- Live submissions, activities and registrations legitimately differ from the fresh fixture. At this documentation review the local database has 359 responses; the complete fresh demo command produces 358. Row counts are a dated observation, not a requirement to reconcile data. The local database has 16 tables because of the legacy table above.
- Two approved feature upgrades in `migrations/` are consolidated in the fresh schema. Use the shape check before upgrading an older database; do not blindly replay migrations after initialization. Databases predating `stress_score` require a separately reviewed upgrade, not fabricated stress.
- The base `seed.sql` and complete `db:seed:demo` are different scopes: the latter also runs the deterministic additive expansion and Manager/HR catalogue examples. Fresh complete fixtures have 58 users, 358 responses, 8 activities, 17 registrations and 5 action plans. They reproduce a scenario, not every later manual record.
- Fixture dates are anchored to the Lisbon execution week. Existing fixtures do not continually roll forward as the current week advances. Missing/unfinalized reporting cohorts remain suppressed; maintenance does not invent membership or responses. Provider/video identifiers and accounts are fictional, not live healthcare/SSO integration.

### Current verified test baseline

The current verified complete result is **243 total / 243 passed / 0 failed / 0 skipped**, verified on 20 November 2026. It includes FR5, shared initialization and the Employee check-in consistency regressions. Complete integration runs require a disposable local baseline and can perform DDL, seed fixtures and rollback writes; they are not read-only database audits. The older results below are historical observations, not current failures or the current test count.

### Documentation verification on 16 November 2026

The complete `TEAMPULSE_TEST_POSTGRES=1 npm test` run reported **196 tests: 185 passed, 11 failed, 0 skipped**. This differs from the prior 207-pass run because the calendar moved to Monday 16 November while the four 9 November team cohorts remain unfinalized. The reporting window now includes that missing release and correctly withholds latest metrics/insight sources; it does not substitute 2 November's values.

The failures are in `demo-expansion.test.js`, `hr-activities-postgres.test.js`, `reporting-consistency-postgres.test.js` (five scopes and its parent), `reporting-postgres.test.js`, `team-actions-postgres.test.js`, and `weekly-finalization.test.js`. The HR integration stops before registering its eleven nested subtests, explaining 196 rather than 207 reported tests. The finalization test assumes only its inserted cohort needs closing; on this date it finds five, including the four elapsed local cohorts, rather than one. Insight-linked action creation returns 409 because the latest source is unavailable.

This was a dated local dataset/maintenance and test-fixture assumption issue, not a documentation-induced code change. At that review, no test, reporting policy or cohort was changed to make the result green. Integration isolation was addressed by the subsequent stabilization below; operational cohort maintenance remains separate. Finalizing alone would not create missing submissions or restore eight fully measured demo weeks. Before/after row fingerprints for all 16 local tables and stored function definitions were unchanged; all 359 wellbeing responses were preserved. Rollback integration tests can still advance generated identity sequences.

**Subsequent FR5/test stabilization (historical 216-test milestone):** The reporting-dependent integrations now create/seed/drop separate `teampulse_test_*` databases with a fixed Friday 13 November 2026 clock, including test-only SQL defaults/trigger bodies. That milestone reported **216/216 passed, zero failures/skips**; the current 243-test result is recorded above. Existing assertions were retained; the eleven HR subtests are reached again, and nine FR5 tests/subtests were added. The finalization test still expects exactly its one elapsed fixture and verifies all original cohorts unchanged; this is now true of its isolated baseline. The configured demo is not finalized, reset or reseeded. Test setup requires `CREATEDB` for the test/maintenance account, never the deployed runtime identity. See [architecture](../docs/ARCHITECTURE.md#deterministic-postgresql-regression-fixtures).

## Setup and existing local additive maintenance

### Fresh dedicated database

For a **new empty dedicated database**, use the portable commands documented in
[DEPLOYMENT.md](../DEPLOYMENT.md): `npm run db:init`,
then `npm run db:migrate -- --check`. Without flags, `db:init` continues to reject
visible unrelated user tables as well as any occupied TeamPulse target schema.
The consolidated schema already includes the two feature migrations.

For a new empty dedicated Neon demo database, use its direct endpoint and the same portable setup path in `DEPLOYMENT.md`; TLS is required. Seeding is a separate development-mode maintenance step against empty TeamPulse tables. The current Neon database is already set up: these are new-installation instructions, not redeployment commands.

### Shared database, including FEUP

For a shared database such as FEUP `mesg2607`, first obtain administrator
confirmation that `identity`, `private`, `wellbeing`, and `operations` are
available and reserved for TeamPulse. Configure maintenance connection variables
privately, then the future manual initialization command is:

```sh
npm run db:init -- --shared
```

PowerShell may require `npm.cmd run db:init -- --shared`. This flag changes only
initialization's database-emptiness precondition; it does not select a host or
database and is invalid for migrations/seeding. The default path remains unchanged.

Unrelated tables in `public` and other schemas are allowed because TeamPulse
uses explicit schema-qualified application names. Before application DDL, the
runner checks all four target names in `pg_catalog.pg_namespace`, not only
permission-filtered `information_schema` views. **Any occupied target schema,
including an empty or differently owned schema, causes refusal.** No existing
namespace is reused, altered, dropped or renamed to resolve a collision.

The unchanged `schema.sql` body creates the four schemas and their 15 tables in
one transaction under the setup advisory lock. Shared initialization sets a
trusted transaction-local search path; commit/rollback restores the prior path.
An error after partial creation rolls back this attempt's TeamPulse objects.
The command leaves unrelated data, ownership, indexes and sequences untouched.
Existing schema permissions still require separate administrator review; schema
names are namespaces, not a replacement for access controls.

**Shared initialization does not run migrations, demo seed/expansion, or weekly
finalization, and inserts no application records. Do not seed/expand the FEUP
database as part of this procedure.** No FEUP access is performed by the tooling
tests: they use disposable loopback PostgreSQL databases only. The tests cover
fresh setup, shared setup with preserved unrelated objects, all four occupied
namespaces (empty and populated), partial-creation rollback, and safe refusal
against a populated TeamPulse fixture.

### Existing local demo maintenance

For a new dedicated local fictional demo only, `npm run db:seed:demo` adds the
existing expansion and Manager/HR catalogue examples atomically after fresh setup.
The instructions below retain the original local additive-maintenance workflow;
they are not a command to reset or reseed an existing or shared FEUP database.

Use only the local `teampulse` database. This is invented demonstration data,
not employee information, clinical evidence, or a production backfill.

Use the portable `db:init` / `db:seed:demo` workflow above for a fresh checkout;
the complete seed already includes expansion. For an existing local database,
**do not rerun schema.sql or seed.sql**. Configure the usual `.env` values and
keep `MIN_RESPONSES=5`.

```powershell
node db/expand-demo.cjs --dry-run
node db/expand-demo.cjs --apply
```

The dry run builds and validates the complete dataset inside a transaction and
rolls it back. Apply commits only after preservation checks and real aggregate
reporting checks succeed. Reapplying is a verified no-op: it neither duplicates
people/responses nor overwrites them. A partial or conflicting expansion fails.
The first run anchors to the current Lisbon Monday and the preceding eight
finalized weeks. Reruns retain that anchor; this is a presentation fixture, not
a scheduler that continually modifies historical populations.

The expansion adds 28 visibly fictional accounts (12 Engineering, 8 Customer
Experience, 8 People and Operations), 224 eligibility records, and 192 responses.
Existing accounts, responses, choices, weeks, activities, plans, registrations,
events and bookings are preserved. The original local population was already
14/8/2 employees; the resulting departments contain 26/16/10 employees. Keeping
the old records and collecting five **new stress answers in each Engineering
team** requires exceeding an 8–12 total-person target for Engineering.

Participation rotates. Each team has at least five new stress answers per week.
Scores and choices are deterministic for each fictional subject and relative
week, using the approved raw questionnaire normalization. Independent offsets
provide variation around a stable start, mid-period workload/stress increase,
and partial recovery. Department challenge distributions differ. Response UUIDs
remain random and independent of identity; reproducibility concerns the people,
eligibility, answers and choices, not regenerated identifiers.

Finalized cohorts reject ordinary inserts. This explicitly requested historical
demo import therefore uses a **transaction-local manifest** and a narrowly
scoped INSERT exception in the two existing immutability functions. Role and
membership checks, challenge immutability, foreign keys and weekly uniqueness
remain active. No trigger is disabled, no cohort is reopened, and no existing
row is updated. The original function definitions are restored and compared
before commit; rollback also restores them automatically. Concurrent ordinary
writers are blocked during maintenance. No import exception or new database
function remains afterward. Aggregation/privacy code is never modified.

Every run saves a complete pre-run JSON snapshot in the operating system's
temporary directory and prints its path. **The snapshot includes private
fictional ownership links and comments. Keep it outside public/ and version
control.** Retain the path when auditing preservation. Compare original rows
as well as counts; adding rows necessarily changes a whole-table fingerprint.

Run all PostgreSQL integrations sequentially against a **separately initialized,
seeded disposable local baseline**, so maintenance/feature fixtures do not compete
for table locks. Explicitly configure `DB_HOST` to loopback and `DB_NAME` to that
disposable database in the test shell first. Never select Neon, FEUP, the existing
local demo database or real employee data. The test identity needs DDL and
`CREATEDB` privileges. Some tests create/seed/drop additional isolated databases;
others roll back writes but can advance sequences in the configured baseline:

```powershell
$env:TEAMPULSE_TEST_POSTGRES='1'
# DB_* must already select the disposable local baseline described above.
# Historical live snapshots must not be compared with disposable test fixtures.
Remove-Item Env:TEAMPULSE_DEMO_BASELINE -ErrorAction SilentlyContinue
node --test --test-concurrency=1
```

The rollback-only feature tests exercise submissions, action plans, HR activity
publication and Employee support without retaining those test records. Reporting
and FR5 tests use a fixed-clock fresh fixture; historical missing-score and
small-cohort privacy cases remain covered by separate assertions and unit fixtures.
Unset `TEAMPULSE_TEST_POSTGRES` or set it to `0` for non-database verification;
PostgreSQL integrations then report skips. A no-DDL/no-seed/no-database-writes
task cannot reproduce the complete 243-test run safely.

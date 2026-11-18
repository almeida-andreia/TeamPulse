# TeamPulse — Claude Code Instructions

## 1. Project Context

TeamPulse is a privacy-first employee wellbeing web application developed for the Information Systems Architecture course.

The product has three roles:

- Employee
- Manager
- HR

`SPEC.md` defines the approved product requirements and MVP scope.

`AGENTS.md` contains the general project development and privacy guidelines and must always be respected.

When these instructions overlap, preserve the stricter privacy, security and product-scope rule.

---

## 2. Current Implementation Stack

The current local implementation uses:

- Node.js
- Express
- PostgreSQL
- HTML
- CSS
- Vanilla JavaScript
- SVG charts
- Built-in `node:test` + Supertest for testing

The PostgreSQL database is currently running locally during development.

The repository already contains:

- `db/schema.sql`
- `db/seed.sql`
- `server/`
- `public/`
- `tests/`
- `SPEC.md`
- `AGENTS.md`
- `docs/mockups/`

Do not migrate the application to PHP or another backend stack unless explicitly requested.

The final FEUP deployment environment may require additional configuration. Deployment-specific decisions must not cause unnecessary changes to the local implementation.

---

## 3. Source of Truth

Use the following order when making implementation decisions:

1. `SPEC.md` — product requirements and MVP scope
2. `AGENTS.md` — project-wide development and privacy rules
3. `docs/mockups/` — visual source of truth
4. Database schema and existing implementation
5. `CLAUDE.md`

If requirements conflict or are ambiguous, STOP and explain the conflict before making a destructive or architectural change.

Do not invent product functionality.

---

## 4. Mockups

All mockups are stored in:

`docs/mockups/`

The mockups are the visual source of truth for the TeamPulse interface.

Do not redesign the application unnecessarily.

When implementing a screen:

- preserve the layout;
- preserve the information hierarchy;
- preserve the navigation structure;
- preserve the visual language;
- preserve the wording where appropriate;
- reproduce cards, buttons, badges, charts, forms and states as closely as reasonably possible.

Do not create additional screens unless required by `SPEC.md` or explicitly requested.

The mockups are desktop-oriented. Do not invent a separate mobile design unless explicitly requested.

---

## 5. Privacy and Data Access

Privacy is a core product requirement.

### Employee

Employees may access:

- their own check-in history;
- their own wellbeing trends;
- their own activity registrations;
- their own psychologist bookings.

### Manager

Managers may access only aggregated information for their authorized team.

Managers must never receive:

- individual employee responses;
- individual wellbeing scores;
- individual comments;
- individual challenge selections;
- personally identifiable wellbeing information.

### HR

HR may access only aggregated organization or department information.

HR must never receive identifiable individual wellbeing responses.

### Critical rule

Never implement a frontend-only privacy restriction.

Privacy and role authorization must be enforced by the backend/API.

Never rely on hidden buttons, disabled links or browser-side role checks as the only protection.

---

## 6. Authentication and Authorization

The prototype authentication screen may contain role-selection controls for demonstration purposes.

However, role selection in the browser must never be treated as trusted authorization.

The backend must determine the authenticated user's role and enforce access accordingly.

Every role-specific API endpoint must verify authorization server-side.

---

## 7. Database

The PostgreSQL database is the source of persisted application data.

Do not replace persisted functionality with permanent mock data.

Mock/demo data may be used temporarily during UI development, but MVP functionality requiring persistence must use PostgreSQL.

Do not modify `db/schema.sql` or database architecture casually.

Before changing the schema:

1. Identify the requirement requiring the change.
2. Explain why the current schema cannot support it.
3. Check the impact on `seed.sql`, API logic and privacy.
4. Make the smallest appropriate change.
5. Verify the database after the change.

Never delete or reset database data without explicit instruction.

---

## 8. Employee Check-in

The Employee check-in is a four-step flow.

The UI must follow the Assignment 1 mockups.

The current intended information is:

### Step 1 — Overall Wellbeing

Five categorical responses:

- Very positive
- Positive
- Neutral
- Struggling
- Very difficult

### Step 2 — Workload & Stress

Workload:

- Very manageable
- Manageable
- Difficult
- Very difficult

Stress:

- 1–5 scale

### Step 3 — Team Connection

Team connection:

- Very connected
- Connected
- Distant
- Disconnected

Psychological safety:

- 1–5 scale

### Step 4 — Current Challenges

The current challenge catalogue contains:

- Workload
- Deadlines
- Team communication
- Difficulty integrating
- Lack of clarity
- Lack of support
- Work-life balance
- Organizational changes

The employee may also provide optional context.

The check-in must:

- preserve answers while navigating between steps;
- validate required answers;
- allow back/continue navigation;
- prevent invalid submissions;
- submit atomically;
- enforce one submission per employee per week;
- display a confirmation state after successful submission.

Do not expose optional employee comments in Manager or HR dashboards.

---

## 9. API and Frontend Separation

Keep presentation and data access separate.

Frontend code should not contain database credentials or direct PostgreSQL queries.

Use:

Browser
→ Express API
→ Services/data access
→ PostgreSQL

Do not bypass the API from the browser.

Where practical, keep business logic such as:

- aggregation;
- privacy suppression;
- authorization;
- weekly eligibility;
- booking validation

outside the frontend.

---

## 10. Reusable Components

Prefer reusable components and shared styles for:

- application shell;
- sidebar;
- header;
- privacy badges;
- metric cards;
- activity cards;
- insight cards;
- buttons;
- check-in controls;
- progress indicators;
- status badges;
- confirmation states;
- charts;
- modals;
- forms.

Do not duplicate the same component unnecessarily across Employee, Manager and HR screens.

---

## 11. Data Calculations

Do not invent calculations silently.

For derived metrics such as:

- wellbeing averages;
- trends;
- response rates;
- challenge percentages;
- areas requiring attention;
- department comparisons;

document the calculation before implementing it if the rule is not already defined in `SPEC.md`.

Do not hard-code a minimum privacy threshold such as five responses unless explicitly approved.

The privacy suppression threshold must remain configurable.

---

## 12. Development Workflow

Implement one coherent user flow at a time.

For each feature:

1. Inspect the relevant specification and mockup.
2. Inspect the existing implementation.
3. Identify the required API/data changes.
4. Implement the smallest complete change.
5. Run automated tests.
6. Run the application.
7. Test the affected user flow manually.
8. Check authorization and privacy.
9. Compare the result with the relevant mockup.
10. Report what changed and what remains.

Do not rewrite unrelated files.

Do not make large architectural changes without explicit approval.

---

## 13. Testing

Every significant backend feature should have automated tests.

Prioritize tests for:

- authentication;
- role authorization;
- weekly check-in submission;
- one-submission-per-week rule;
- aggregation;
- privacy suppression;
- employee history ownership;
- psychologist booking rules.

A feature is not considered complete until its relevant tests pass.

---

## 14. Security

Never:

- hard-code passwords;
- hard-code database credentials;
- expose `.env` values;
- log passwords;
- expose private employee wellbeing responses;
- trust role information supplied only by the browser;
- implement privacy only through frontend controls.

Use environment variables for credentials.

---

## 15. Scope Control

The MVP should remain aligned with `SPEC.md`.

Do not add:

- clinical diagnosis;
- burnout prediction;
- employee performance scoring;
- automated clinical decisions;
- individual wellbeing monitoring by managers;
- individual wellbeing monitoring by HR.

Psychologist booking is currently lower priority than the core Employee, Manager and HR flows.

If time is limited, prioritize the core flows before optional functionality.

---

## 16. Communication Before Changes

If you discover a conflict between:

- `SPEC.md`;
- `AGENTS.md`;
- mockups;
- database schema;
- existing code;

do not silently choose an interpretation when the decision affects product behavior, privacy or architecture.

Explain the conflict and propose the smallest reasonable resolution before making a destructive or architectural change.

When a change is straightforward and non-destructive, proceed and report it clearly.

---

## 17. Definition of Done

A feature is considered complete only when:

- it matches the relevant mockup;
- it satisfies the relevant requirement;
- it uses the correct role permissions;
- privacy requirements are enforced server-side;
- persisted data uses PostgreSQL where required;
- relevant automated tests pass;
- the affected flow works manually;
- no unrelated functionality has been broken.

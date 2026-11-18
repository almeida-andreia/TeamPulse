# TeamPulse — Product Specification

## 1. Product Overview

TeamPulse is a privacy-first employee wellbeing platform designed to help organizations understand employee wellbeing, identify team-level challenges and connect employees with appropriate support.

The platform connects three user roles:

- Employee
- Manager
- Human Resources (HR)

The product follows the principle:

> Listen. Understand. Support.

The system must protect employee privacy while providing organizations with useful aggregated wellbeing insights.

---

## 2. Value Proposition

TeamPulse helps organizations protect team productivity by detecting early signs of declining employee wellbeing, turning anonymous feedback into actionable team insights, and connecting employees with relevant support without compromising privacy.

The platform is designed to make wellbeing information actionable rather than simply collecting survey responses.

---

## 3. Users

### 3.1 Employee

Employees can:

- Complete a short anonymous weekly wellbeing check-in.
- View their own wellbeing evolution over time.
- Access relevant activities and support.
- Book a confidential psychologist session.

Employees must never be individually exposed to managers or HR through wellbeing responses.

### 3.2 Manager

Managers can:

- View aggregated team wellbeing indicators.
- Identify changes and recurring team challenges.
- View areas that need attention.
- Create and track team action plans.

Managers cannot access individual employee responses.

### 3.3 Human Resources

HR can:

- View organization-wide wellbeing trends.
- Compare aggregated wellbeing indicators across departments.
- Monitor platform participation.
- Publish wellbeing workshops and activities.

HR cannot identify individual employees through wellbeing responses.

---

## 4. MVP Scope

The first version of TeamPulse will focus on the following core functionality:

### Employee

1. Authentication
2. Weekly anonymous check-in
3. Check-in confirmation
4. Personal wellbeing history
5. Support and activities
6. Psychologist session booking

### Manager

1. Manager authentication
2. Aggregated team dashboard
3. Team wellbeing trends
4. Areas requiring attention
5. Team action plans

### HR

1. HR authentication
2. Organization wellbeing dashboard
3. Department-level aggregated insights
4. Participation monitoring
5. Activity creation and publication

### 4.1 Approved academic MVP decisions

This specification includes the approved refinements to the Assignment 1 prototype. It describes the current academic MVP; implementation gaps are explicitly identified below rather than removed from scope.

- **Demo Access replaces real SSO for this MVP.** The professor chooses an existing fictional account and enters a server-authenticated session without a password or contact with Microsoft/FEUP. `DEMO_AUTH_ENABLED=true` explicitly enables it; it defaults off, including production. This is not authentication for real employees. Future verified identity integration is separate.
- Presentation accounts are Beatriz Sousa (`employee-05`, Employee), Mara Duarte (`manager-platform`, Manager), and Marta Pinto (`hr-marta`, HR). Their existing database roles and scopes remain authoritative; selecting a role does not grant additional permissions.
- **Engineering is a department; Platform is a team within Engineering.** The Manager sees Platform only, not every Engineering team. HR sees organization/department aggregates for Engineering, Customer Experience, and People and Operations; HR has no team-level drill-through.
- **Action Plans belong to Managers only.** HR uses Insights & Activities and cannot access Manager Action Plans. HR interventions use the existing activities entity, not a separate intervention feature/table.
- PostgreSQL is the persistence source for check-ins, history, Action Plans, activities, registrations and psychologist bookings. Explicit browser-only preview adapters are not a fallback for a failed API/database connection.
- US4 remains a **Could** priority in the original scope, but its booking flow is implemented in this MVP.

### 4.2 Questionnaire and score meanings

The four steps collect five independent measures, plus optional challenges/context. New raw answers are validated and normalized on the server using the shared questionnaire contract. No combined wellbeing index or diagnosis is calculated.

| Measure / stored field | Approved input → 0–10 score | Direction |
| --- | --- | --- |
| Overall wellbeing / `wellbeing_score` | Very positive 10; Positive 7.5; Neutral 5; Struggling 2.5; Very difficult 0 | Higher is better |
| Workload pressure / `workload_score` | Very manageable 0; Manageable 3.3; Difficult 6.7; Very difficult 10 | Higher is worse |
| Stress / `stress_score` | Ratings 1, 2, 3, 4, 5 → 0, 2.5, 5, 7.5, 10 | Higher is worse |
| Team connection / `team_integration_score` | Very connected 10; Connected 6.7; Distant 3.3; Disconnected 0 | Higher is better |
| Psychological safety / `psychological_safety_score` | Ratings 1, 2, 3, 4, 5 → 0, 2.5, 5, 7.5, 10; ease of asking for help | Higher is better |

Manager/HR **Workload Balance = 10 − average(workload_score)**, derived from the unrounded mean and then rounded for display. It is not stored. Higher Balance is better; higher raw workload pressure is worse. Historical continuous scores remain valid. Missing historical stress is null/unavailable, never zero, estimated or inferred from workload.

The eight challenge choices are Workload, Deadlines, Team communication, Difficulty integrating, Lack of clarity, Lack of support, Work-life balance, and Organizational changes. Multiple or no challenges may be selected. Optional comments are limited to 2,000 characters and are never disclosed to Manager/HR.

### 4.3 Calendar, reporting and privacy policy

- The calendar is **Europe/Lisbon**. A check-in week begins Monday. Submission opens Friday 00:00 and closes the following Monday 00:00 (Friday–Sunday); the server enforces the window and one submission per Employee/week.
- The Home monthly count uses the check-in week's Monday, not a submission timestamp. Its display is capped at 4/4; an eligible fifth week can still be submitted. Changing the history period does not change this month's count.
- Manager/HR reporting uses the latest eight **completed** Monday-based weeks and finalized cohorts only. Missing/unfinalized weeks stay unavailable; an older safe week is not substituted for the latest week. Closing elapsed cohorts is an explicit maintenance operation, not an automatic startup write.
- The Manager release covers only the assigned team. HR releases cover departments or the organization, with historical membership from team/week snapshots. Averages use response sums/counts, not unweighted averages of team averages. Missing stress is excluded from that measure, with its own availability checks.
- KPI values use the latest completed week. Monthly changes compare available finalized responses in that week's calendar month with the preceding calendar month within the reporting window. Scores/changes are rounded to one decimal; participation is completed check-ins / frozen eligible Employees, rounded to a percentage. Participation availability is evaluated independently of score availability.
- The minimum-response threshold is configurable backend policy, **currently approved as `MIN_RESPONSES=5`**; five was not an original Assignment requirement. Missing/invalid configuration fails closed. Small cohorts, incomplete scope coverage and complementary/residual disclosure checks can suppress results even when a headline total exceeds five. Suppressed values must not be reconstructed by subtracting visible departments from organization totals.
- **Shared Themes** first aggregates the eight completed weeks. A percentage means the share of measured responses/check-ins selecting that factor, not a share of diagnosed people. Multiple selections mean percentages need not sum to 100%. Privacy checks include distinct respondents, selectors/non-selectors and complementary groups; repeat submissions by one person are not multiple people for privacy purposes.
- A historically unasked factor is not a zero selection. The current compatibility rule uses the five-answer questionnaire's non-null stress as provenance for the three newly introduced factors. Unsafe/unasked themes are not presented as percentages; explanatory empty states preserve this distinction.
- Manager/HR APIs return approved aggregates only: no ownership links, respondent lists, individual answers, comments, activity attendee lists or psychologist bookings. Namespaces alone are not database access control: this is pseudonymized storage with a protected ownership bridge, not irreversible anonymization. Runtime database credentials must remain restricted to the trusted API.

---

## 5. User Stories

### US1 — Anonymous Weekly Check-in

**Priority:** Must

As an employee, I want to complete a short anonymous weekly check-in so that I can share my workplace experience safely.

Acceptance criteria:

- The check-in contains 4 steps:
  1. Wellbeing
  2. Workload and stress
  3. Team connection and psychological safety
  4. Current challenges
- A progress bar is displayed.
- Estimated completion time is approximately 2 minutes.
- The employee can return to previous steps.
- "Your response is anonymous" is displayed on every step.
- The employee can optionally provide a free-text comment.
- A confirmation screen is shown after submission.
- An employee can submit only one check-in per week.
- Submission is available Friday–Sunday in Lisbon, as defined in section 4.3.

---

### US2 — Personal Wellbeing History

**Priority:** Should

As an employee, I want to see my wellbeing evolution over time so that I can reflect on changes in my work experience.

Acceptance criteria:

- The employee can see all five independent measures in section 4.2; history and its five pillars remain private to that Employee.
- Indicators are scored out of 10.
- Monthly change is displayed.
- A trend chart compares wellbeing and workload.
- Core wellbeing pillars have level labels.
- The employee can select a period:
  - 30 days
  - Quarter
  - Year to date
- The employee can export a personal summary.
- This information is visible only to the employee.

---

### US3 — Support and Activities

**Priority:** Should

As an employee, I want to access relevant activities and support so that I can choose resources that may help me.

Acceptance criteria:

- The support page displays featured and upcoming activities.
- Each activity contains:
  - Type
  - Duration
  - Format
- Employees can register for an activity.
- The MVP presents eligible featured/upcoming support. The current featured/recommended presentation does not infer personalized recommendations from private answers.
- The support page is reachable from the main navigation in two clicks or fewer.
- Only already-published, eligible activities whose scheduled start has not passed are available. Targeting is organization-wide or the Employee's department. Past activities remain in HR's history and PostgreSQL; existing registrations are retained but stop generating upcoming Home reminders.
- Employees can register once per activity and cancel their own upcoming registration. Upcoming registrations appear as calendar-style Home reminders; HR receives counts, not attendee identities.

---

### US4 — Psychologist Session

**Priority:** Could

As an employee, I want to book a confidential psychologist session so that I can request personal support when I need it.

Acceptance criteria:

- The employee can select an available session.
- Sessions can be online or in person.
- The employee confirms the psychologist, date and time.
- A confirmation is displayed after booking.
- A video link is displayed for online sessions.
- The employee can add the session to their calendar.
- The employee can reschedule or cancel up to 2 hours before the session.
- The booking page clearly states that the session is not shared with the employee's manager.
- Availability, booking, rescheduling, cancellation, history and upcoming Home reminders use the authenticated Employee's PostgreSQL records. Browser demo bookings do not feed the live Home reminders.
- Only future scheduled bookings produce Home reminders. Past/cancelled records remain private history. Slot conflicts are rejected atomically; no booking is linked to wellbeing responses. Demo video URLs are fictional, not live clinical services.

---

### US5 — Aggregated Team Wellbeing

**Priority:** Must

As a manager, I want to see aggregated team wellbeing so that I can understand how my team is doing.

Acceptance criteria:

- The dashboard displays:
  - Wellbeing
  - Workload Balance (derived from workload pressure)
  - Stress, when measured and safely available
  - Team integration
  - Psychological safety
- Indicators are scored out of 10.
- The dashboard displays the number of anonymous responses.
- Monthly change is displayed.
- An 8-week evolution is available.
- No individual response can be identified.

---

### US6 — Team Challenges

**Priority:** Must

As a manager, I want to identify changes and recurring challenges so that I can respond before problems escalate.

Acceptance criteria:

- The evolution chart can be annotated with team events.
- Areas requiring attention are flagged when a topic has a negative trend.
- The dashboard shows the share of responses for relevant challenge factors.
- Managers can access suggested actions.
- Suggested actions lead to the action plan.

**Implemented team context:** The Manager can add a dated team event and see authorized events in the eight completed evolution weeks. Teal chart markers and a dated title list associate events with their Monday cohort, independently of score availability. Multiple events in one week share a marker. This follows the Assignment 1 `docs/mockups/manager-overview-trends.png` event context without redesigning the chart. Events do not alter scores, calculations or attention signals and are not exposed to Employee/HR. Only a team title/date is collected; the form instructs the Manager not to include names or individual wellbeing information. Event editing/deletion is not part of this flow.

---

### US7 — Team Action Plans

**Priority:** Should

As a manager, I want to create and track team action plans so that insights lead to concrete action.

Acceptance criteria:

- An action can be linked to a safely released team insight or created as a general team action without claiming a measured source.
- Each action contains:
  - Title
  - Owner
  - Deadline
  - Status
- Status can be:
  - Planned
  - In progress
  - Completed
- Managers can create actions through a dedicated form.
- Action plans are visible only to the authorized team Manager; HR and Employees cannot access them.
- New actions require a description; the owner is the team's authorized Manager. Existing legacy actions without descriptions remain valid. Month filters retain historical plans.

---

### US8 — Organization Wellbeing

**Priority:** Must

As HR, I want to see organization-wide wellbeing trends so that I can identify broader priorities.

Acceptance criteria:

- The HR dashboard displays:
  - Wellbeing
  - Team integration
  - Workload Balance
  - Stress, when measured and safely available
  - Psychological safety
  - Response rate
- Results can be broken down by department.
- Priority signals highlight the main themes requiring attention.
- Departments with too few responses show "Insights unavailable".

---

### US9 — Participation

**Priority:** Must

As HR, I want to monitor organization/department participation so that I can understand platform adoption without identifying respondents.

Acceptance criteria:

- Overall response rate is displayed as a percentage.
- HR sees organization/department participation; the Manager sees participation only for the assigned team.
- The system never shows who did or did not respond.
- Participation has its own threshold and complementary-disclosure checks; unavailable scores do not automatically hide otherwise safe participation.

---

### US10 — Wellbeing Activities

**Priority:** Should

As HR, with support from psychologists, I want to publish workshops and activities so that employees can access targeted support.

Acceptance criteria:

- HR can create an activity with:
  - Title
  - Description
  - Date
  - Duration
  - Format
  - Target audience
- Publishing makes a future activity visible to eligible Employees once its publication time is reached; department targeting and scheduled-start expiry still apply.
- Insights can suggest an intervention.
- HR can access the activity creation form from the relevant insight.
- The same form supports a general activity without an insight source. Insight-linked activities use a safely released adverse department metric snapshot obtained server-side, not individual answers. Organization-wide scope does not expose team metrics or bypass privacy.
- HR can edit/manage draft and published activities and view past activities through the Month filter. Draft/upcoming/in-progress/completed labels derive from publication and scheduling; expiry never deletes activities or registrations.

---

## 6. Functional Requirements

### FR1 — Authentication

For the academic MVP, the system shall use explicitly enabled Demo Access with the three existing fictional accounts (section 4.1), create a server session and show each role only its authorized views. Real company/FEUP SSO is not implemented. Future verified authentication must preserve the same server-side session and authorization boundary.

Applies to:

- Employee
- Manager
- HR

---

### FR2 — Weekly Check-in

The system shall present a weekly check-in in four steps:

1. Overall wellbeing
2. Workload and stress
3. Team connection
4. Current challenges

The system shall allow one submission per employee per Monday-based week, during Friday–Sunday in Europe/Lisbon. Five required raw answers are normalized according to section 4.2; challenge selections and optional context complete the fourth step.

---

### FR3 — Privacy and Anonymity

The system shall store wellbeing responses separately from employee identity and share only aggregated results with managers and HR.

Individual wellbeing responses must never be exposed to managers or HR.

---

### FR4 — Manager Dashboard

The system shall show managers aggregated team indicators including:

- Wellbeing
- Workload Balance (derived, not stored)
- Stress, when measured and safely available
- Team integration
- Psychological safety
- Number of responses
- Monthly change

---

### FR5 — Team Trends

The system shall show:

- An 8-week trend chart.
- Areas requiring attention.
- Share of responses per challenge factor.
- Relevant team events or annotations.

The approved implementation reuses `operations.team_events` through Manager-only creation/retrieval and evolution annotations. The server restricts events to assigned teams and the displayed completed-week window. Event titles/date/week are team context, never an input to reporting formulas or new wellbeing insights.

---

### FR6 — Action Plans

The system shall allow managers to create and track team actions.

Action Plans are Manager-only, scoped to their assigned team, and may be insight-linked or general. HR uses wellbeing activities instead.

Each action shall contain:

- Title
- Owner
- Deadline
- Status

Valid statuses:

- Planned
- In progress
- Completed

---

### FR7 — HR Dashboard

The system shall show HR:

- Organization wellbeing indicators.
- Response rate.
- Department-level aggregated results.

The system shall not reveal individual employee responses or identities.

---

### FR8 — Personal Wellbeing History

The system shall allow employees to view their own wellbeing evolution over time.

This information must not be accessible to managers or HR.

---

### FR9 — Employee Support

The system shall display relevant activities and support resources on the employee support page.

For this MVP, support lists use publication, future scheduled start and department eligibility, not automated analysis of private check-in answers. Registration and cancellation are Employee-owned. Expired registrations remain historical and do not appear as upcoming reminders.

---

### FR10 — Psychologist Booking

The system shall allow employees to view available psychologist sessions and book, reschedule or cancel a session according to the defined rules.

Booking information must remain confidential.

The implemented Could-priority flow uses PostgreSQL for available slots, Employee-owned bookings and Home reminders. Only the owner can see confirmation/video details or change a booking. Rescheduling/cancellation is permitted until two hours before the original session; occupied/past slots are rejected. Cancellation retains the historical row, and booking data is independent from wellbeing data.

---

### FR11 — HR Activities

The system shall allow HR to create and publish wellbeing activities that become visible on the employee support page.

---

## 7. Privacy Principles

Privacy is a core product requirement.

The system must follow these principles:

1. Employees must not be individually monitored through wellbeing data.
2. Managers must only see aggregated team information.
3. HR must only see aggregated organizational or department information.
4. Individual check-in answers must not be displayed to managers or HR.
5. Departments with insufficient responses must not display wellbeing insights.
6. Employee personal wellbeing history is private.
7. Psychologist bookings are confidential.
8. The system must not diagnose mental health conditions.

---

## 8. Out of Scope for the MVP

The first version will not:

- Diagnose mental health conditions.
- Evaluate employee performance.
- Allow managers to inspect individual wellbeing responses.
- Allow HR to identify individual respondents.
- Automatically provide clinical treatment.
- Replace a psychologist or other healthcare professional.
- Implement advanced predictive burnout diagnosis.

---

## 9. Main User Flows

### Employee

Login
→ Home
→ Weekly Check-in
→ Submission
→ Personal Wellbeing History
→ Support & Activities
→ Psychologist Booking

### Manager

Login
→ Team Dashboard
→ Trends & Areas of Attention
→ Suggested Actions
→ Action Plan

### HR

Login
→ Organization Dashboard
→ Department Insights
→ Participation
→ Create & Publish Activity

---

## 10. MVP Success Criteria

The MVP will be considered functional when:

1. An employee can authenticate and complete a weekly check-in.
2. The check-in is persisted in the database.
3. The employee can view their own wellbeing history.
4. Managers can view aggregated team-level insights.
5. Managers cannot access individual responses.
6. HR can view aggregated organization-level insights.
7. HR can publish an activity visible to employees.
8. An employee can request/book a psychologist session.
9. The main user flows work without relying on hard-coded production data.
10. The application respects the privacy rules defined in this specification.

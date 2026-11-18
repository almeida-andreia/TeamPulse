# TeamPulse — Development Guidelines

## 1. Project Context

TeamPulse is a privacy-first employee wellbeing web application developed for the Information Systems Architecture course.

The application has three user roles:

- Employee
- Manager
- HR

The product specification is defined in `SPEC.md`.

`SPEC.md` is the source of truth for product requirements and MVP scope.

---

## 2. Technology Stack

The current application uses:

- Node.js
- Express
- PostgreSQL
- HTML
- CSS
- JavaScript

Development should initially be performed locally.

FEUP deployment requires confirmation of Node.js/Express hosting and the infrastructure described in `DEPLOYMENT.md`. Do not change the stack without explicit approval.

---

## 3. Core Development Rules

### Rule 1 — Follow SPEC.md

Do not introduce new product functionality unless explicitly requested.

Always check `SPEC.md` before implementing a feature.

### Rule 2 — Privacy First

Never expose individual wellbeing responses to:

- Managers
- HR

Managers must only receive aggregated team-level information.

HR must only receive aggregated organization or department-level information.

### Rule 3 — No Mental Health Diagnosis

TeamPulse is a wellbeing support and monitoring platform.

It must never claim to diagnose:

- burnout
- depression
- anxiety
- or other mental health conditions.

### Rule 4 — No Fake Production Data

Mock data may be used during UI development.

However, MVP functionality that requires persistence must ultimately use the PostgreSQL database.

### Rule 5 — Preserve the Product Roles

Employee, Manager and HR must have separate views and permissions.

A user must never access another role's dashboard.

### Rule 6 — Keep the UI Consistent

Follow the visual language established in the Assignment 1 prototype:

- Calm visual language
- Clean layouts
- Accessible typography
- Clear information hierarchy
- Privacy-focused messaging
- Consistent TeamPulse branding

### Rule 7 — Small Changes

Implement one feature or user flow at a time.

Do not rewrite unrelated parts of the application.

### Rule 8 — Verify Before Continuing

After implementing a feature:

1. Run the application.
2. Test the affected flow.
3. Check for errors.
4. Confirm the requirement is satisfied.
5. Only then continue to the next feature.

### Rule 9 — Database

Database tables and relationships must follow the data model defined for TeamPulse.

Do not create unnecessary tables or duplicate data without a clear requirement.

### Rule 10 — Security

Never hard-code passwords or database credentials into source code.

Use configuration/environment variables where appropriate.

---

## 4. Development Priority

Implement features in this order:

### Priority 1
Employee authentication and basic navigation.

### Priority 2
Employee weekly check-in.

### Priority 3
Persist check-in data.

### Priority 4
Employee wellbeing history.

### Priority 5
Manager aggregated dashboard.

### Priority 6
Manager action plans.

### Priority 7
HR dashboard.

### Priority 8
Activities and psychologist booking.

### Priority 9
Testing and deployment.

---

## 5. Out of Scope

Do not implement:

- Individual wellbeing monitoring by managers.
- Individual wellbeing monitoring by HR.
- Mental health diagnosis.
- Employee performance evaluation based on wellbeing.
- Automated clinical decisions.
- Predictive burnout diagnosis.

---

## 6. Code Quality

Prefer:

- Simple and readable code.
- Reusable JavaScript modules and UI components.
- Clear naming.
- Separation between presentation, logic and database access.
- Accessible HTML.
- Responsive layouts.

Avoid:

- Unnecessary frameworks.
- Duplicate code.
- Hard-coded production credentials.
- Unnecessary dependencies.
- Large changes without verification.

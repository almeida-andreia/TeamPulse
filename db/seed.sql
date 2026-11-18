-- TeamPulse LOCAL DEMONSTRATION DATA ONLY. All people and answers are fictional.
-- Run once AFTER schema.sql against an empty application database. No existing
-- data is deleted or overwritten. This is not a production identity import.
-- Demo SSO subjects are identifiers, not credentials or working login accounts.
-- Dates are relative to the Monday of the execution week in Europe/Lisbon.
-- Eight complete weeks + the current open week support trends and a new check-in.
-- Response UUIDs are random; never derive a production response ID from a user.
-- Challenge labels match the approved eight-choice questionnaire.
-- Existing four-score fixture formulas intentionally remain continuous.
-- Stress answers are generated independently ONLY for these fresh fictional rows;
-- this is not a migration or a backfill of previously stored responses.
-- No privacy threshold is set: configure it in the later reporting/access layer.
-- Individual demo answers and ownership links must still stay out of dashboards.

BEGIN;
SET LOCAL TIME ZONE 'Europe/Lisbon';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM identity.departments)
        OR EXISTS (SELECT 1 FROM identity.users)
        OR EXISTS (SELECT 1 FROM wellbeing.challenge_factors)
        OR EXISTS (SELECT 1 FROM operations.psychologists) THEN
        RAISE EXCEPTION 'Seed data requires empty TeamPulse tables; existing data will not be overwritten';
    END IF;
END;
$$;

INSERT INTO identity.departments (department_id, name) VALUES
    (1, 'Engineering'),
    (2, 'Customer Experience'),
    (3, 'People and Operations');

INSERT INTO identity.users (user_id, sso_issuer, sso_subject, display_name, role) VALUES
    ('00000000-0000-4000-8000-000000000101', 'https://sso.example.invalid', 'manager-platform', 'Mara Duarte', 'manager'),
    ('00000000-0000-4000-8000-000000000102', 'https://sso.example.invalid', 'manager-product', 'Bruno Reis', 'manager'),
    ('00000000-0000-4000-8000-000000000103', 'https://sso.example.invalid', 'manager-customer', 'Teresa Azevedo', 'manager'),
    ('00000000-0000-4000-8000-000000000104', 'https://sso.example.invalid', 'manager-operations', 'Nuno Faria', 'manager'),
    ('00000000-0000-4000-8000-000000000201', 'https://sso.example.invalid', 'hr-marta', 'Marta Pinto', 'hr'),
    ('00000000-0000-4000-8000-000000000202', 'https://sso.example.invalid', 'hr-hugo', 'Hugo Ramos', 'hr');

INSERT INTO identity.teams (team_id, department_id, name, manager_user_id) VALUES
    (1, 1, 'Platform', '00000000-0000-4000-8000-000000000101'),
    (2, 1, 'Product', '00000000-0000-4000-8000-000000000102'),
    (3, 2, 'Customer Support', '00000000-0000-4000-8000-000000000103'),
    (4, 3, 'Internal Operations', '00000000-0000-4000-8000-000000000104');

DO $$
DECLARE
    employee_names text[] := ARRAY[
        'Ana Silva', 'Luis Costa', 'Ines Ferreira', 'Miguel Santos',
        'Beatriz Sousa', 'Tiago Pereira', 'Sofia Almeida', 'Duarte Rodrigues',
        'Rita Marques', 'Pedro Gomes', 'Mariana Martins', 'Joao Ribeiro',
        'Leonor Fernandes', 'Tomas Oliveira', 'Carolina Lopes', 'Diogo Teixeira',
        'Matilde Correia', 'Francisco Moreira', 'Alice Mendes', 'Goncalo Nunes',
        'Lara Rocha', 'Vasco Cardoso', 'Clara Pinto', 'Afonso Neves'
    ];
    employee_number integer;
    assigned_team bigint;
BEGIN
    FOR employee_number IN 1..array_length(employee_names, 1) LOOP
        assigned_team := CASE
            WHEN employee_number <= 8 THEN 1
            WHEN employee_number <= 14 THEN 2
            WHEN employee_number <= 22 THEN 3
            ELSE 4
        END;
        INSERT INTO identity.users (
            user_id, sso_issuer, sso_subject, display_name, role, team_id
        ) VALUES (
            ('00000000-0000-4000-8000-' || lpad(employee_number::text, 12, '0'))::uuid,
            'https://sso.example.invalid',
            'employee-' || lpad(employee_number::text, 2, '0'),
            employee_names[employee_number], 'employee', assigned_team
        );
    END LOOP;
END;
$$;

INSERT INTO wellbeing.challenge_factors (challenge_factor_id, code, label) VALUES
    (1, 'workload', 'Workload'),
    (7, 'deadlines', 'Deadlines'),
    (3, 'communication', 'Team communication'),
    (8, 'difficulty_integrating', 'Difficulty integrating'),
    (2, 'unclear_priorities', 'Lack of clarity'),
    (4, 'limited_support', 'Lack of support'),
    (5, 'work_life_balance', 'Work-life balance'),
    (9, 'organizational_changes', 'Organizational changes');
-- ID 6 belonged to tools_processes and is deliberately not reused.

-- The private eligibility snapshot includes NONRESPONDENTS. Do not calculate
-- response rates using only rows that already have a response attached.
-- Ana (employee-01) responds in every completed week for personal-history demos.
-- Duarte (employee-08) transfers Platform -> Product halfway through the series;
-- his older answers and eligibility remain attributed to Platform.
-- Platform: rising workload / declining wellbeing, plus recurring challenges.
-- Product: improving indicators. Customer Support: smaller fluctuations.
-- Internal Operations: only two eligible people, for configurable suppression demos.
DO $$
DECLARE
    current_week date := date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date;
    reporting_week date;
    week_number integer;
    employee_number integer;
    team_row record;
    employee_row record;
    new_response_id uuid;
    score_offset numeric;
    score_wellbeing numeric;
    score_workload numeric;
    score_integration numeric;
    score_safety numeric;
    stress_answer smallint;
    score_stress numeric;
BEGIN
    FOR week_number IN 0..8 LOOP
        reporting_week := current_week - (8 - week_number) * 7;

        IF week_number = 4 THEN
            UPDATE identity.users SET team_id = 2 WHERE sso_subject = 'employee-08';
        END IF;

        FOR team_row IN SELECT team_id, department_id FROM identity.teams ORDER BY team_id LOOP
            INSERT INTO wellbeing.team_weeks (team_id, week_start, department_id, created_at)
            VALUES (team_row.team_id, reporting_week, team_row.department_id,
                reporting_week::timestamp AT TIME ZONE 'Europe/Lisbon');
        END LOOP;

        FOR employee_row IN
            SELECT user_id, team_id, sso_subject FROM identity.users
            WHERE role = 'employee' AND is_active ORDER BY sso_subject
        LOOP
            INSERT INTO private.employee_weekly_checkins (user_id, week_start, team_id)
            VALUES (employee_row.user_id, reporting_week, employee_row.team_id);

            employee_number := right(employee_row.sso_subject, 2)::integer;
            -- Leave the current week empty and vary completed-week participation.
            IF week_number = 8 OR
                (employee_number <> 1 AND mod(employee_number + week_number, 7) = 0) THEN
                CONTINUE;
            END IF;

            score_offset := (mod(employee_number, 5) - 2) * 0.15;
            CASE employee_row.team_id
                WHEN 1 THEN
                    score_wellbeing := 8.5 - 0.45 * week_number + score_offset;
                    score_workload := 4.3 + 0.48 * week_number + score_offset;
                    score_integration := 7.9 - 0.18 * week_number + score_offset;
                    score_safety := 8.0 - 0.23 * week_number + score_offset;
                WHEN 2 THEN
                    score_wellbeing := 6.5 + 0.20 * week_number + score_offset;
                    score_workload := 6.6 - 0.18 * week_number + score_offset;
                    score_integration := 6.8 + 0.18 * week_number + score_offset;
                    score_safety := 6.9 + 0.15 * week_number + score_offset;
                WHEN 3 THEN
                    score_wellbeing := 7.8 - 0.10 * week_number + score_offset;
                    score_workload := 5.4 + 0.13 * week_number + score_offset;
                    score_integration := 7.6 + score_offset;
                    score_safety := 7.4 + 0.04 * week_number + score_offset;
                ELSE
                    score_wellbeing := 6.7 + 0.05 * week_number + score_offset;
                    score_workload := 6.0 + score_offset;
                    score_integration := 7.2 + score_offset;
                    score_safety := 7.0 + score_offset;
            END CASE;

            -- Independent fictional 1..5 answers: rising Platform stress,
            -- improving Product stress, and variation in the other teams.
            -- Never infer an existing employee's missing stress from workload.
            stress_answer := CASE employee_row.team_id
                WHEN 1 THEN least(5, 2 + floor(week_number / 2.0)::integer
                    + CASE WHEN mod(employee_number, 4) = 0 THEN 1 ELSE 0 END)
                WHEN 2 THEN greatest(1, 4 - floor(week_number / 3.0)::integer
                    + CASE WHEN mod(employee_number, 4) = 0 THEN 1 ELSE 0 END)
                WHEN 3 THEN 2 + mod(employee_number + week_number, 3)
                ELSE 3 + mod(employee_number + week_number, 2)
            END;
            score_stress := (stress_answer - 1) * 2.5;

            INSERT INTO wellbeing.wellbeing_responses (
                team_id, week_start, wellbeing_score, workload_score,
                stress_score, team_integration_score, psychological_safety_score, comment
            ) VALUES (
                employee_row.team_id, reporting_week,
                score_wellbeing, score_workload, score_stress, score_integration, score_safety,
                CASE WHEN mod(employee_number + week_number, 6) = 0
                    THEN 'More uninterrupted time and clearer weekly priorities would help.'
                    ELSE NULL END
            ) RETURNING response_id INTO new_response_id;

            -- Save choices BEFORE attaching the ownership link; submitted choices
            -- then become immutable. Comments are never Manager/HR insight text.
            IF employee_row.team_id = 1 AND week_number >= 3 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 1);
                IF mod(employee_number, 2) = 0 THEN
                    INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 2);
                END IF;
            ELSIF employee_row.team_id = 2 AND week_number < 3 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 2);
            END IF;
            IF mod(employee_number + week_number, 3) = 0 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 3);
            END IF;
            IF employee_row.team_id = 4 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 4);
            END IF;
            IF mod(employee_number + week_number, 4) = 0 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 5);
            END IF;
            IF mod(employee_number, 5) = 0 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 7);
            END IF;
            IF employee_row.team_id = 2 AND week_number < 3 AND mod(employee_number, 2) = 0 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 8);
            END IF;
            IF week_number IN (2, 3) AND mod(employee_number, 3) = 0 THEN
                INSERT INTO wellbeing.response_challenges VALUES (new_response_id, 9);
            END IF;

            UPDATE private.employee_weekly_checkins SET response_id = new_response_id
                WHERE user_id = employee_row.user_id AND week_start = reporting_week;
        END LOOP;

        IF week_number < 8 THEN
            UPDATE wellbeing.team_weeks
                SET finalized_at = (reporting_week + 7)::timestamp AT TIME ZONE 'Europe/Lisbon'
                WHERE week_start = reporting_week;
        END IF;
    END LOOP;
END;
$$;

-- Check all reciprocal ownership/cohort foreign keys before proceeding.
SET CONSTRAINTS ALL IMMEDIATE;

INSERT INTO operations.team_events (team_id, event_date, title, created_by_user_id)
SELECT v.team_id, a.week_start + v.day_offset, v.title, t.manager_user_id
FROM (VALUES
    (1::bigint, -28, 'Delivery milestone introduced'),
    (1::bigint, -14, 'Weekly priorities review started'),
    (2::bigint, -35, 'Shared planning workshop'),
    (3::bigint, -21, 'Updated customer handoff process')
) AS v(team_id, day_offset, title)
JOIN identity.teams t ON t.team_id = v.team_id
CROSS JOIN (SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date AS week_start) a;

INSERT INTO operations.team_actions (
    team_id, insight_week_start, insight_topic, challenge_factor_id,
    title, owner_user_id, deadline, status, created_by_user_id
)
SELECT v.team_id, a.week_start - v.weeks_ago * 7, v.topic, v.factor,
    v.title, v.owner_id::uuid, a.week_start + v.deadline_offset, v.status, t.manager_user_id
FROM (VALUES
    (1::bigint, 1, 'workload', NULL::smallint, 'Rebalance the next delivery cycle',
        '00000000-0000-4000-8000-000000000101', 7, 'in_progress'),
    (1::bigint, 2, 'challenge', 1::smallint, 'Agree a shared weekly priorities list',
        '00000000-0000-4000-8000-000000000001', 4, 'planned'),
    (2::bigint, 3, 'team_integration', NULL::smallint, 'Introduce a weekly cross-team planning session',
        '00000000-0000-4000-8000-000000000102', -1, 'completed'),
    (3::bigint, 2, 'challenge', 2::smallint, 'Clarify customer handoff responsibilities',
        '00000000-0000-4000-8000-000000000015', 10, 'planned')
) AS v(team_id, weeks_ago, topic, factor, title, owner_id, deadline_offset, status)
JOIN identity.teams t ON t.team_id = v.team_id
CROSS JOIN (SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date AS week_start) a;

INSERT INTO operations.activities (
    activity_id, title, description, activity_type, starts_at, duration_minutes,
    format, target_audience, is_featured, published_at, created_by_user_id, created_at
)
SELECT v.activity_id, v.title, v.description, v.activity_type,
    ((a.week_start + v.day_offset) + time '14:00') AT TIME ZONE 'Europe/Lisbon',
    v.duration_minutes, v.format, v.audience, v.featured,
    CASE WHEN v.publish_offset IS NULL THEN NULL ELSE
        ((a.week_start + v.publish_offset) + time '09:00') AT TIME ZONE 'Europe/Lisbon' END,
    v.creator_id::uuid,
    (a.week_start - 28)::timestamp AT TIME ZONE 'Europe/Lisbon'
FROM (VALUES
    (1::bigint, 'Planning a sustainable workday',
        'Practical ways to organize priorities and take useful breaks.',
        'workshop', 3, 60, 'online', 'All employees', true, -10,
        '00000000-0000-4000-8000-000000000201'),
    (2::bigint, 'Team connection lunch',
        'An informal opportunity to meet colleagues and build connections.',
        'group_activity', 8, 45, 'in_person', 'All employees', true, -7,
        '00000000-0000-4000-8000-000000000202'),
    (3::bigint, 'Clear priorities and shared expectations',
        'A facilitated discussion about manageable commitments and team communication.',
        'workshop', 10, 75, 'online', 'Delivery teams', false, -3,
        '00000000-0000-4000-8000-000000000201'),
    (4::bigint, 'Everyday team communication',
        'A practical session on asking for support and sharing expectations.',
        'workshop', -10, 60, 'online', 'All employees', false, -24,
        '00000000-0000-4000-8000-000000000202'),
    (5::bigint, 'Making tools work for the team',
        'Draft session on reducing friction in everyday working processes.',
        'workshop', 17, 45, 'in_person', 'Customer Support', false, NULL::integer,
        '00000000-0000-4000-8000-000000000201')
) AS v(activity_id, title, description, activity_type, day_offset, duration_minutes,
    format, audience, featured, publish_offset, creator_id)
CROSS JOIN (SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date AS week_start) a;

INSERT INTO private.activity_registrations (activity_id, user_id, registered_at)
SELECT v.activity_id, u.user_id,
    CASE WHEN v.activity_id = 4 THEN
        (a.week_start - 14)::timestamp AT TIME ZONE 'Europe/Lisbon'
    ELSE CURRENT_TIMESTAMP END
FROM (VALUES
    (1::bigint, 1), (1::bigint, 2), (1::bigint, 8), (1::bigint, 15), (1::bigint, 21),
    (2::bigint, 3), (2::bigint, 6), (2::bigint, 9), (2::bigint, 16), (2::bigint, 22),
    (3::bigint, 1), (3::bigint, 8), (3::bigint, 10), (3::bigint, 14),
    (4::bigint, 2), (4::bigint, 12), (4::bigint, 17)
) AS v(activity_id, employee_number)
JOIN identity.users u ON u.sso_subject = 'employee-' || lpad(v.employee_number::text, 2, '0')
CROSS JOIN (SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date AS week_start) a;

INSERT INTO operations.psychologists (psychologist_id, display_name) VALUES
    (1, 'Dr. Maria Barros'),
    (2, 'Dr. Rui Matos');

-- example.invalid links are deliberate nonfunctional placeholders, not real
-- appointment links. Confidential links must never be included in availability.
INSERT INTO operations.psychologist_slots (
    slot_id, psychologist_id, starts_at, ends_at, format, location, video_url
)
SELECT v.slot_id, v.psychologist_id,
    ((a.week_start + v.day_offset) + v.start_time) AT TIME ZONE 'Europe/Lisbon',
    (((a.week_start + v.day_offset) + v.start_time) AT TIME ZONE 'Europe/Lisbon') + interval '50 minutes',
    v.format, v.location, v.video_url
FROM (VALUES
    (1::bigint, 1::bigint, 7, time '10:00', 'online', NULL::text, 'https://sessions.example.invalid/demo-slot-1'),
    (2::bigint, 1::bigint, 7, time '11:00', 'online', NULL::text, 'https://sessions.example.invalid/demo-slot-2'),
    (3::bigint, 1::bigint, 9, time '14:00', 'in_person', 'Private consultation room A', NULL::text),
    (4::bigint, 2::bigint, 11, time '09:00', 'online', NULL::text, 'https://sessions.example.invalid/demo-slot-4'),
    (5::bigint, 2::bigint, 11, time '10:00', 'online', NULL::text, 'https://sessions.example.invalid/demo-slot-5'),
    (6::bigint, 2::bigint, 14, time '15:00', 'in_person', 'Private consultation room B', NULL::text),
    (7::bigint, 1::bigint, 8, time '09:00', 'online', NULL::text, 'https://sessions.example.invalid/demo-slot-7'),
    (8::bigint, 2::bigint, 15, time '09:00', 'in_person', 'Private consultation room B', NULL::text)
) AS v(slot_id, psychologist_id, day_offset, start_time, format, location, video_url)
CROSS JOIN (SELECT date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Lisbon')::date AS week_start) a;

INSERT INTO private.psychologist_bookings (booking_id, user_id, slot_id) VALUES
    ('00000000-0000-4000-8000-000000005001', '00000000-0000-4000-8000-000000000001', 1),
    ('00000000-0000-4000-8000-000000005002', '00000000-0000-4000-8000-000000000010', 4),
    ('00000000-0000-4000-8000-000000005003', '00000000-0000-4000-8000-000000000015', 6),
    ('00000000-0000-4000-8000-000000005004', '00000000-0000-4000-8000-000000000022', 3);

-- Demonstrate a cancellation and a reschedule without any wellbeing linkage.
UPDATE private.psychologist_bookings SET status = 'cancelled'
    WHERE booking_id = '00000000-0000-4000-8000-000000005002';
UPDATE private.psychologist_bookings SET slot_id = 8
    WHERE booking_id = '00000000-0000-4000-8000-000000005003';

-- A cancelled slot can be booked again; the partial unique index still permits
-- only ONE active booking. Slots 2, 5, 6, and 7 remain available.
INSERT INTO private.psychologist_bookings (booking_id, user_id, slot_id) VALUES
    ('00000000-0000-4000-8000-000000005005', '00000000-0000-4000-8000-000000000005', 4);

-- Advance sequences after explicit fixture IDs so later generated IDs do not collide.
SELECT setval(pg_get_serial_sequence('identity.departments', 'department_id'),
    (SELECT max(department_id) FROM identity.departments), true);
SELECT setval(pg_get_serial_sequence('identity.teams', 'team_id'),
    (SELECT max(team_id) FROM identity.teams), true);
SELECT setval(pg_get_serial_sequence('wellbeing.challenge_factors', 'challenge_factor_id'),
    (SELECT max(challenge_factor_id) FROM wellbeing.challenge_factors), true);
SELECT setval(pg_get_serial_sequence('operations.activities', 'activity_id'),
    (SELECT max(activity_id) FROM operations.activities), true);
SELECT setval(pg_get_serial_sequence('operations.psychologists', 'psychologist_id'),
    (SELECT max(psychologist_id) FROM operations.psychologists), true);
SELECT setval(pg_get_serial_sequence('operations.psychologist_slots', 'slot_id'),
    (SELECT max(slot_id) FROM operations.psychologist_slots), true);

COMMIT;

-- Non-destructive Manager Action Plans support. No wellbeing tables are changed.
-- Legacy descriptions stay NULL. A NULL insight week means a general team action.
BEGIN;
ALTER TABLE operations.team_actions
    ADD COLUMN IF NOT EXISTS description text
        CONSTRAINT team_actions_description_check CHECK (description IS NULL OR btrim(description) <> ''),
    ALTER COLUMN insight_week_start DROP NOT NULL;

CREATE OR REPLACE FUNCTION operations.validate_team_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    source_changed boolean := TG_OP = 'INSERT';
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM identity.teams WHERE team_id = NEW.team_id
            AND manager_user_id = NEW.created_by_user_id FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Team records must be created by the assigned Manager';
        END IF;
    ELSE
        IF NEW.team_id IS DISTINCT FROM OLD.team_id
            OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
            RAISE EXCEPTION 'Team record scope and creator cannot be reassigned';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'team_actions' THEN
        PERFORM 1 FROM identity.users u
            WHERE u.user_id = NEW.owner_user_id
            AND (u.role = 'hr' OR (u.role = 'employee' AND u.team_id = NEW.team_id)
                OR (u.role = 'manager' AND EXISTS (
                    SELECT 1 FROM identity.teams t WHERE t.team_id = NEW.team_id
                    AND t.manager_user_id = u.user_id))) FOR SHARE OF u;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'An action owner must belong to its team, manage it, or have the HR role';
        END IF;
        IF TG_OP = 'UPDATE' THEN
            source_changed := ROW(NEW.insight_week_start, NEW.insight_topic, NEW.challenge_factor_id)
                IS DISTINCT FROM ROW(OLD.insight_week_start, OLD.insight_topic, OLD.challenge_factor_id);
            NEW.updated_at := CURRENT_TIMESTAMP;
        END IF;
        IF source_changed AND NEW.insight_week_start IS NOT NULL THEN
            PERFORM 1 FROM wellbeing.team_weeks WHERE team_id = NEW.team_id
                AND week_start = NEW.insight_week_start AND finalized_at IS NOT NULL;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'Actions must reference a finalized reporting week';
            END IF;
        END IF;
        -- Finalized does not mean privacy-safe: later action-creation operations
        -- must also verify that the source insight passes configured suppression.
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;

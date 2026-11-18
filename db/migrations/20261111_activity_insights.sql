-- Extend the EXISTING activity entity. No response data, registrations or legacy
-- intervention rows are changed. The already-applied local intervention table
-- is left untouched as unused legacy data; fresh schemas do not create it.
BEGIN;
ALTER TABLE operations.activities
    ADD COLUMN department_id bigint REFERENCES identity.departments (department_id),
    ADD COLUMN related_area text CHECK (related_area IN ('wellbeing', 'workloadBalance', 'teamIntegration', 'psychologicalSafety', 'stress')),
    ADD COLUMN source_week_start date,
    ADD COLUMN source_value numeric(3,1),
    ADD COLUMN source_change numeric(3,1),
    ADD CONSTRAINT activities_insight_source_check CHECK (
        (source_week_start IS NULL AND source_value IS NULL AND source_change IS NULL)
        OR (department_id IS NOT NULL AND related_area IS NOT NULL AND source_week_start IS NOT NULL
            AND extract(isodow FROM source_week_start) = 1
            AND source_value IS NOT NULL AND source_value BETWEEN 0 AND 10
            AND source_change IS NOT NULL AND source_change BETWEEN -10 AND 10
            AND ((related_area = 'stress' AND source_change > 0) OR (related_area <> 'stress' AND source_change < 0)))
    );
-- NULL department preserves existing organization-wide activities. New scoped
-- activities use the real catalogue; no employee/response FK is introduced.
-- The source is an immutable snapshot of an already released department metric.
-- Only the API's existing reporting release checks can establish its safety.
CREATE INDEX activities_department_start_idx ON operations.activities (department_id, starts_at);

CREATE OR REPLACE FUNCTION operations.validate_activity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM 1 FROM identity.users WHERE user_id = NEW.created_by_user_id AND role = 'hr';
    IF NOT FOUND THEN RAISE EXCEPTION 'Activity creators must have the HR role'; END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
            RAISE EXCEPTION 'An activity creator cannot be reassigned';
        END IF;
        IF ROW(NEW.source_week_start, NEW.source_value, NEW.source_change)
            IS DISTINCT FROM ROW(OLD.source_week_start, OLD.source_value, OLD.source_change)
            OR (OLD.source_week_start IS NOT NULL AND ROW(NEW.department_id, NEW.related_area)
                IS DISTINCT FROM ROW(OLD.department_id, OLD.related_area)) THEN
            RAISE EXCEPTION 'An activity aggregate source cannot be reassigned';
        END IF;
        NEW.updated_at := CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$;
COMMIT;

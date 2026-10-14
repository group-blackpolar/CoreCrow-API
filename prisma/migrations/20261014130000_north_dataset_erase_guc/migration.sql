-- Dataset snapshot tables stay immutable (UPDATE and TRUNCATE are always rejected). DELETE is allowed only inside a
-- transaction that opted in with set_config('corecrow.allow_dataset_erase', 'on', true); the service sets it solely when
-- permanently erasing an ARCHIVED dataset with no analytics bindings.
-- Rollback: re-create the function from 20260930150000_north_tenant_data_foundation (unconditional RAISE).
CREATE OR REPLACE FUNCTION reject_north_dataset_schema_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('corecrow.allow_dataset_erase', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'North dataset schema snapshots are append-only';
END;
$$ LANGUAGE plpgsql;

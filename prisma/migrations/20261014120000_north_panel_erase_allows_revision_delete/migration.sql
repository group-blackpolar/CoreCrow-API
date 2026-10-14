-- Revisions stay append-only (UPDATE and TRUNCATE are always rejected). DELETE is allowed only inside a transaction
-- that explicitly opted in with set_config('corecrow.allow_panel_revision_erase', 'on', true), which the service sets
-- solely when permanently erasing a panel, subcategory or category. Without it, deleting content that already had a
-- saved revision failed with the trigger exception and surfaced as HTTP 500.
-- Rollback: re-create the function from 20260928130000_north_panel_revision_immutability (unconditional RAISE).
CREATE OR REPLACE FUNCTION reject_north_panel_revision_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('corecrow.allow_panel_revision_erase', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'NorthPanelRevision is append-only';
END;
$$ LANGUAGE plpgsql;

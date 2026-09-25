-- Revisions are append-only at the persistence boundary, not merely by service convention.
CREATE FUNCTION reject_north_panel_revision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'NorthPanelRevision is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NorthPanelRevision_reject_update_delete"
BEFORE UPDATE OR DELETE ON "NorthPanelRevision"
FOR EACH ROW EXECUTE FUNCTION reject_north_panel_revision_mutation();

CREATE TRIGGER "NorthPanelRevision_reject_truncate"
BEFORE TRUNCATE ON "NorthPanelRevision"
FOR EACH STATEMENT EXECUTE FUNCTION reject_north_panel_revision_mutation();

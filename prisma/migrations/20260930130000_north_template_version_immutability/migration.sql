CREATE FUNCTION reject_north_template_version_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'NorthTemplateVersion is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "NorthTemplateVersion_reject_update_delete"
BEFORE UPDATE OR DELETE ON "NorthTemplateVersion"
FOR EACH ROW EXECUTE FUNCTION reject_north_template_version_mutation();

CREATE TRIGGER "NorthTemplateVersion_reject_truncate"
BEFORE TRUNCATE ON "NorthTemplateVersion"
FOR EACH STATEMENT EXECUTE FUNCTION reject_north_template_version_mutation();

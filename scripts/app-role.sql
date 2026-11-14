-- RM-007: the application runs as `corecrow_app` (DML only); the migrator role owns the schema and runs `prisma migrate deploy`.
-- Run as the schema owner:  psql -v ON_ERROR_STOP=1 -v app_password='...' -f scripts/app-role.sql
-- Idempotent. Default privileges cover tables the migrator creates later.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'corecrow_app') THEN
    CREATE ROLE corecrow_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;
ALTER ROLE corecrow_app PASSWORD :'app_password';
GRANT USAGE ON SCHEMA public TO corecrow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO corecrow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO corecrow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO corecrow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO corecrow_app;

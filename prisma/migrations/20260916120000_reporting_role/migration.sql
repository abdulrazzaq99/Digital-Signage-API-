-- Read-only reporting role for DBeaver access (spec 18.2). Password is intentionally simple for
-- local Docker; rotate it in production with: ALTER ROLE reporting WITH PASSWORD '...';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting') THEN
    CREATE ROLE reporting LOGIN PASSWORD 'reporting';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO reporting', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO reporting;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting;

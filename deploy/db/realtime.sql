-- deploy/db/realtime.sql
-- Mounted as /docker-entrypoint-initdb.d/migrations/99-realtime.sql; runs once,
-- on the first boot of a fresh supabase-db-data volume.
--
-- The schema Supabase Realtime keeps its own tables in (tenants, extensions,
-- schema_migrations). Realtime connects as supabase_admin with
-- `SET search_path TO _realtime`, so the schema must exist and be owned by it.
-- Upstream reads the owner from $POSTGRES_USER, which this image leaves empty.
create schema if not exists _realtime;
alter schema _realtime owner to supabase_admin;

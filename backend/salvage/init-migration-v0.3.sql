-- ========================================================================
-- SALVAGE — REFERENCE ONLY. Do NOT apply this file as a Supabase migration.
-- ========================================================================
-- This is the hand-authored init migration from the aborted v0.3 Fastify
-- scaffold (the approach was replaced by the Supabase-first pivot in v0.4).
-- It is preserved here as a schema / RLS-policy reference when authoring
-- the first Supabase migration. See ../README.md for the "carry forward /
-- adapt / drop" checklist. Authoritative schema source is now
-- docs/backend-spec.md v0.4.1 §6.1.
--
-- Key reasons this file cannot be applied directly:
--   * The `users`, `invites`, `password_history`, `sessions`, `auth_events`
--     tables are REPLACED by Supabase Auth (auth.users etc.) in v0.4.
--   * RLS policies use `current_setting('app.tenant_id')::uuid` — in v0.4
--     they must use `(auth.jwt() ->> 'tenant_id')::uuid`.
--   * v0.4.1 adds `tenants.login_max_attempts`, `login_lockout_minutes`,
--     `public.users.sessions_revoked_at`, `public.user_unlock_markers`,
--     and `audit_events` (domain audit, not auth audit).
-- ========================================================================

-- Initial schema: tenancy + auth (§3, §4, §6.1 of docs/backend-spec.md v0.3.0).
-- RLS is enabled + FORCEd on tenant-scoped tables; the `app.tenant_id` GUC
-- must be set via set_config('app.tenant_id', <uuid>, true) at the start of
-- every request-handling transaction. See src/db/rls.ts (deleted).
--
-- Tables intentionally without RLS in this slice and why:
--   - tenants        : global directory; callers resolve slug -> id pre-auth.
--   - invites        : token-based lookup pre-auth; token_hash is globally unique.
--   - sessions       : token-based lookup before tenant GUC is known.
--   - auth_events    : pre-login events legitimately have tenant_id = NULL.
-- These are guarded by app-level filters and by uniqueness of opaque tokens.

-- ========== Enums ==========
CREATE TYPE "TenantStatus"  AS ENUM ('active', 'suspended');
CREATE TYPE "UserRole"      AS ENUM ('admin', 'submitter');
CREATE TYPE "UserStatus"    AS ENUM ('pending', 'active', 'revoked');
CREATE TYPE "AuthEventType" AS ENUM (
  'login_success',
  'login_failure',
  'logout',
  'password_change',
  'password_reset_admin',
  'invite_consumed',
  'revoke',
  'restore',
  'account_locked',
  'account_unlocked'
);

-- ========== Tenants ==========
CREATE TABLE "tenants" (
  "id"                         uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                       text           NOT NULL,
  "slug"                       text           NOT NULL,
  "status"                     "TenantStatus" NOT NULL DEFAULT 'active',
  "timezone"                   text           NOT NULL DEFAULT 'UTC',
  "locale"                     text           NOT NULL DEFAULT 'en-US',
  "email_from_address"         text           NOT NULL,
  "webhook_url"                text,
  "webhook_signing_secret_ref" text,
  "session_absolute_hours"     integer        NOT NULL DEFAULT 12,
  "session_idle_minutes"       integer        NOT NULL DEFAULT 30,
  "stall_hours"                integer        NOT NULL DEFAULT 48,
  "created_at"                 timestamptz    NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" ("slug");

-- ========== Users ==========
CREATE TABLE "users" (
  "id"                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid         NOT NULL,
  "username"            text         NOT NULL,
  "email"               text         NOT NULL,
  "role"                "UserRole"   NOT NULL,
  "employee_id"         uuid,
  "password_hash"       text,
  "password_version"    integer      NOT NULL DEFAULT 0,
  "password_expired_at" timestamptz,
  "status"              "UserStatus" NOT NULL DEFAULT 'pending',
  "locked_until"        timestamptz,
  "created_at"          timestamptz  NOT NULL DEFAULT now(),
  "created_by"          uuid
);
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT;
ALTER TABLE "users" ADD CONSTRAINT "users_creator_fk"
  FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "users_tenant_username_key" ON "users" ("tenant_id", "username");
CREATE UNIQUE INDEX "users_tenant_email_key"    ON "users" ("tenant_id", "email");
CREATE INDEX        "users_tenant_id_idx"       ON "users" ("tenant_id");

-- ========== Invites ==========
CREATE TABLE "invites" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid        NOT NULL,
  "user_id"      uuid        NOT NULL,
  "token_hash"   text        NOT NULL,
  "expires_at"   timestamptz NOT NULL,
  "consumed_at"  timestamptz,
  "released_at"  timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "created_by"   uuid
);
ALTER TABLE "invites" ADD CONSTRAINT "invites_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE;
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "invites" ADD CONSTRAINT "invites_creator_fk"
  FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "invites_token_hash_key"   ON "invites" ("token_hash");
CREATE INDEX        "invites_tenant_user_idx"  ON "invites" ("tenant_id", "user_id");

-- ========== Password history ==========
CREATE TABLE "password_history" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     uuid        NOT NULL,
  "user_id"       uuid        NOT NULL,
  "password_hash" text        NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE;
ALTER TABLE "password_history" ADD CONSTRAINT "password_history_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
CREATE INDEX "password_history_user_idx"
  ON "password_history" ("user_id", "created_at" DESC);

-- ========== Sessions ==========
CREATE TABLE "sessions" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid        NOT NULL,
  "user_id"             uuid        NOT NULL,
  "token_hash"          text        NOT NULL,
  "password_version"    integer     NOT NULL,
  "issued_at"           timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"        timestamptz NOT NULL DEFAULT now(),
  "absolute_expires_at" timestamptz NOT NULL,
  "revoked_at"          timestamptz,
  "ip"                  text,
  "user_agent"          text
);
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE CASCADE;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE;
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" ("token_hash");
CREATE INDEX        "sessions_user_idx"       ON "sessions" ("user_id", "revoked_at");

-- ========== Auth events ==========
CREATE TABLE "auth_events" (
  "id"         uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"  uuid,
  "user_id"    uuid,
  "event_type" "AuthEventType"  NOT NULL,
  "ip"         text,
  "user_agent" text,
  "ts"         timestamptz      NOT NULL DEFAULT now(),
  "details"    jsonb
);
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_tenant_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE SET NULL;
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_fk"
  FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL;
CREATE INDEX "auth_events_tenant_user_ts_idx"
  ON "auth_events" ("tenant_id", "user_id", "ts" DESC);
CREATE INDEX "auth_events_ip_ts_idx"
  ON "auth_events" ("ip", "ts" DESC);

-- ========== Row-Level Security ==========
-- RLS uses `current_setting('app.tenant_id', true)` so a missing setting
-- yields NULL (not an error). With NULL the predicate `tenant_id = NULL`
-- is never true, so queries outside a tenant-scoped transaction return
-- zero rows and INSERTs fail the WITH CHECK — the desired fail-closed
-- behavior.

ALTER TABLE "users"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users"            FORCE  ROW LEVEL SECURITY;
ALTER TABLE "password_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_history" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_users
  ON "users"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY tenant_isolation_password_history
  ON "password_history"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- GoXL Ally — beta registration schema
--
-- Target: a SEPARATE managed PostgreSQL database (Supabase / Neon / any managed
-- Postgres). This schema is intentionally standalone and must NOT be applied to
-- the existing Ally production database.
--
-- Apply with:  psql "$DATABASE_URL" -f db/schema.sql
-- Safe to re-run: every statement is idempotent.
--
-- Requires PostgreSQL 13+, where gen_random_uuid() is part of core. No
-- extensions are needed, so this applies cleanly on providers that restrict
-- CREATE EXTENSION.

CREATE TABLE IF NOT EXISTS beta_users (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  email        text        NOT NULL UNIQUE,
  phone        text,
  linkedin_url text,
  status       text        NOT NULL DEFAULT 'NEW',
  source       text        NOT NULL DEFAULT 'ally_landing_beta',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- The application lowercases every address before insert; this guarantees the
  -- UNIQUE constraint can never be bypassed by casing, even from manual SQL.
  CONSTRAINT beta_users_email_is_lowercase CHECK (email = lower(email)),
  CONSTRAINT beta_users_email_not_blank    CHECK (length(btrim(email)) > 0),
  CONSTRAINT beta_users_name_not_blank     CHECK (length(btrim(name)) > 0),
  CONSTRAINT beta_users_status_allowed     CHECK (status IN ('NEW', 'CONTACTED', 'INVITED', 'ACTIVE', 'REJECTED'))
);

-- Lock the table down to server-side access only.
--
-- On Supabase, every table in the `public` schema is automatically published
-- through the PostgREST API and readable by the `anon` role — i.e. by anyone
-- holding the project's publishable key. Beta signups contain names, emails and
-- phone numbers, so that must not happen.
--
-- Enabling RLS with NO policies denies the `anon` and `authenticated` roles
-- outright, while the table owner (the role in DATABASE_URL, which is how this
-- app connects) still reads and writes normally. On non-Supabase providers this
-- is simply a harmless extra safeguard.
ALTER TABLE beta_users ENABLE ROW LEVEL SECURITY;

-- Keep updated_at truthful without relying on the application to remember.
CREATE OR REPLACE FUNCTION beta_users_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS beta_users_set_updated_at ON beta_users;
CREATE TRIGGER beta_users_set_updated_at
  BEFORE UPDATE ON beta_users
  FOR EACH ROW
  EXECUTE FUNCTION beta_users_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Batched access
--
-- Access opens in batches. `capacity` is the number of registrations that have
-- been let in so far, counted by position in the registration queue: a founder
-- whose position is <= capacity is in, everyone else is waiting. Raising it is
-- the only lever the team touches, and the only thing this table holds.
--
-- A single row, pinned by a CHECK so a second one cannot be inserted by
-- accident and leave the app reading whichever it happened to select first.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS access_settings (
  id         boolean     PRIMARY KEY DEFAULT true,
  capacity   integer     NOT NULL DEFAULT 300,
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT access_settings_single_row  CHECK (id),
  CONSTRAINT access_settings_capacity_ok CHECK (capacity >= 0)
);

INSERT INTO access_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE access_settings ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS access_settings_set_updated_at ON access_settings;
CREATE TRIGGER access_settings_set_updated_at
  BEFORE UPDATE ON access_settings
  FOR EACH ROW
  EXECUTE FUNCTION beta_users_touch_updated_at();

-- When access was granted, so a batch can be audited after the fact and a
-- future "reclaim unused invites" rule has something to measure against.
-- `updated_at` cannot serve: any edit to the row moves it.
ALTER TABLE beta_users ADD COLUMN IF NOT EXISTS invited_at timestamptz;
-- Where the registration came from: UTM tags, ad click ids, referrer. First
-- touch and the touch at registration, as one JSON document; NULL for a
-- direct visit. Validated by app/lib/attribution.ts before it gets here.
ALTER TABLE beta_users ADD COLUMN IF NOT EXISTS attribution jsonb;
-- Who the subscription is for: "personal" or "business", and for a business
-- the optional invoice details they chose to give on the pricing page --
-- company name, GSTIN, billing address. One JSON document; NULL when the
-- question was never answered. Every field is optional and validated by
-- app/lib/billing.ts before it gets here, so a malformed GSTIN is dropped
-- rather than stored or allowed to fail the registration.
ALTER TABLE beta_users ADD COLUMN IF NOT EXISTS billing jsonb;

-- The GST registrations we will have to invoice, which is the only question
-- this column is ever asked. Partial: personal registrations are the majority
-- and are never looked up this way.
CREATE INDEX IF NOT EXISTS beta_users_business_billing
  ON beta_users ((billing ->> 'gstin'))
  WHERE billing ->> 'gstin' IS NOT NULL;

-- Position is `ORDER BY created_at, id` over everyone still in the queue, and
-- granting a batch reads that order under load. Rejected rows leave the line
-- entirely, so they are excluded from the index as well as the query.
CREATE INDEX IF NOT EXISTS beta_users_queue_order
  ON beta_users (created_at, id)
  WHERE status <> 'REJECTED';

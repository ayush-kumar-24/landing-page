import postgres, { type Sql } from "postgres";

import type { Attribution } from "./attribution";
import type { BillingProfile } from "./billing";
import {
  devAccessCounts,
  devFindBetaUserByEmail,
  devFindBetaUserById,
  devGetCapacity,
  devInsertBetaUser,
  devMarkBetaUserInvited,
  devPendingGrants,
  devPositionOf,
  devQueuePreview,
  devSetCapacity,
  devStoreEnabled,
} from "./dev-store";

/**
 * Server-only Postgres access for the Ally beta registration flow.
 *
 * Talks to a SEPARATE managed Postgres database via `DATABASE_URL`. This module
 * must never be imported from client code — `DATABASE_URL` is read here and is
 * deliberately not exposed through any `NEXT_PUBLIC_*` variable.
 *
 * With no DATABASE_URL outside production, every function below falls through
 * to the file-backed store in dev-store.ts so the flow can be exercised with no
 * database at all. In production a missing DATABASE_URL is still a hard error.
 */

declare global {
  // Reused across hot reloads in dev and across warm invocations in production
  // so we don't open a new connection pool on every request.
  var __allyBetaSql: Sql | undefined;
}

function createClient(connectionString: string): Sql {
  return postgres(connectionString, {
    // Serverless: many short-lived instances, so keep each one to a single
    // connection and let the provider's pooler do the multiplexing.
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    // Transaction-mode poolers (Supabase/Supavisor, PgBouncer) do not support
    // prepared statements. Disabling them keeps this portable across providers.
    prepare: false,
    // Never let driver notices reach the response; keep them in server logs.
    onnotice: () => {},
  });
}

function useDevStore(): boolean {
  return !process.env.DATABASE_URL && devStoreEnabled();
}

function getSql(): Sql {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured");
  }
  if (!globalThis.__allyBetaSql) {
    globalThis.__allyBetaSql = createClient(connectionString);
  }
  return globalThis.__allyBetaSql;
}

export type BetaUserInput = {
  name: string;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  source: string;
  /** Where they came from; null for a direct visit. See attribution.ts. */
  attribution?: Attribution | null;
  /** Personal or business use, and the invoice details. See billing.ts. */
  billing?: BillingProfile | null;
};

export type BetaUserInsert =
  | { created: true; id: string; createdAt: Date }
  | { created: false };

export type BetaUserStatus = "NEW" | "CONTACTED" | "INVITED" | "ACTIVE" | "REJECTED";

/** The subset of a row the approval flow needs. */
export type BetaUserRow = {
  id: string;
  name: string;
  email: string;
  status: BetaUserStatus;
  createdAt: Date;
  /** Last change to the row -- for an INVITED row, when it was approved. */
  updatedAt: Date;
  attribution?: Attribution | null;
};

type RawRow = {
  id: string; name: string; email: string; status: string; created_at: Date; updated_at: Date;
  attribution?: unknown;
};

function toRow(raw: RawRow): BetaUserRow {
  return {
    id: raw.id,
    name: raw.name,
    email: raw.email,
    status: raw.status as BetaUserStatus,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    attribution: (raw.attribution as Attribution | null | undefined) ?? null,
  };
}

/**
 * Inserts a beta registration.
 *
 * Uniqueness is enforced by the database, not by a read-then-write check, so
 * concurrent submissions of the same address cannot both win. `ON CONFLICT DO
 * NOTHING` combined with `RETURNING` yields zero rows on conflict, which is how
 * we distinguish a genuinely new signup from a repeat.
 */
export async function insertBetaUser(input: BetaUserInput): Promise<BetaUserInsert> {
  if (useDevStore()) return devInsertBetaUser(input);
  const sql = getSql();

  const rows = await sql<{ id: string; created_at: Date }[]>`
    INSERT INTO beta_users (name, email, phone, linkedin_url, source, attribution, billing)
    VALUES (
      ${input.name},
      ${input.email},
      ${input.phone},
      ${input.linkedinUrl},
      ${input.source},
      ${input.attribution ? sql.json(input.attribution) : null},
      ${input.billing ? sql.json(input.billing) : null}
    )
    ON CONFLICT (email) DO NOTHING
    RETURNING id, created_at
  `;

  const row = rows[0];
  if (!row) return { created: false };
  return { created: true, id: row.id, createdAt: row.created_at };
}

export async function findBetaUserById(id: string): Promise<BetaUserRow | null> {
  if (useDevStore()) {
    const row = await devFindBetaUserById(id);
    return row
      ? toRow({ ...row, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) })
      : null;
  }
  const sql = getSql();
  const rows = await sql<RawRow[]>`
    SELECT id, name, email, status, created_at, updated_at, attribution
    FROM beta_users
    WHERE id = ${id}
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

/** Lookup by (already lowercased) email -- used to hand a repeat registrant their id. */
export async function findBetaUserByEmail(email: string): Promise<BetaUserRow | null> {
  if (useDevStore()) {
    const row = await devFindBetaUserByEmail(email);
    return row
      ? toRow({ ...row, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) })
      : null;
  }
  const sql = getSql();
  const rows = await sql<RawRow[]>`
    SELECT id, name, email, status, created_at, updated_at, attribution
    FROM beta_users
    WHERE email = ${email}
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

/**
 * Marks a registration approved. Idempotent: re-running on an INVITED row
 * changes nothing but `updated_at` (the trigger touches it), which is why the
 * caller decides whether to send anything based on the status it read first.
 */
export async function markBetaUserInvited(id: string): Promise<BetaUserRow | null> {
  if (useDevStore()) {
    const row = await devMarkBetaUserInvited(id);
    return row
      ? toRow({ ...row, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) })
      : null;
  }
  const sql = getSql();
  const rows = await sql<RawRow[]>`
    UPDATE beta_users
    SET status = 'INVITED',
        -- COALESCE so re-approving keeps the moment access was FIRST granted.
        invited_at = COALESCE(invited_at, now())
    WHERE id = ${id}
    RETURNING id, name, email, status, created_at, updated_at
  `;
  return rows[0] ? toRow(rows[0]) : null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Batched access
 *
 * Everyone who registers takes a place in one queue, ordered by when they
 * registered. `capacity` is how far down that queue we have opened: position
 * <= capacity means they are in. Raising it is the only lever the team pulls.
 *
 * The order is `created_at, id` everywhere -- created_at alone is not unique
 * under concurrent inserts, and a queue whose order shifts between two reads
 * would hand two founders the same position. Rejected rows leave the queue, so
 * everyone behind them moves up.
 * ───────────────────────────────────────────────────────────────────────────*/

const IN_QUEUE = "status <> 'REJECTED'";
const GRANTED = "status IN ('INVITED', 'ACTIVE')";

/** How far down the queue access has been opened. */
export async function getCapacity(): Promise<number> {
  if (useDevStore()) return devGetCapacity();
  const sql = getSql();
  const rows = await sql<{ capacity: number }[]>`SELECT capacity FROM access_settings WHERE id = true`;
  // schema.sql seeds this row. If it is somehow missing, nobody is in rather
  // than everybody -- failing closed is the safer direction for a gate.
  return rows[0]?.capacity ?? 0;
}

/** Sets capacity outright; the admin page sends the new total, not a delta. */
export async function setCapacity(capacity: number): Promise<number> {
  if (useDevStore()) return devSetCapacity(capacity);
  const sql = getSql();
  const rows = await sql<{ capacity: number }[]>`
    UPDATE access_settings SET capacity = ${capacity} WHERE id = true RETURNING capacity
  `;
  return rows[0]?.capacity ?? capacity;
}

/** 1-based place in the queue, or null once the row has left it. */
export async function positionOf(id: string): Promise<number | null> {
  if (useDevStore()) return devPositionOf(id);
  const sql = getSql();
  const rows = await sql<{ position: string }[]>`
    SELECT position FROM (
      SELECT id, row_number() OVER (ORDER BY created_at, id) AS position
      FROM beta_users
      WHERE ${sql.unsafe(IN_QUEUE)}
    ) ranked
    WHERE id = ${id}
  `;
  return rows[0] ? Number(rows[0].position) : null;
}

export type AccessCounts = { total: number; granted: number; waiting: number };

export async function accessCounts(): Promise<AccessCounts> {
  if (useDevStore()) return devAccessCounts();
  const sql = getSql();
  const rows = await sql<{ total: string; granted: string }[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE ${sql.unsafe(GRANTED)}) AS granted
    FROM beta_users
    WHERE ${sql.unsafe(IN_QUEUE)}
  `;
  const total = Number(rows[0]?.total ?? 0);
  const granted = Number(rows[0]?.granted ?? 0);
  return { total, granted, waiting: total - granted };
}

/**
 * The next `limit` registrations inside capacity that have not been let in --
 * the work a batch has left to do. Read in queue order, so granting always
 * walks the line from the front. Nothing here mutates: the caller grants them
 * one at a time and calls again.
 */
export async function pendingGrants(limit: number): Promise<BetaUserRow[]> {
  if (useDevStore()) {
    const rows = await devPendingGrants(limit);
    return rows.map((r) => toRow({ ...r, created_at: new Date(r.created_at), updated_at: new Date(r.updated_at) }));
  }
  const capacity = await getCapacity();
  if (capacity <= 0) return [];
  const sql = getSql();
  const rows = await sql<RawRow[]>`
    SELECT id, name, email, status, created_at, updated_at, attribution FROM (
      SELECT id, name, email, status, created_at, updated_at, attribution,
             row_number() OVER (ORDER BY created_at, id) AS position
      FROM beta_users
      WHERE ${sql.unsafe(IN_QUEUE)}
    ) ranked
    WHERE position <= ${capacity} AND NOT (${sql.unsafe(GRANTED)})
    ORDER BY position
    LIMIT ${limit}
  `;
  return rows.map(toRow);
}

export type QueueEntry = BetaUserRow & { position: number };

/** The front of the queue, for the admin page. */
export async function queuePreview(limit: number): Promise<QueueEntry[]> {
  if (useDevStore()) {
    const rows = await devQueuePreview(limit);
    return rows.map((r) => ({
      ...toRow({ ...r, created_at: new Date(r.created_at), updated_at: new Date(r.updated_at) }),
      position: r.position,
    }));
  }
  const sql = getSql();
  const rows = await sql<(RawRow & { position: string })[]>`
    SELECT id, name, email, status, created_at, updated_at, attribution, position FROM (
      SELECT id, name, email, status, created_at, updated_at, attribution,
             row_number() OVER (ORDER BY created_at, id) AS position
      FROM beta_users
      WHERE ${sql.unsafe(IN_QUEUE)}
    ) ranked
    ORDER BY position
    LIMIT ${limit}
  `;
  return rows.map((r) => ({ ...toRow(r), position: Number(r.position) }));
}

import type { Attribution } from "./attribution";
import type { BillingProfile } from "./billing";
import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

/**
 * Development-only stand-ins for the two things the waitlist flow needs from
 * the outside world: a database and a mailbox.
 *
 * Both are plain JSON files under `.dev/` (git-ignored). They exist so the
 * whole flow — register → internal notification → Approve → invite email →
 * platform sign-in — can be clicked through on a laptop with no DATABASE_URL,
 * no SMTP credentials and no Supabase project, and so that the SAME code path
 * runs once those are configured: db.ts and email.ts consult this module only
 * when their real backing is absent, and only outside production.
 *
 * Every export refuses to run when NODE_ENV=production. Vercel sets that on
 * every deployment, so a misconfigured production site fails loudly instead of
 * quietly writing registrations to a file on a serverless disk.
 */

// Relative to the working directory, like float-q-lock's `public/` path and
// Next's own project-root lookups. Start the dev server FROM the project
// directory (`npm run dev` here, not `next dev <path>` from elsewhere) or the
// files land wherever the shell happened to be.
const DEV_DIR = path.join(process.cwd(), ".dev");
const WAITLIST_FILE = path.join(DEV_DIR, "waitlist.json");
const OUTBOX_FILE = path.join(DEV_DIR, "outbox.json");
const OUTBOX_MAX = 200;

export function devStoreEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

function assertDev(what: string): void {
  if (!devStoreEnabled()) {
    throw new Error(`[ally-beta] ${what} is disabled in production`);
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(DEV_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

/**
 * Read-modify-write on a JSON file is not atomic, and the registration route
 * captures two emails concurrently -- without this, both read the same file,
 * each wrote back its own single entry, and one was lost. One mutation at a
 * time, in order; a failure does not block the ones behind it.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}

// ── Waitlist ─────────────────────────────────────────────────────────────────

export type DevBetaUser = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  linkedin_url: string | null;
  status: "NEW" | "CONTACTED" | "INVITED" | "ACTIVE" | "REJECTED";
  source: string;
  created_at: string;
  updated_at: string;
  invited_at?: string | null;
  attribution?: Attribution | null;
  billing?: BillingProfile | null;
};

const SETTINGS_FILE = path.join(DEV_DIR, "access.json");
const DEFAULT_CAPACITY = 300;

type DevInsertInput = {
  name: string;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  source: string;
  attribution?: Attribution | null;
  billing?: BillingProfile | null;
};

async function readWaitlist(): Promise<DevBetaUser[]> {
  return readJson<DevBetaUser[]>(WAITLIST_FILE, []);
}

/** Mirrors db.ts's ON CONFLICT (email) DO NOTHING — a repeat is not an error. */
export async function devInsertBetaUser(
  input: DevInsertInput,
): Promise<{ created: true; id: string; createdAt: Date } | { created: false }> {
  assertDev("dev waitlist store");
  return serialized(async () => {
    const rows = await readWaitlist();
    if (rows.some((row) => row.email === input.email)) return { created: false as const };

    const now = new Date().toISOString();
    const row: DevBetaUser = {
      id: randomUUID(),
      name: input.name,
      email: input.email,
      phone: input.phone,
      linkedin_url: input.linkedinUrl,
      status: "NEW",
      source: input.source,
      attribution: input.attribution ?? null,
      billing: input.billing ?? null,
      created_at: now,
      updated_at: now,
    };
    rows.push(row);
    await writeJson(WAITLIST_FILE, rows);
    return { created: true as const, id: row.id, createdAt: new Date(now) };
  });
}

export async function devFindBetaUserById(id: string): Promise<DevBetaUser | null> {
  assertDev("dev waitlist store");
  const rows = await readWaitlist();
  return rows.find((row) => row.id === id) ?? null;
}

export async function devFindBetaUserByEmail(email: string): Promise<DevBetaUser | null> {
  assertDev("dev waitlist store");
  const rows = await readWaitlist();
  return rows.find((row) => row.email === email) ?? null;
}

export async function devMarkBetaUserInvited(id: string): Promise<DevBetaUser | null> {
  assertDev("dev waitlist store");
  return serialized(async () => {
    const rows = await readWaitlist();
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    const now = new Date().toISOString();
    // Only on the transition, so re-approving does not restamp the moment
    // access was actually granted.
    if (row.status !== "INVITED" && row.status !== "ACTIVE") row.invited_at = now;
    row.status = "INVITED";
    row.updated_at = now;
    await writeJson(WAITLIST_FILE, rows);
    return row;
  });
}

// ── Batched access ───────────────────────────────────────────────────────────

/** The queue: everyone still in line, oldest first. Rejections leave it. */
function queue(rows: DevBetaUser[]): DevBetaUser[] {
  return rows
    .filter((row) => row.status !== "REJECTED")
    .sort((a, b) => (a.created_at === b.created_at
      ? a.id.localeCompare(b.id)
      : a.created_at.localeCompare(b.created_at)));
}

export async function devGetCapacity(): Promise<number> {
  assertDev("dev access settings");
  const s = await readJson<{ capacity?: number }>(SETTINGS_FILE, {});
  return typeof s.capacity === "number" ? s.capacity : DEFAULT_CAPACITY;
}

export async function devSetCapacity(capacity: number): Promise<number> {
  assertDev("dev access settings");
  return serialized(async () => {
    await writeJson(SETTINGS_FILE, { capacity });
    return capacity;
  });
}

/** 1-based place in the queue, or null once the row has left it. */
export async function devPositionOf(id: string): Promise<number | null> {
  assertDev("dev waitlist store");
  const i = queue(await readWaitlist()).findIndex((row) => row.id === id);
  return i === -1 ? null : i + 1;
}

export async function devAccessCounts(): Promise<{ total: number; granted: number; waiting: number }> {
  assertDev("dev waitlist store");
  const rows = queue(await readWaitlist());
  const granted = rows.filter((r) => r.status === "INVITED" || r.status === "ACTIVE").length;
  return { total: rows.length, granted, waiting: rows.length - granted };
}

/** The next `limit` in line who are within capacity but have not been let in. */
export async function devPendingGrants(limit: number): Promise<DevBetaUser[]> {
  assertDev("dev waitlist store");
  const capacity = await devGetCapacity();
  return queue(await readWaitlist())
    .slice(0, capacity)
    .filter((row) => row.status !== "INVITED" && row.status !== "ACTIVE")
    .slice(0, limit);
}

/** Everyone in line, for the admin page. */
export async function devQueuePreview(limit: number): Promise<Array<DevBetaUser & { position: number }>> {
  assertDev("dev waitlist store");
  return queue(await readWaitlist())
    .map((row, i) => ({ ...row, position: i + 1 }))
    .slice(0, limit);
}

// ── Outbox ───────────────────────────────────────────────────────────────────

export type OutboxEntry = {
  id: string;
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  /** Which send this was — "confirmation email", "internal notification email", … */
  context: string;
  sentAt: string;
};

export async function devCaptureEmail(entry: Omit<OutboxEntry, "id" | "sentAt">): Promise<void> {
  assertDev("dev email outbox");
  await serialized(async () => {
    const entries = await readJson<OutboxEntry[]>(OUTBOX_FILE, []);
    entries.unshift({ ...entry, id: randomUUID(), sentAt: new Date().toISOString() });
    await writeJson(OUTBOX_FILE, entries.slice(0, OUTBOX_MAX));
  });
}

export async function devListOutbox(): Promise<OutboxEntry[]> {
  assertDev("dev email outbox");
  return readJson<OutboxEntry[]>(OUTBOX_FILE, []);
}

export async function devClearOutbox(): Promise<void> {
  assertDev("dev email outbox");
  await serialized(() => writeJson(OUTBOX_FILE, []));
}

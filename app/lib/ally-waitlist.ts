/**
 * Forwarding a registration into the Ally platform's own waitlist.
 *
 * This site keeps its own `beta_users` table -- that stays the record of who
 * registered here, with the attribution, the policy version and the phone and
 * LinkedIn details Ally has no columns for. What changed is where the team
 * DECIDES. Approval now happens in the Ally admin panel, next to the founders,
 * the plans and everything else about a person; this site's job is to make
 * sure the panel knows they exist.
 *
 * Server to server, never from the browser. The platform's CORS allowlist has
 * no say here, and no key is involved: `POST /api/v1/waitlist` is deliberately
 * the one unauthenticated write in that API, because the whole point is that
 * somebody with no account can ask for one.
 *
 * BEST EFFORT, ALWAYS
 * The registration is already committed by the time this runs. Nothing here
 * may turn it into a user-visible failure, so every path returns rather than
 * throws, and a failure is a server-side log plus a row this site still holds.
 * `scripts/backfill-ally-waitlist.mjs` re-sends anything that did not land.
 *
 * The platform answers 202 to a new registration, a duplicate, and someone
 * already approved -- identically, on purpose, so that endpoint cannot be used
 * to find out who is on the founder list. So a 202 here means "it arrived",
 * never "a row was created".
 */

const DEFAULT_URL = "https://api.goxlally.ai/api/v1/waitlist";

/**
 * Short on purpose. This runs inside the registration request, after the row
 * is safe, and a slow platform must not spend the serverless function's
 * remaining budget -- the founder is waiting on this response.
 */
const TIMEOUT_MS = 5_000;

/** The platform's schema is `extra="forbid"`; these are its caps. */
const FULL_NAME_MAX = 200;
const EMAIL_MAX = 255;
const NOTE_MAX = 2_000;
const SOURCE_MAX = 60;

export type AllyForwardInput = {
  email: string;
  name: string;
  phone?: string | null;
  linkedinUrl?: string | null;
  /** This site's own source string, e.g. `ally_landing_early_access|policy=...`. */
  source?: string | null;
};

export type AllyForwardResult =
  | { ok: true; status: number }
  | { ok: false; error: string; status?: number };

/**
 * Phone and LinkedIn have nowhere to go in the platform's schema, and sending
 * an unknown field is a 422 there rather than a silently dropped value. They
 * matter to whoever reads the queue, so they go into the note the panel already
 * shows in full.
 */
function noteFrom({ phone, linkedinUrl }: AllyForwardInput): string | null {
  const parts: string[] = [];
  if (phone) parts.push(`Phone: ${phone}`);
  if (linkedinUrl) parts.push(`LinkedIn: ${linkedinUrl}`);
  if (!parts.length) return null;
  return parts.join(" · ").slice(0, NOTE_MAX);
}

export function allyWaitlistPayload(input: AllyForwardInput) {
  return {
    email: input.email.trim().toLowerCase().slice(0, EMAIL_MAX),
    full_name: input.name.trim().slice(0, FULL_NAME_MAX),
    note: noteFrom(input),
    // Truncated rather than trusted: this site's source carries the policy
    // version and marketing flag, which is already close to the platform's
    // 60-character cap, and one more flag appended here later must not start
    // failing every registration with a 422.
    source: (input.source || "join.goxlally.ai").slice(0, SOURCE_MAX),
  };
}

export async function forwardToAllyWaitlist(
  input: AllyForwardInput,
): Promise<AllyForwardResult> {
  const url = process.env.ALLY_WAITLIST_URL?.trim() || DEFAULT_URL;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allyWaitlistPayload(input)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    if (response.status === 202) return { ok: true, status: response.status };

    // 422 means the contract drifted -- a field this site sends is not one the
    // platform accepts. Worth the response body in the log, because that is
    // the one failure a person has to fix rather than retry.
    const detail = response.status === 422 ? await response.text().catch(() => "") : "";
    return {
      ok: false,
      status: response.status,
      error: `Ally waitlist responded ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    };
  } catch (error) {
    // Includes the timeout above: an AbortError here is "the platform did not
    // answer in five seconds", not "the registration failed".
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

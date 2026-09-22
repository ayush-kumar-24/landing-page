import { insertCookieConsent } from "../../lib/db";

/**
 * Records a cookie choice made on the public site.
 *
 * WHY THE SITE NEEDS THIS. The banner has always enforced the visitor's choice
 * properly. What it could not do is prove the choice was made: it lived in
 * localStorage, per-device, gone the moment site data was cleared. The DPDP Act
 * asks a Data Fiduciary to demonstrate consent, and a browser's own memory is
 * not a record anybody else can inspect.
 *
 * WHAT THIS ENDPOINT REFUSES TO COLLECT. No IP address, no user agent, no
 * fingerprint, nothing that can be joined to a beta registration. The request's
 * IP is available here and is deliberately dropped on the floor. A visitor who
 * has signed up for nothing is anonymous, and keeping a durable record of who
 * they are in order to prove they declined tracking would be a worse trade than
 * the gap it closes. The row says what was chosen, when, and under which
 * version of the cookie wording. That is the evidence; the identity is not.
 *
 * FIRE AND FORGET, BY DESIGN. The banner does not wait for this and does not
 * care what it answers. A visitor's choice must apply instantly and must not
 * depend on a network round trip -- so this always returns 204, the client
 * never branches on it, and a failure here can never leave somebody looking at
 * a banner that will not go away.
 */

export const maxDuration = 10;

// Room for the handful of small fields below and nothing else.
const MAX_BODY_BYTES = 1_024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["accept_all", "necessary_only", "saved_preferences"]);
const POLICY_VERSION_MAX = 32;
// A clock that is wrong by a day happens; one that is wrong by a year is a
// forged or corrupted timestamp, and the recorded_at column is what a reviewer
// should trust anyway.
const MAX_CLOCK_SKEW_MS = 48 * 60 * 60 * 1_000;

const NO_CONTENT = new Response(null, {
  status: 204,
  headers: { "Cache-Control": "no-store" },
});

export async function POST(request: Request): Promise<Response> {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return NO_CONTENT;

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NO_CONTENT;
    }
    if (!body || typeof body !== "object") return NO_CONTENT;
    const b = body as Record<string, unknown>;

    // Every field is checked rather than trusted. This endpoint is public and
    // unauthenticated -- it has to be, the visitor has no account -- so the
    // only thing standing between it and a table full of junk is this block.
    if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return NO_CONTENT;
    if (typeof b.analytics !== "boolean") return NO_CONTENT;
    if (typeof b.advertising !== "boolean") return NO_CONTENT;
    if (typeof b.bannerAction !== "string" || !ACTIONS.has(b.bannerAction)) return NO_CONTENT;
    if (typeof b.policyVersion !== "string") return NO_CONTENT;
    const policyVersion = b.policyVersion.trim();
    if (!policyVersion || policyVersion.length > POLICY_VERSION_MAX) return NO_CONTENT;

    if (typeof b.chosenAt !== "string") return NO_CONTENT;
    const chosenAt = new Date(b.chosenAt);
    if (Number.isNaN(chosenAt.getTime())) return NO_CONTENT;
    if (Math.abs(Date.now() - chosenAt.getTime()) > MAX_CLOCK_SKEW_MS) return NO_CONTENT;

    await insertCookieConsent({
      id: b.id,
      analytics: b.analytics,
      advertising: b.advertising,
      bannerAction: b.bannerAction,
      policyVersion,
      chosenAt,
    });
  } catch {
    // Swallowed on purpose. See the note above: the banner does not wait for
    // this, so there is nobody to report an error to, and a 500 here would
    // only turn a missing record into a noisy one.
  }
  return NO_CONTENT;
}

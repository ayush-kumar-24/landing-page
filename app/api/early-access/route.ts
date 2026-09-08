import { after } from "next/server";

import { grantAccess, landingGrantsAccess } from "../../lib/access";
import { forwardToAllyWaitlist } from "../../lib/ally-waitlist";
import {
  findBetaUserByEmail, findBetaUserById, getCapacity, insertBetaUser, positionOf,
} from "../../lib/db";
import { sendBetaConfirmationEmail, sendInternalNotificationEmail } from "../../lib/email";
import { parseAttribution, type Attribution } from "../../lib/attribution";

// Note on Next.js 16: `nodejs` is already the default runtime and the docs
// direct you to remove the `runtime` export (the Edge runtime is deprecated).
// POST handlers are never cached, so no `dynamic` export is needed either.

/**
 * The slow path is a registration made while the database is down: a
 * connection that has to time out first (10s, see db.ts), then the forward to
 * the Ally panel (5s), then the mail that catches what neither held (7s, see
 * SEND_DEADLINE_MS in email.ts) -- 22s before the founder gets an answer, and
 * the confirmation sent behind the response can add its own 7s to the
 * invocation. Past the ten seconds a serverless function gets by default, and
 * a function killed mid-flight writes nothing, sends nothing and answers the
 * founder with an error -- the precise failure the fallback below exists to
 * prevent.
 *
 * The budget is a ceiling, not a target. A normal registration answers in well
 * under a second and never comes near it; only an outage spends it, and every
 * step above is separately capped so nothing here can hang until this does.
 */
export const maxDuration = 40;

// Room for the attribution object (two touches, each with tags and click ids).
const MAX_BODY_BYTES = 4_096;
// Per client, per window. The client is the nearest IP plus the user agent,
// not the IP alone: Indian mobile carriers put thousands of subscribers
// behind one address, and on a launch day ten registrations from one such
// address in ten minutes is a normal evening, not an attack. The real
// protections against abuse are the honeypot, the unique email and the
// fact that a registration costs the sender an inbox they control.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 10 * 60 * 1_000;
const MAX_RATE_BUCKETS = 5_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

const NAME_MAX = 80;
const EMAIL_MAX = 120;
const PHONE_MAX = 24;
const LINKEDIN_MAX = 200;
const SOURCE = "ally_landing_early_access";
/**
 * The published Terms and Privacy Policy in force, as a date stamp. It is a
 * marker for "which documents were on the site when this person accepted",
 * not either document's own version number: the Privacy Policy is v1.1 of
 * 6 September 2026, the Terms are still v1.0, and one field covers the pair
 * the checkbox asks about.
 */
const POLICY_VERSION = "2026-09-06";
/**
 * Versions a registration may still be submitted under, newest first.
 *
 * The landing page is static HTML served with `max-age=0, must-revalidate`,
 * so a fresh load after a deploy always carries the new value -- but a tab
 * that was already open does not. Someone who opened the page, went to find
 * their LinkedIn URL and came back ten minutes later would post the previous
 * version to the new API, and with a single accepted value that registration
 * would be refused with "Please review the latest Terms and Privacy Policy"
 * for something they had no way to know about. Registration is the one thing
 * this site exists to do, so the previous version stays valid for a while.
 *
 * What is recorded is what was actually submitted, never this constant, so a
 * registration made under 2026-08-15 says 2026-08-15 forever.
 *
 * REMOVE "2026-08-15" once the deploy that introduced 2026-09-06 has been
 * live longer than any plausible open tab -- a week is generous; the entry
 * is then dead weight and its presence would let a much older cached page
 * register under a policy nobody is reading any more.
 */
const ACCEPTED_POLICY_VERSIONS: readonly string[] = [POLICY_VERSION, "2026-08-15"];

const GENERIC_ERROR = "Something went wrong. Please try again.";

/**
 * Thrown to leave the instant-grant block early without logging. A plain
 * `return` cannot be used there -- the block is inside the request handler and
 * the response below still has to be built and sent.
 */
class SkipGrant extends Error {}
type RateBucket = { count: number; resetAt: number };

const rateBuckets = new Map<string, RateBucket>();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers },
  });
}

function requestHost(request: Request) {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("host") || new URL(request.url).host).toLowerCase();
}

function isSameOriginRequest(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === requestHost(request);
  } catch {
    return false;
  }
}

/**
 * Rate-limit key for this caller.
 *
 * Both header names here are client-settable in a plain HTTP request, so the
 * only value we can trust is one a proxy we control put there. Two rules keep
 * this honest:
 *
 *   1. `x-forwarded-for` is a chain — a client can pre-seed it and the proxy
 *      APPENDS the real address, so the LAST entry is the trustworthy one.
 *      Reading the first entry (as this did) let a caller pick their own key
 *      and sidestep the limit entirely by rotating it per request.
 *   2. `x-real-ip` is only consulted as a fallback, never in preference to the
 *      forwarded chain, because nothing appends to it.
 *
 * On Vercel both headers are rewritten at the edge, so the last entry is the
 * single real client IP and this behaves identically — it just stops being
 * bypassable if the app is ever fronted by a different proxy.
 */
function clientKey(request: Request) {
  const chain = request.headers.get("x-forwarded-for")?.split(",") ?? [];
  const nearest = chain.length ? chain[chain.length - 1]?.trim() : undefined;
  const realIp = request.headers.get("x-real-ip")?.trim();
  const ua = (request.headers.get("user-agent") ?? "").slice(0, 80);
  return ((nearest || realIp || "unknown").slice(0, 96) + "|" + ua).slice(0, 180);
}

function consumeRateLimit(request: Request) {
  const now = Date.now();
  const key = clientKey(request);
  if (rateBuckets.size >= MAX_RATE_BUCKETS) {
    for (const [storedKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) rateBuckets.delete(storedKey);
    }
    if (!rateBuckets.has(key) && rateBuckets.size >= MAX_RATE_BUCKETS) {
      const oldestKey = rateBuckets.keys().next().value as string | undefined;
      if (oldestKey) rateBuckets.delete(oldestKey);
    }
  }

  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return null;
  }

  bucket.count += 1;
  if (bucket.count <= RATE_LIMIT) return null;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
}

type FieldResult = { ok: true; value: string } | { ok: false };

/**
 * Optional. Accepts common international formats and stores an E.164-ish value.
 * An empty phone is valid — it must never block a registration.
 */
function normalizePhone(raw: string): FieldResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: "" };
  if (trimmed.length > PHONE_MAX) return { ok: false };
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return { ok: false };
  return { ok: true, value: `${trimmed.startsWith("+") ? "+" : ""}${digits}` };
}

/**
 * Optional. Validates shape only — nothing is fetched, scraped or verified.
 * Query strings and fragments are dropped so tracking params aren't stored.
 */
function normalizeLinkedinUrl(raw: string): FieldResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: "" };
  if (trimmed.length > LINKEDIN_MAX) return { ok: false };

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false };

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return { ok: false };

  const path = url.pathname.replace(/\/+$/, "");
  if (path.length <= 1) return { ok: false };

  return { ok: true, value: `https://${url.hostname.toLowerCase()}${path}` };
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) {
    return json({ ok: false, error: "Request not allowed" }, 403);
  }

  const retryAfter = consumeRateLimit(request);
  if (retryAfter !== null) {
    return json(
      { ok: false, error: "Too many attempts. Please try again shortly." },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) {
    return json({ ok: false, error: "JSON request required" }, 415);
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "Request too large" }, 413);
  }

  let name: string;
  let email: string;
  let phone: string | null;
  let linkedinUrl: string | null;
  let attribution: Attribution | null;
  let source: string;

  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "Request too large" }, 413);
    }

    let body: {
      name?: unknown;
      email?: unknown;
      phone?: unknown;
      linkedinUrl?: unknown;
      termsAccepted?: unknown;
      marketingConsent?: unknown;
      policyVersion?: unknown;
      company?: unknown;
      attribution?: unknown;
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    // Honeypot. `company` is rendered off-screen and hidden from assistive
    // tech, so a real person can never fill it; form-filling bots populate
    // every input they find. Answer 200 rather than an error — an error tells
    // the author which field gave them away, and they just stop sending it.
    // Nothing is written and no email is sent.
    if (String(body?.company ?? "").trim() !== "") {
      console.warn("[ally-beta] honeypot tripped", { ip: clientKey(request) });
      return json({ ok: true, duplicate: false });
    }

    name = String(body?.name ?? "").trim().replace(/\s+/g, " ").slice(0, NAME_MAX + 1);
    email = String(body?.email ?? "").trim().toLowerCase().slice(0, EMAIL_MAX);
    const rawPhone = String(body?.phone ?? "").slice(0, PHONE_MAX + 1);
    const rawLinkedin = String(body?.linkedinUrl ?? "").slice(0, LINKEDIN_MAX + 1);
    const termsAccepted = body?.termsAccepted === true;
    const marketingConsent = body?.marketingConsent === true;
    const policyVersion = String(body?.policyVersion || "").trim().slice(0, 32);
    // Validated, capped and stripped of anything personal; null for a direct visit.
    attribution = parseAttribution(body?.attribution);

    if (name.length < 2 || name.length > NAME_MAX) {
      return json({ ok: false, error: "Enter your full name" }, 400);
    }
    if (!EMAIL_RE.test(email)) {
      return json({ ok: false, error: "Enter a valid email" }, 400);
    }

    const normalizedPhone = normalizePhone(rawPhone);
    if (!normalizedPhone.ok) {
      return json({ ok: false, error: "Enter a valid phone number" }, 400);
    }
    if (!termsAccepted) {
      return json({ ok: false, error: "Terms and Privacy acknowledgement required" }, 400);
    }
    if (!ACCEPTED_POLICY_VERSIONS.includes(policyVersion)) {
      return json({ ok: false, error: "Please review the latest Terms and Privacy Policy" }, 400);
    }

    const normalizedLinkedin = normalizeLinkedinUrl(rawLinkedin);
    if (!normalizedLinkedin.ok) {
      return json({ ok: false, error: "Enter a valid LinkedIn profile URL" }, 400);
    }

    phone = normalizedPhone.value || null;
    linkedinUrl = normalizedLinkedin.value || null;
    // The version this person actually accepted, not the current one. They
    // are the same for every registration from an up-to-date page; they differ
    // for the open tab described above, and the record has to say what was on
    // the screen that was agreed to.
    source = `${SOURCE}|policy=${policyVersion}|marketing=${marketingConsent ? "yes" : "no"}`;
  } catch (error) {
    console.error("[ally-beta] request parsing failed", error);
    return json({ ok: false, error: GENERIC_ERROR }, 500);
  }

  // Outside production the emails link back to THIS server (the Approve
  // button, image URLs) rather than the production site, so the captured
  // copies in /dev/outbox are followable. In production `baseUrl` stays
  // undefined and the templates use their configured origin.
  //
  // Read before the insert, because the failure path below sends mail too.
  const devOrigin = process.env.NODE_ENV === "production" ? undefined : new URL(request.url).origin;

  // This site's table is where a registration is RECORDED. It is no longer the
  // only place one can live: the Ally panel is where the team answers it, and
  // that is a different database on different infrastructure.
  //
  // So a failure here is not the end of the registration any more. It used to
  // be -- and that is why registration was switched off on the landing page in
  // 2e9cfb1 when this database went down: every attempt ended in "Something
  // went wrong" after the founder had typed everything. Somebody who wants in
  // must not be turned away because OUR storage is having a bad day, when the
  // system that decides is up and reachable.
  //
  // What is lost when this path runs: the duplicate check (Ally's endpoint is
  // ON CONFLICT DO NOTHING, so it dedupes by address anyway), the attribution,
  // and the id this browser uses to follow its own place in the queue. What is
  // kept is the only thing that cannot be recovered later -- the person.
  let registration: Awaited<ReturnType<typeof insertBetaUser>> | null = null;
  try {
    registration = await insertBetaUser({ name, email, phone, linkedinUrl, source, attribution });
  } catch (error) {
    console.error("[ally-beta] registration insert failed", error);

    const forwarded = await forwardToAllyWaitlist({ email, name, phone, linkedinUrl, source });
    if (!forwarded.ok) {
      console.error(`[ally-beta] waitlist forward also failed for ${email}: ${forwarded.error}`);
    }

    // The third channel, and the reason a failed forward is no longer the end.
    //
    // The panel's waitlist endpoint allows five calls per five minutes PER IP
    // -- that is the limit scripts/backfill-ally-waitlist.mjs spends most of
    // its time waiting out. Every registration from this site arrives there
    // from the same handful of Vercel addresses, so the whole site shares one
    // allowance. While the database is up that costs nothing: the forward is
    // best effort and a 429 is a log line. While it is DOWN the forward is the
    // only path, and the sixth founder in five minutes met a 429 and then
    // "Something went wrong. Please try again." -- which they then did, adding
    // another call to the window they were already outside of.
    //
    // SMTP shares no infrastructure with either the database or the panel, so
    // it is the one channel still standing when both are down. The mail says
    // plainly that it is the only copy, and carries no Approve button, because
    // there is no row here to approve.
    //
    // How long the founder waits is the constraint here, and it is a tight
    // one. This path only runs when the database is already timing out (10s)
    // and after the forward has had its 5s, so the emails are spending a
    // budget that is mostly gone. Each send has a 7s ceiling of its own (see
    // SEND_DEADLINE_MS in email.ts), and TWO of them in sequence is what turns
    // a slow registration into a browser sitting on "Registering…" for half a
    // minute. So exactly one send is ever awaited, and only when its outcome
    // decides the answer.
    const notify = () =>
      sendInternalNotificationEmail({
        id: null,
        name,
        email,
        phone,
        linkedinUrl,
        attribution,
        registeredAt: new Date(),
        source,
        baseUrl: devOrigin,
        recordedIn: forwarded.ok ? "ally-panel" : "nowhere",
      });
    const confirm = () => sendBetaConfirmationEmail({ name, email, baseUrl: devOrigin });

    if (forwarded.ok) {
      // The panel has them. The answer is settled and no email can change it,
      // so both go out after the response rather than in front of it.
      console.warn(`[ally-beta] ${email} recorded in the Ally panel only — this site's insert failed`);
      after(() => Promise.allSettled([notify(), confirm()]));
      return json({ ok: true, duplicate: false });
    }

    // Nothing else is holding this registration, so whether that mail arrives
    // IS the answer, and it is the one send worth making the founder wait on.
    const notified = await notify();
    if (!notified) {
      // Every channel is down. Only now is this a failure the founder has to
      // see, and only now is asking them to try again honest.
      console.error(`[ally-beta] ${email} could not be recorded anywhere — insert, forward and notification all failed`);
      return json({ ok: false, error: GENERIC_ERROR }, 500);
    }

    console.warn(`[ally-beta] ${email} recorded by internal email only — this site's insert failed`);
    // Sent after the response for the same reason: the founder has been told
    // they are registered, and they are -- the mail above is holding them.
    after(confirm);

    // No id to report: this browser cannot follow a registration this site did
    // not store. The page reads that as "registered, position unknown", which
    // is exactly true.
    return json({ ok: true, duplicate: false });
  }

  if (!registration.created) {
    // Already registered: no second row, and no second confirmation email.
    // The existing id goes back so this browser can follow the registration's
    // status from now on (see /api/waitlist-status) -- it reveals nothing the
    // `duplicate` flag has not already said, and the id is a random UUID.
    let existingId: string | undefined;
    try {
      existingId = (await findBetaUserByEmail(email))?.id;
    } catch (error) {
      console.error("[ally-beta] duplicate lookup failed", error);
    }
    return json({ ok: true, duplicate: true, ...(existingId ? { id: existingId } : {}) });
  }

  // Best-effort delivery. Both helpers swallow their own failures and log
  // server-side, so an SMTP outage can never cost us a beta lead.
  //
  // Sent concurrently rather than in sequence: each one opens its own SMTP
  // conversation, and running them back to back doubles the worst case against
  // the serverless function's timeout. They are independent, so nothing is
  // gained by ordering them.
  // `allSettled`, not `all`: a rejection here would turn a committed
  // registration into a 500, which the invariant above forbids.
  //
  // Outside production the emails link back to THIS server (the Approve
  // button, image URLs) rather than the production site, so the captured
  // copies in /dev/outbox are followable. In production `baseUrl` stays
  // undefined and the templates use their configured origin.
  /* Inside the open batch? Then this founder does not wait for anybody: their
     account is created and the invite goes out now, in the same request that
     registered them.

     Deliberately BEFORE the confirmation email, so the two cannot contradict
     each other -- "we'll email you once you're approved" landing in the same
     inbox as "you're in" reads as a broken product. If they are in, the
     confirmation is skipped entirely and the invite is the only mail they get.

     Never fatal: a founder who is let in but whose email failed still has
     access and still sees the right thing on the page, because the response
     below reports the outcome and the page reads it. */
  let granted = false;
  try {
    // Skipped entirely rather than attempted and refused: with approval moved
    // to the Ally panel there is no instant grant to make, and calling into it
    // would log an error on every single registration.
    if (!landingGrantsAccess()) throw new SkipGrant();
    const position = await positionOf(registration.id);
    const capacity = await getCapacity();
    if (position !== null && position <= capacity) {
      const row = await findBetaUserById(registration.id);
      if (row) {
        const outcome = await grantAccess(row, { baseUrl: devOrigin });
        granted = outcome.ok;
        if (!outcome.ok) {
          // They keep their place in the queue and the next batch picks them
          // up; the page shows the waiting state, which is then the truth.
          console.error(`[ally-beta] instant grant failed for ${email}: ${outcome.error}`);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SkipGrant)) {
      console.error("[ally-beta] instant grant check failed", error);
    }
  }

  // Best-effort delivery. Both helpers swallow their own failures and log
  // server-side, so an SMTP outage can never cost us a beta lead.
  //
  // Sent concurrently rather than in sequence: each one opens its own SMTP
  // conversation, and running them back to back doubles the worst case against
  // the serverless function's timeout. They are independent, so nothing is
  // gained by ordering them.
  // `allSettled`, not `all`: a rejection here would turn a committed
  // registration into a 500, which the invariant above forbids.
  //
  // Outside production the emails link back to THIS server (the Approve
  // button, image URLs) rather than the production site, so the captured
  // copies in /dev/outbox are followable. In production `baseUrl` stays
  // undefined and the templates use their configured origin.
  // Sent with the emails, not before them, for the same reason they are sent
  // together: the row is already committed, the founder is waiting on this
  // response, and none of these three may add its latency to the other two.
  // A failure is logged and left for scripts/backfill-ally-waitlist.mjs --
  // this site still holds the registration either way.
  const forwardToAlly = forwardToAllyWaitlist({ email, name, phone, linkedinUrl, source })
    .then((result) => {
      if (!result.ok) {
        console.error(`[ally-beta] waitlist forward failed for ${email}: ${result.error}`);
      }
    });

  await Promise.allSettled([
    forwardToAlly,
    granted ? Promise.resolve() : sendBetaConfirmationEmail({ name, email, baseUrl: devOrigin }),
    sendInternalNotificationEmail({
      id: registration.id,
      name,
      email,
      phone,
      linkedinUrl,
      attribution,
      registeredAt: registration.createdAt,
      source,
      baseUrl: devOrigin,
      granted,
    }),
  ]);

  // The `dev` hint lets the landing page offer a link to the local outbox
  // while testing. It is never present in production.
  return json({
    ok: true,
    duplicate: false,
    id: registration.id,
    granted,
    ...(devOrigin ? { dev: { outbox: "/dev/outbox" } } : {}),
  });
}

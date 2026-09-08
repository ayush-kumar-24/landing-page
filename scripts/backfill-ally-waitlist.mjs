/**
 * Sends registrations this site already holds to the Ally platform's waitlist.
 *
 *   node --env-file=.env.local scripts/backfill-ally-waitlist.mjs --dry-run
 *   node --env-file=.env.local scripts/backfill-ally-waitlist.mjs
 *
 * Approval moved to the Ally admin panel, and `app/lib/ally-waitlist.ts`
 * forwards every registration made from now on. This covers the two cases that
 * leaves behind: everyone who registered BEFORE that change, and anyone whose
 * forward failed at the time (a timeout, a deploy mid-request) -- those are in
 * the server log as "waitlist forward failed".
 *
 * SAFE TO RE-RUN, AS OFTEN AS YOU LIKE
 * The platform's endpoint is ON CONFLICT DO NOTHING and answers 202 to a new
 * registration, a duplicate, and someone already approved -- identically, so
 * that it cannot be used to find out who is on the founder list. Nothing here
 * can create a second row for the same address, and nothing here can approve
 * anybody: it only puts people in the queue for a human to answer.
 *
 * That same silence is why this cannot report "12 new, 40 already there". A
 * 202 means "it arrived". What the panel shows afterwards is the real answer.
 *
 * The mapping below is deliberately the same as `allyWaitlistPayload` in
 * app/lib/ally-waitlist.ts. Change one, change the other -- they are apart only
 * because this is a plain .mjs script (the repo's script convention) and that
 * is TypeScript the Next build owns.
 */
import postgres from "postgres";

const DEFAULT_URL = "https://api.goxlally.ai/api/v1/waitlist";
const FULL_NAME_MAX = 200;
const EMAIL_MAX = 255;
const NOTE_MAX = 2_000;
const SOURCE_MAX = 60;

/**
 * The endpoint allows 5 registrations per 5 minutes PER IP, and every request
 * from this script comes from one machine -- so a backfill of any size WILL be
 * throttled, UNLESS ALLY_WAITLIST_FORWARD_SECRET is set (see .env.example and
 * app/lib/ally-waitlist.ts). Without it, being throttled is not a failure and
 * the script does not treat it as one: it waits out the window and re-sends
 * the same person.
 *
 * Sending is fast until the first 429, then settles to roughly one a minute,
 * which is the rate the endpoint actually allows. A queue of fifty therefore
 * takes the better part of an hour. Leave it running -- it prints each address
 * as it lands, and re-running it later is safe anyway.
 */
const DELAY_MS = 1_000;
/** No Retry-After comes back, so this is the window plus a little slack. */
const THROTTLED_WAIT_MS = 65_000;
const MAX_THROTTLE_RETRIES = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dryRun = process.argv.includes("--dry-run");
const url = process.env.ALLY_WAITLIST_URL?.trim() || DEFAULT_URL;
const forwardSecret = process.env.ALLY_WAITLIST_FORWARD_SECRET?.trim();
const connectionString = process.env.DATABASE_URL?.trim();

if (!connectionString) {
  console.error("FAIL  DATABASE_URL is not set. Run with: node --env-file=.env.local ...");
  process.exit(1);
}

function payloadFor(row) {
  const parts = [];
  if (row.phone) parts.push(`Phone: ${row.phone}`);
  if (row.linkedin_url) parts.push(`LinkedIn: ${row.linkedin_url}`);
  return {
    email: String(row.email).trim().toLowerCase().slice(0, EMAIL_MAX),
    full_name: String(row.name).trim().slice(0, FULL_NAME_MAX),
    note: parts.length ? parts.join(" · ").slice(0, NOTE_MAX) : null,
    source: String(row.source || "join.goxlally.ai").slice(0, SOURCE_MAX),
  };
}

const sql = postgres(connectionString, { max: 1, prepare: false, onnotice: () => {} });

try {
  // Oldest first, so the platform's queue -- which is ordered by arrival and
  // approved from the front -- ends up in the order people actually registered
  // here. Sending newest first would quietly put the newcomers ahead.
  const rows = await sql`
    SELECT email, name, phone, linkedin_url, source, created_at
      FROM beta_users
     ORDER BY created_at ASC, email ASC
  `;

  console.log(`${rows.length} registration(s) in beta_users`);
  console.log(`Target: ${url}${dryRun ? "  (dry run — nothing will be sent)" : ""}`);
  console.log(
    forwardSecret
      ? "Forward secret is set — rate-limit exempt, this will run at full speed."
      : "No forward secret set — expect ~1/minute after the first five (see .env.example).",
  );

  let sent = 0;
  const failures = [];

  for (const row of rows) {
    const payload = payloadFor(row);
    if (dryRun) {
      console.log(`  would send  ${payload.email}  (${payload.full_name})`);
      continue;
    }

    // Retries only the throttle. Every other outcome is decided on the first
    // attempt: a 422 means the payload is wrong and will be wrong again, and
    // re-sending it would only bury the one line that says so.
    for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(forwardSecret ? { "X-Waitlist-Forward-Secret": forwardSecret } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });

        if (response.status === 429) {
          if (attempt === MAX_THROTTLE_RETRIES) {
            failures.push({ email: payload.email, error: "429 after repeated waits" });
            console.error(`  FAIL  ${payload.email}  still throttled after ${attempt} waits`);
            break;
          }
          console.log(`  wait  ${Math.round(THROTTLED_WAIT_MS / 1000)}s (rate limit) then retry ${payload.email}`);
          await sleep(THROTTLED_WAIT_MS);
          continue;
        }

        if (response.status === 202) {
          sent += 1;
          console.log(`  sent  ${payload.email}`);
        } else {
          const detail = await response.text().catch(() => "");
          failures.push({ email: payload.email, error: `${response.status} ${detail.slice(0, 200)}` });
          console.error(`  FAIL  ${payload.email}  ${response.status}`);
        }
        break;
      } catch (error) {
        failures.push({ email: payload.email, error: String(error?.message || error) });
        console.error(`  FAIL  ${payload.email}  ${error?.message || error}`);
        break;
      }
    }

    await sleep(DELAY_MS);
  }

  if (!dryRun) {
    console.log(`\n${sent} accepted, ${failures.length} failed`);
    // Named rather than counted: a failed address is one a person has to look
    // at, and a bare "3 failed" makes them go digging through the log above.
    for (const f of failures) console.error(`  ${f.email}: ${f.error}`);
    console.log("\nA 202 means the platform received it, not that a row was created —");
    console.log("duplicates answer the same way on purpose. Check the Waitlist tab.");
  }

  process.exitCode = failures.length ? 1 : 0;
} finally {
  await sql.end({ timeout: 5 });
}

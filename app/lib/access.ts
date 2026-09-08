import { markBetaUserInvited, pendingGrants, type BetaUserRow } from "./db";
import { sendBetaApprovalEmail } from "./email";
import { platformLoginUrl } from "./platform-url";
import { ensureAuthUser } from "./supabase-admin";
import { metadataFrom } from "./attribution";

/**
 * Granting access — the one place it happens.
 *
 * Three things ask for it and they must agree on every detail: registering
 * inside capacity, opening a batch, and the manual Approve link in the team's
 * notification email. When this was written out at each call site they drifted
 * almost immediately — the batch path forgot to stamp the row before emailing,
 * so a founder could be told they were in while the row still read NEW.
 *
 * Order matters and is the whole safety story:
 *
 *   1. create the auth user  — the actual grant. The platform only mails a
 *      sign-in code to an address Supabase already knows, so nothing before
 *      this point lets anyone in.
 *   2. mark the row INVITED  — records it.
 *   3. email the founder     — tells them.
 *
 * A failure at 1 changes nothing and sends nothing: the founder stays exactly
 * where they were and the next attempt starts clean. A failure at 3 leaves
 * them with access but no email, which is why the result says so and both the
 * admin page and the approval page offer to send it again.
 */

/**
 * Whether THIS site may still create logins and email founders.
 *
 * It no longer does. The Ally admin panel is where the team decides who comes
 * in -- that is where the founder, their plan and everything else about them
 * already lives, and every registration made here is forwarded there (see
 * `lib/ally-waitlist.ts`). Two systems minting Supabase identities against the
 * same project is how one person ends up with two "you're in" emails and two
 * different ideas of how many places are left.
 *
 * The code stays, behind an off-by-default switch, because turning it back on
 * has to be one environment variable rather than a revert: if the panel is
 * ever unavailable on a day the queue must move, `LANDING_PAGE_GRANTS_ACCESS=true`
 * restores the batch and the Approve links exactly as they were.
 */
export function landingGrantsAccess(): boolean {
  return process.env.LANDING_PAGE_GRANTS_ACCESS?.trim().toLowerCase() === "true";
}

export type GrantOutcome =
  | { ok: true; alreadyHad: boolean; emailed: boolean; supabaseSkipped: boolean; loginUrl: string }
  | { ok: false; error: string };

/** Has this registration already been let in? */
export function isGranted(user: Pick<BetaUserRow, "status">): boolean {
  return user.status === "INVITED" || user.status === "ACTIVE";
}

export async function grantAccess(
  user: BetaUserRow,
  { baseUrl, resend = false }: { baseUrl?: string; resend?: boolean } = {},
): Promise<GrantOutcome> {
  const loginUrl = platformLoginUrl(user.email);

  if (!landingGrantsAccess()) {
    return {
      ok: false,
      error:
        "Approval happens in the Ally admin panel now. This site records the " +
        "registration and forwards it there; it no longer creates logins.",
    };
  }

  // Already in: only send again if that is what was asked for. Re-approving
  // must not mail a second "you're in" to someone who got one last week.
  if (isGranted(user) && !resend) {
    return { ok: true, alreadyHad: true, emailed: false, supabaseSkipped: false, loginUrl };
  }

  let supabaseSkipped = false;
  if (!isGranted(user)) {
    const auth = await ensureAuthUser({
      email: user.email,
      name: user.name,
      metadata: { waitlist_id: user.id, ...metadataFrom(user.attribution) },
    });
    if (!auth.ok) return { ok: false, error: auth.error };
    supabaseSkipped = Boolean(auth.skipped);

    const updated = await markBetaUserInvited(user.id);
    if (!updated) return { ok: false, error: "The registration no longer exists." };
  }

  const emailed = await sendBetaApprovalEmail({ name: user.name, email: user.email, loginUrl, baseUrl });
  return { ok: true, alreadyHad: false, emailed, supabaseSkipped, loginUrl };
}

/**
 * How many founders one request may let in.
 *
 * Each grant is a Supabase call plus an email, so a batch of 300 cannot run
 * inside one serverless invocation — the function times out and the mailbox
 * rate-limits long before the queue is done. The admin page calls this
 * repeatedly and shows the progress; a scheduled job finishes anything left.
 */
export const GRANT_CHUNK = 15;

export type BatchResult = {
  granted: number;
  failed: Array<{ email: string; error: string }>;
  emailFailures: number;
  remaining: number;
};

/**
 * Grants the next chunk of the queue.
 *
 * One at a time, in order, and a failure does not stop the ones behind it: a
 * single address Supabase rejects (already taken by a tester, malformed after
 * a manual edit) must not hold up the rest of a batch. Failures are returned
 * so the operator sees them rather than finding out from the founder.
 */
export async function grantNextBatch(
  { limit = GRANT_CHUNK, baseUrl }: { limit?: number; baseUrl?: string } = {},
): Promise<BatchResult> {
  const queue = await pendingGrants(limit);

  // Refused as a batch rather than row by row: with grants disabled every
  // single one would come back as a failure, and a page full of identical
  // errors hides the one fact worth reading -- that this is switched off here
  // on purpose.
  if (!landingGrantsAccess()) {
    return { granted: 0, failed: [], emailFailures: 0, remaining: queue.length };
  }

  const failed: BatchResult["failed"] = [];
  let granted = 0;
  let emailFailures = 0;

  for (const user of queue) {
    const result = await grantAccess(user, { baseUrl });
    if (!result.ok) {
      failed.push({ email: user.email, error: result.error });
      continue;
    }
    granted += 1;
    if (!result.emailed) emailFailures += 1;
  }

  // Asked after the work, so the number reported is what is genuinely left --
  // including anything that just failed and will be retried on the next call.
  const remaining = (await pendingGrants(limit + 1)).length;
  return { granted, failed, emailFailures, remaining };
}

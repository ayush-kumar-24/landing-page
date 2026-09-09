import { describeAttribution, type Attribution } from "./attribution";
import { describeBilling, type BillingProfile } from "./billing";
import nodemailer, { type Transporter } from "nodemailer";

import { signApprovalToken } from "./approval-token";
import { devCaptureEmail, devStoreEnabled } from "./dev-store";
import {
  escapeHtml,
  renderBetaApprovalEmail,
  renderBetaConfirmationEmail,
  resolveBaseUrl,
} from "./email-template";

/**
 * Server-only transactional email for the Ally beta flow, sent over SMTP
 * (Hostinger mailbox for goxlally.ai).
 *
 * Every function here is best-effort and NEVER throws: the database is the
 * source of truth for a registration, so an email outage must not lose or
 * invalidate a beta lead. Failures are logged server-side only.
 *
 * The branded customer-facing templates live in `email-template.ts`. The
 * internal notification below is deliberately plain and stays here — it is an
 * operational email, not a product one.
 *
 * Outside production, with no SMTP credentials, every send is captured to the
 * local outbox (dev-store.ts) and reported as delivered, so the whole waitlist
 * flow can be followed at /dev/outbox. With credentials present, real mail goes
 * out — in any environment.
 */

type ConfirmationRecipient = {
  name: string;
  email: string;
  /** Dev only: point image/link URLs at the local server (see email-template). */
  baseUrl?: string;
};

type InternalNotification = {
  /**
   * beta_users.id — signed into the Approve link. Null when this site's
   * database refused the registration: there is then no row to approve.
   */
  id: string | null;
  name: string;
  email: string;
  phone: string | null;
  linkedinUrl: string | null;
  attribution?: Attribution | null;
  /** Personal or business use, with the invoice details if they gave any. */
  billing?: BillingProfile | null;
  registeredAt: Date;
  source: string;
  baseUrl?: string;
  /** True when the batch was open and they were let straight in. */
  granted?: boolean;
  /**
   * Where the registration is actually recorded, which decides what this mail
   * can offer. Defaults to "site": the normal case, a row in `beta_users`.
   *
   * "ally-panel" means our database was unreachable and the panel took the
   * registration instead -- there is no row here, so no Approve button, and
   * the team approves in the panel.
   *
   * "nowhere" means our database AND the panel were both unreachable. THIS
   * EMAIL IS THEN THE ONLY RECORD that this person registered, which is why
   * it says so in the subject line as well as the body.
   */
  recordedIn?: "site" | "ally-panel" | "nowhere";
};

type ApprovalRecipient = {
  name: string;
  email: string;
  /** Absolute platform sign-in URL, email pre-filled (platform-url.ts). */
  loginUrl: string;
  baseUrl?: string;
};

type Outgoing = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

const DEFAULT_HOST = "smtp.hostinger.com";
const DEFAULT_PORT = 465;

/**
 * The registration response waits on delivery, so a wedged SMTP server must
 * not be able to stall it.
 *
 * These are per-phase caps, so on their own they can stack (connect, then
 * greet, then transfer). SEND_DEADLINE_MS below is the hard ceiling on a whole
 * send; the route sends both emails concurrently, so that figure is also the
 * worst case for the request as a whole. Kept well under the serverless
 * function limit on Vercel's Hobby plan, which is 10s by default.
 */
const CONNECTION_TIMEOUT_MS = 4_000;
const GREETING_TIMEOUT_MS = 4_000;
const SOCKET_TIMEOUT_MS = 6_000;
const SEND_DEADLINE_MS = 7_000;

/**
 * Rejects if `promise` has not settled within `ms`.
 *
 * The underlying send may still complete — we simply stop waiting on it. For a
 * best-effort email that is the right trade: a founder should never see a
 * failed registration because our mail server was slow.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    const done = () => clearTimeout(timer);
    promise.then(
      (value) => { done(); resolve(value); },
      (error) => { done(); reject(error); },
    );
  });
}

declare global {
  // Reused across hot reloads in dev and warm invocations in production so we
  // aren't renegotiating TLS on every registration.
  var __allyBetaMailer: Transporter | undefined;
}

function getTransporter(): Transporter | null {
  const host = process.env.SMTP_HOST?.trim() || DEFAULT_HOST;
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASSWORD;
  if (!user || !pass) return null;

  const port = Number(process.env.SMTP_PORT) || DEFAULT_PORT;

  if (!globalThis.__allyBetaMailer) {
    globalThis.__allyBetaMailer = nodemailer.createTransport({
      host,
      port,
      // 465 is implicit TLS; 587 starts plaintext and upgrades via STARTTLS.
      secure: port === 465,
      auth: { user, pass },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
  }
  return globalThis.__allyBetaMailer;
}

/**
 * Sender address. Required in production; outside it a placeholder keeps the
 * captured-to-outbox path working with zero configuration.
 */
function fromAddress(context: string): string | null {
  const from = process.env.BETA_FROM_EMAIL?.trim();
  if (from) return from;
  if (devStoreEnabled()) return "GoXL Ally <dev@localhost>";
  console.warn(`[ally-beta] ${context} skipped: BETA_FROM_EMAIL is not configured`);
  return null;
}

/** Never throws — SMTP failures are logged and reported as `false`. */
async function send(payload: Outgoing, context: string): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) {
    if (devStoreEnabled()) {
      try {
        await devCaptureEmail({ ...payload, context });
        console.info(`[ally-beta] [dev] ${context} to ${payload.to} captured — see /dev/outbox`);
        return true;
      } catch (error) {
        console.error(`[ally-beta] [dev] ${context} could not be captured`, error);
        return false;
      }
    }
    console.warn(
      `[ally-beta] ${context} skipped: SMTP_USER / SMTP_PASSWORD are not configured`,
    );
    return false;
  }

  try {
    await withDeadline(transporter.sendMail(payload), SEND_DEADLINE_MS, context);
    return true;
  } catch (error) {
    // Hostinger rejects any From that isn't the authenticated mailbox, which
    // is the most common misconfiguration here — surface it explicitly.
    console.error(`[ally-beta] ${context} failed`, error);
    return false;
  }
}

/**
 * Confirmation to the beta user. Only called after the row is committed, and
 * only for genuinely new registrations.
 */
export async function sendBetaConfirmationEmail(user: ConfirmationRecipient): Promise<boolean> {
  const from = fromAddress("confirmation email");
  if (!from) return false;

  const { subject, html, text } = renderBetaConfirmationEmail({ name: user.name, baseUrl: user.baseUrl });
  return send({ from, to: user.email, subject, html, text }, "confirmation email");
}

/**
 * The one-click Approve link for the internal notification, or null when
 * approval is not configured (production without APPROVAL_SECRET) — in which
 * case the email says so rather than carrying a dead button.
 */
function approveUrlFor(id: string, baseUrl?: string): string | null {
  const token = signApprovalToken(id);
  if (!token) return null;
  return `${resolveBaseUrl(baseUrl)}/approve?t=${encodeURIComponent(token)}`;
}

/** Internal heads-up for the GoXL team, with the Approve button. */
export async function sendInternalNotificationEmail(
  registration: InternalNotification,
): Promise<boolean> {
  const from = fromAddress("internal notification email");
  if (!from) return false;
  const to = process.env.BETA_NOTIFY_EMAIL?.trim() || (devStoreEnabled() ? "team@localhost" : "");
  if (!to) return false;

  const rows: Array<[string, string]> = [
    ["Name", registration.name],
    ["Email", registration.email],
    ["Phone", registration.phone || "—"],
    ["LinkedIn", registration.linkedinUrl || "—"],
    ["Came from", describeAttribution(registration.attribution)],
    ["Billing", describeBilling(registration.billing)],
    ["Registered At", registration.registeredAt.toISOString()],
    ["Source", registration.source],
  ];

  const recordedIn = registration.recordedIn ?? "site";

  // Approving works by signing a `beta_users` id, so the button is only
  // offered when there is a row here to approve. Someone the open batch
  // already let in needs no button either; showing one invites a click that
  // does nothing and makes the team wonder whether it worked. The line above
  // the details says which of the four happened.
  const approveUrl =
    registration.granted || recordedIn !== "site" || !registration.id
      ? null
      : approveUrlFor(registration.id, registration.baseUrl);

  const statusHtml = registration.granted
    ? `<p style="margin:0 0 16px;padding:10px 14px;background:#eefbf3;border-left:3px solid #10B981;font-size:13.5px;">
      <b>Access granted automatically</b> &mdash; they were inside the open batch, so their account is created and the invite has been sent. Nothing to do.
    </p>`
    : recordedIn === "nowhere"
      ? `<p style="margin:0 0 16px;padding:10px 14px;background:#fff5f5;border-left:3px solid #b00020;font-size:13.5px;">
      <b>Not recorded anywhere &mdash; this email is the only copy.</b> This site's database and the Ally waitlist endpoint were both unreachable, so there is no row here and nothing in the panel. The founder has been told they are registered, because they are &mdash; in this message. Add them to the panel by hand from the details below. <code>scripts/backfill-ally-waitlist.mjs</code> cannot help here: it re-sends what this site's database holds, and this registration never reached it.
    </p>`
      : recordedIn === "ally-panel"
        ? `<p style="margin:0 0 16px;padding:10px 14px;background:#f4f8ff;border-left:3px solid #3b6fd4;font-size:13.5px;">
      <b>In the Ally panel only</b> &mdash; this site's database was unreachable, so the registration went straight to the panel. There is no row here to approve; approve them in the panel as usual.
    </p>`
        : `<p style="margin:0 0 16px;padding:10px 14px;background:#fffaf0;border-left:3px solid #e0a800;font-size:13.5px;">
      <b>Waiting</b> &mdash; the batch is full, so they are in the queue. They will be let in when the next batch opens, or you can approve them now with the button below.
    </p>`;

  // No button, and no explanation of its absence, when the status line above
  // has already given the reason. The APPROVAL_SECRET note is for the one case
  // where a button was expected and could not be built.
  const approveHtml = approveUrl
    ? `<p style="margin:24px 0 0;">
      <a href="${escapeHtml(approveUrl)}" style="display:inline-block;padding:12px 20px;background:#2fe3ac;color:#04120c;font-weight:700;border-radius:8px;text-decoration:none;">Approve &amp; send invite &rarr;</a>
    </p>
    <p style="margin:8px 0 0;font-size:12px;color:#6b736f;">Opens a confirmation page first &mdash; nothing happens until you confirm there.</p>`
    : registration.granted || recordedIn !== "site"
      ? ""
      : `<p style="margin:24px 0 0;font-size:13px;color:#b00020;">Approval link unavailable: APPROVAL_SECRET is not configured on the server.</p>`;

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1b201e;">
    <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;">New Ally Early Access Registration</h1>
    ${statusHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;">
      ${rows
        .map(
          ([label, value]) =>
            `<tr><td style="padding:2px 16px 2px 0;color:#6b736f;white-space:nowrap;">${escapeHtml(label)}</td><td style="padding:2px 0;">${escapeHtml(value)}</td></tr>`,
        )
        .join("\n      ")}
    </table>
    ${approveHtml}
  </body>
</html>`;

  const statusText = registration.granted
    ? "ACCESS GRANTED AUTOMATICALLY — inside the open batch; account created and invite sent. Nothing to do."
    : recordedIn === "nowhere"
      ? "NOT RECORDED ANYWHERE — this site's database and the Ally waitlist endpoint were both unreachable. This email is the only copy of this registration; add them to the panel by hand."
      : recordedIn === "ally-panel"
        ? "IN THE ALLY PANEL ONLY — this site's database was unreachable, so there is no row here to approve. Approve them in the panel."
        : "WAITING — the batch is full, so they are in the queue.";

  const text = [
    "New Ally Early Access Registration",
    "",
    statusText,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    registration.granted || recordedIn !== "site"
      ? ""
      : approveUrl
        ? `Approve & send invite now: ${approveUrl}`
        : "Approval link unavailable: APPROVAL_SECRET is not configured.",
  ].join("\n");

  // The subject carries the warning too: an inbox rule or a phone notification
  // shows the subject and nothing else, and the one registration the team must
  // not scroll past is the one no database is holding for them.
  const subjectPrefix = recordedIn === "nowhere" ? "[NOT STORED] " : "";

  return send(
    {
      from,
      to,
      subject: `${subjectPrefix}New Ally Early Access Registration — ${registration.name}`,
      html,
      text,
      replyTo: registration.email,
    },
    "internal notification email",
  );
}

/** "You're in" — sent once the team approves, carrying the platform sign-in link. */
export async function sendBetaApprovalEmail(user: ApprovalRecipient): Promise<boolean> {
  const from = fromAddress("approval email");
  if (!from) return false;

  const { subject, html, text } = renderBetaApprovalEmail({
    name: user.name,
    loginUrl: user.loginUrl,
    baseUrl: user.baseUrl,
  });
  return send({ from, to: user.email, subject, html, text }, "approval email");
}

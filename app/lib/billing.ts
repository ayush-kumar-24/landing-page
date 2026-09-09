/**
 * Who the subscription is for, and what an invoice for it needs.
 *
 * The pricing page asks one question before a plan is chosen -- personal use
 * or business use -- and, for a business, offers three optional fields: the
 * company name, a GSTIN and a billing address. A founder buying through their
 * company needs those on the invoice to claim input tax credit, and asking
 * for them after the payment means chasing them by email.
 *
 * The answer is kept in the browser (`ally_billing`) and sent with the
 * registration, exactly as attribution.ts's touches are, and it is validated
 * here before it is stored as one JSON column.
 *
 * Nothing in here may fail a registration. Every field is optional, so a value
 * that does not survive validation is dropped and the rest is kept: refusing
 * the whole registration over a mistyped GSTIN would turn an invoicing
 * convenience into a barrier to signing up. The pricing page checks the same
 * shapes while they are being typed, which is where a correction actually
 * helps.
 */

export type BillingUse = "personal" | "business";

export type BillingProfile = {
  v: 1;
  use: BillingUse;
  /** Registered business name, as it should read on the invoice. */
  company?: string;
  /** 15-character GSTIN, uppercased. Absent when not supplied or malformed. */
  gstin?: string;
  /** Billing address, line breaks kept so it prints as it was typed. */
  address?: string;
};

const COMPANY_MAX = 120;
const ADDRESS_MAX = 400;
const GSTIN_LENGTH = 15;

/**
 * A GSTIN: state code, the holder's PAN, an entity number, 'Z', and a
 * checksum character. The shape is checked, not the checksum -- a wrong
 * checksum is a typo the accounts team will catch on the draft invoice, while
 * a checksum implementation that is subtly wrong here would reject valid
 * numbers with no way for the founder to argue.
 */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

// Control characters, which have no place in a company name or an address.
// The second set spares \n, because an address is stored with the line breaks
// it was typed with; a single-line field has already had its newlines
// collapsed into spaces by the time it gets here.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_KEEP_NEWLINES_RE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** Trimmed, capped, control characters removed. Empty becomes undefined. */
function cleanText(value: unknown, max: number, allowNewlines = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = allowNewlines
    ? value.replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n")
    : value.replace(/\s+/g, " ");
  const s = collapsed
    .replace(allowNewlines ? CONTROL_KEEP_NEWLINES_RE : CONTROL_RE, "")
    .trim()
    .slice(0, max)
    .trim();
  return s || undefined;
}

/** Uppercased and stripped of the spaces and dashes people type into it. */
export function normalizeGstin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.replace(/[\s-]/g, "").toUpperCase();
  if (s.length !== GSTIN_LENGTH || !GSTIN_RE.test(s)) return undefined;
  return s;
}

/**
 * Validates what the page sent. Returns null when there is nothing worth
 * keeping, so a founder who never opened the pricing page is not recorded as
 * having answered the question at all.
 */
export function parseBilling(value: unknown): BillingProfile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const use: BillingUse = v.use === "business" ? "business" : "personal";

  if (use === "personal") return { v: 1, use };

  const out: BillingProfile = { v: 1, use };
  const company = cleanText(v.company, COMPANY_MAX);
  const gstin = normalizeGstin(v.gstin);
  const address = cleanText(v.address, ADDRESS_MAX, true);
  if (company) out.company = company;
  if (gstin) out.gstin = gstin;
  if (address) out.address = address;
  return out;
}

/** One line for the team's notification email. */
export function describeBilling(b: BillingProfile | null | undefined): string {
  if (!b) return "not stated";
  if (b.use === "personal") return "personal use";
  const parts = [b.company, b.gstin ? `GSTIN ${b.gstin}` : "", b.address?.replace(/\n+/g, ", ")]
    .filter(Boolean);
  return parts.length
    ? `business use · ${parts.join(" · ")}`
    : "business use (no invoice details given)";
}

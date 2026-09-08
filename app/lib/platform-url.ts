/**
 * Where approved founders go to sign in — the Ally platform, a separate app on
 * a separate origin. Every link from this site to it is built here so the
 * destination lives in exactly one place.
 *
 * PLATFORM_URL overrides the default; unset, it is the production platform in
 * production and the platform's local Vite dev server otherwise, so the flow
 * can be clicked through end to end on one machine.
 */

/* www.goxlally.ai is this site; the platform sits on its own subdomain, which
   founders reach only from a sign-in link or "Go to my dashboard". */
const PRODUCTION_PLATFORM_URL = "https://app.goxlally.ai";
const DEV_PLATFORM_URL = "http://localhost:5173";

export function resolvePlatformUrl(): string {
  const fallback = process.env.NODE_ENV === "production" ? PRODUCTION_PLATFORM_URL : DEV_PLATFORM_URL;
  const raw = process.env.PLATFORM_URL?.trim();
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return fallback;
  }
}

/**
 * The platform's sign-in page, optionally with the founder's email pre-filled.
 *
 * The email rides in the URL FRAGMENT, not the query string: a fragment is
 * never sent to the server, so it appears in no access log, CDN log or
 * Referer header along the way. The platform reads it once on load and
 * immediately strips it from the address bar.
 */
export function platformLoginUrl(email?: string): string {
  const base = `${resolvePlatformUrl()}/guided/login`;
  return email ? `${base}#email=${encodeURIComponent(email)}` : base;
}

/**
 * The sign-in page, for a founder who has just pressed Sign in on this site.
 *
 * Carries `?from=landing`, which is what makes the platform play its splash:
 * that crossing -- from the marketing site into the product -- is the one
 * arrival the splash marks. The invitation links above deliberately do not
 * carry it; a founder opening an email is not making that crossing, and gets
 * the sign-in page straight away. The platform reads the mark once and takes
 * it back out of the address bar.
 *
 * Only the query string; no fragment, so nothing to keep ordered against
 * `#email=`. The server-side target is still fixed -- see /go/login.
 */
export function platformLoginFromLandingUrl(): string {
  return `${platformLoginUrl()}?from=landing`;
}

/** The founder's dashboard. The platform checks the real session on arrival. */
export function platformAppUrl(): string {
  return `${resolvePlatformUrl()}/app`;
}

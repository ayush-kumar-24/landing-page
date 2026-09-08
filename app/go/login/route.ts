import { platformLoginFromLandingUrl } from "../../lib/platform-url";

/**
 * `/go/login` → the platform's sign-in page.
 *
 * The static pages (login.html, the nav) link here rather than hard-coding the
 * platform origin, so the destination is decided in one place and follows
 * PLATFORM_URL — the local Vite dev server while testing, production otherwise.
 * The target is fixed server-side; nothing from the request influences it, so
 * this is not an open redirect.
 *
 * It carries the arrival mark (?from=landing) that tells the platform to play
 * its splash: this redirect is the one way a founder crosses from the
 * marketing site into the product by choice. Invitation emails link to the
 * same page without the mark, on purpose.
 */
export function GET() {
  return new Response(null, {
    status: 302,
    headers: { Location: platformLoginFromLandingUrl(), "Cache-Control": "no-store" },
  });
}

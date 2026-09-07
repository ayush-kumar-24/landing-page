import os from "node:os";
import type { NextConfig } from "next";

/**
 * This machine's LAN addresses, so `next dev` will serve its own dev resources
 * to a phone on the same network.
 *
 * Replaces a hardcoded personal IP that only ever worked on one machine. An
 * empty list was the wrong correction — it locks the dev server to localhost,
 * which is what broke opening the site on a phone.
 */
const lanOrigins = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal)
  .map((i) => i.address);

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  // Google Tag Manager is the only third-party script; GA4 arrives through it
  // (gtag/js is served from the same host). Consent Mode keeps every signal
  // denied until the visitor chooses, so the container alone sets no cookie.
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // GA4's fallback beacon is an image request; the container also loads
  // one for its own diagnostics.
  "img-src 'self' data: blob: https://www.google-analytics.com https://www.googletagmanager.com",
  // GA4 sends its hits to google-analytics.com, or to a regional endpoint
  // when Google routes the visitor there. Named hosts, not wildcards.
  // api.goxlally.ai is the Ally backend. The help widget below the fold asks
  // it real questions against the same 277-answer content the signed-in bot
  // uses; without this entry the browser blocks the call outright and the
  // widget silently falls back to its nine offline answers with nothing in
  // the console to explain why. Named host, not a wildcard.
  "connect-src 'self' https://api.goxlally.ai https://www.googletagmanager.com https://www.google-analytics.com https://analytics.google.com https://region1.google-analytics.com https://region1.analytics.google.com",
  // The no-JavaScript container frame, and the Tag Assistant debug badge.
  "frame-src 'self' https://www.googletagmanager.com",
  "media-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  /**
   * Production only.
   *
   * This rewrites every subresource request to https. The dev server is plain
   * http, so on a phone opening http://<lan-ip>:3000 the browser asked for
   * https://<lan-ip>:3000/assets/... — nothing is listening there, and every
   * image failed while the text rendered fine. It goes unnoticed on localhost,
   * which browsers treat as a secure context and exempt from the upgrade.
   */
  ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  // Phone / LAN: allow Next.js dev JS/CSS/HMR when opened via network IP
  // Set ALLOWED_DEV_ORIGIN to your machine's LAN IP to open the dev server from
  // a phone. Was a hardcoded personal address committed to the repo, which only
  // ever worked for one machine on one network.
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGIN
    ? [process.env.ALLOWED_DEV_ORIGIN]
    : lanOrigins,
  // Hide the floating Next.js “N” badge in development
  devIndicators: false,
  /**
   * `beforeFiles`, not the default bucket.
   *
   * Plain `rewrites()` entries are evaluated AFTER filesystem routes, so
   * `app/page.tsx` matched `/` first and this rewrite never ran — the old
   * `middleware.ts` was silently doing all the work. `beforeFiles` runs ahead
   * of the App Router, which is what actually serves the static landing page
   * here and lets the deprecated middleware convention go away.
   */
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/ally-landing-v2.html" }],
      afterFiles: [],
      fallback: [],
    };
  },
  async redirects() {
    return [
      // Shared Clarity Report links. Before the split, reports were shared as
      // goxlally.ai/r/<token>; those links are in inboxes and chats and cannot
      // be recalled. The product now lives on app., so the address is sent on.
      // Temporary, so a future change of the report host is not cached forever.
      {
        source: "/r/:token",
        destination: "https://app.goxlally.ai/r/:token",
        permanent: false,
      },
      // There is no separate sign-up page: registering IS the form on the home
      // page. The stub that used to live here only added a click before it.
      {
        source: "/signup.html",
        destination: "/#early-access",
        permanent: false,
      },
      // Earlier builds of the landing page. A redirect beats serving them with
      // noindex: robots.txt disallows them, and a crawler that obeys it never
      // fetches the page, so it never sees the noindex either. Permanent, so
      // any link equity moves to the page that replaced them.
      {
        source: "/:old(ally-landing|ally-landing-v1-backup|ally-landing.original).html",
        destination: "/",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      // Earlier builds and the iframe demo: still served so old links resolve,
      // never indexed. robots.ts lists the same paths; the header is what holds
      // when a crawler arrives by a link rather than by robots.txt.
      {
        source: "/:page(ally-platform|ally-landing|ally-landing-v1-backup|ally-dashboard).html",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" }],
      },
      // Everything under /assets carries a .vN in its filename, so a given URL
      // always names the same bytes and can be cached indefinitely. Changing an
      // image means bumping that suffix, which changes the URL — never edit a
      // file in place and leave the name alone, or clients will hold the stale
      // copy for a year.
      //
      // /assets/email/* is deliberately excluded: those URLs are baked into
      // confirmation emails already sitting in people's inboxes, so they can't
      // be renamed. They get a day instead.
      {
        source: "/assets/:path((?!email/).*)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/assets/email/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
};

export default nextConfig;

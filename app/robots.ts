import type { MetadataRoute } from "next";

const siteUrl = "https://www.goxlally.ai";

/**
 * What is kept out of every crawler's index, and why:
 *
 *   /ally-platform.html
 *       an earlier platform build that should not compete with the public site
 *   /ally-dashboard.html
 *       the sample dashboard, an iframe demo with headings of its own that
 *       would otherwise compete with the page embedding it
 *   /api/, /approve, /admin/, /go/, /dev/
 *       endpoints, the approval link, the batch page, redirects, dev tooling
 *
 * Earlier landing-page URLs are NOT disallowed here because next.config.ts
 * permanently redirects them to /. Crawlers need to be able to fetch those
 * URLs to see and follow the redirect.
 *
 * The login page is deliberately NOT listed: it carries its own noindex, and
 * a robots block would stop crawlers from ever reading that.
 */
const disallow = [
  "/ally-platform.html",
  "/ally-dashboard.html",
  "/api/",
  "/approve",
  "/admin/",
  "/go/",
  "/dev/",
];

/**
 * AI crawlers are named explicitly rather than left to the wildcard. Some
 * operators treat an unnamed agent as "not invited", and the site wants to be
 * read by answer engines: llms.txt exists for exactly that. Same rules as
 * everyone else, stated for each.
 */
const aiCrawlers = [
  "GPTBot",
  "OAI-SearchBot",
  "OAI-AdsBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "Amazonbot",
  "meta-externalagent",
  "CCBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow },
      { userAgent: aiCrawlers, allow: "/", disallow },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}

import type { MetadataRoute } from "next";

const siteUrl = "https://www.goxlally.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${siteUrl}/` },
    { url: `${siteUrl}/founder-business-diagnosis` },
    { url: `${siteUrl}/ai-founder-advisor` },
    { url: `${siteUrl}/startup-bottlenecks` },
    { url: `${siteUrl}/founder-priorities` },
    { url: `${siteUrl}/founder-decision-making` },
    { url: `${siteUrl}/what-is-goxl-ally` },
    { url: `${siteUrl}/ally-vs-general-ai` },
    { url: `${siteUrl}/ai-business-advisor-vs-consultant` },
    { url: `${siteUrl}/ai-tools-for-founders` },
    { url: `${siteUrl}/business-health-check-for-founders` },
    { url: `${siteUrl}/about.html` },
    { url: `${siteUrl}/pricing.html` },
    { url: `${siteUrl}/privacy.html` },
    { url: `${siteUrl}/terms.html` },
  ];
}

import type { MetadataRoute } from "next";

const siteUrl = "https://www.goxlally.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${siteUrl}/` },
    { url: `${siteUrl}/founder-business-diagnosis` },
    { url: `${siteUrl}/about.html` },
    { url: `${siteUrl}/pricing.html` },
    { url: `${siteUrl}/privacy.html` },
    { url: `${siteUrl}/terms.html` },
  ];
}

import type { MetadataRoute } from "next";

/** The console is a private staff app: nothing in it belongs in search results. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}

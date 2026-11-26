import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  experimental: {
    // Pages seen in the last 30 s show at once when revisited; every decision's router.refresh() clears them.
    staleTimes: { dynamic: 30, static: 30 },
  },
  // Local checks open the app as 127.0.0.1; Next 16 blocks dev resources from other loopback origins.
  allowedDevOrigins: ["127.0.0.1"],
  // Nobody may frame this app (decisions must not be clickjacked), embed plugins, rewrite its base address or send its forms
  // elsewhere. shortcut: no script-src yet; a nonce for Next's inline scripts is the upgrade if a page ever shows untrusted HTML.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
      ],
    }];
  },
};

export default nextConfig;

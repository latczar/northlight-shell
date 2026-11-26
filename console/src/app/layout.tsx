import type { Metadata, Viewport } from "next";
import { Inter, Manrope } from "next/font/google";
import { GeistMono } from "geist/font/mono";
import { BAR, themeScript } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Northlight", template: "%s · Northlight" },
  description: "Northlight: work with your AI website manager. See what it did, and what needs you.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // the phone's browser bar matches the top bar's charcoal (src/lib/theme.ts keeps it in step with a pinned theme)
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: BAR.light },
    { media: "(prefers-color-scheme: dark)", color: BAR.dark },
  ],
};

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap" });

// Inter for reading, Manrope for headings, Geist Mono for literal strings. The script in <head> applies a pinned theme before the first paint, so <html> may differ from the
// server's render by its data-theme.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${inter.variable} ${manrope.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}

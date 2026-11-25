import type { Metadata } from "next";
import { Bricolage_Grotesque, Manrope, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { PLAYER_NAME, PLAYER_TAGLINE, LOGO_SRC } from "@/lib/config";
import { DebugGuard } from "@/components/debug-guard";
import { TurnstileGate } from "@/components/turnstile-gate";

const body = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: `${PLAYER_NAME} — ${PLAYER_TAGLINE}`,
  description: "An embeddable video player for TMDB titles.",
  icons: { icon: LOGO_SRC, shortcut: LOGO_SRC, apple: LOGO_SRC },
  referrer: "no-referrer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${body.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="referrer" content="no-referrer" />
      </head>
      <body suppressHydrationWarning>
        <DebugGuard />
        <TurnstileGate />
        {children}
      </body>
    </html>
  );
}

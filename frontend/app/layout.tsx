import type { Metadata } from "next";
import Script from "next/script";
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
        <Script id="histats-tracker" strategy="afterInteractive">
          {`var _Hasync= _Hasync|| [];
_Hasync.push(['Histats.start', '1,4989510,4,0,0,0,00010000']);
_Hasync.push(['Histats.fasi', '1']);
_Hasync.push(['Histats.track_hits', '']);
(function() {
var hs = document.createElement('script'); hs.type = 'text/javascript'; hs.async = true;
hs.src = ('//s10.histats.com/js15_as.js');
(document.getElementsByTagName('head')[0] || document.getElementsByTagName('body')[0]).appendChild(hs);
})();`}
        </Script>
        <noscript>
          <a href="/" target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="//sstatic1.histats.com/0.gif?4989510&101"
              alt="website hit counter"
              style={{ border: 0 }}
            />
          </a>
        </noscript>
      </body>
    </html>
  );
}

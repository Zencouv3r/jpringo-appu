import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_JP } from "next/font/google";
import Script from "next/script";
import { TooltipProvider } from "@/components/ui/tooltip";
import { appearanceInitScript } from "@/lib/appearance";
import { colorSchemeInitScript } from "@/lib/color-scheme";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Self-hosted CJK fallback so Japanese text in the transcript/analysis
// always renders with real glyphs instead of a tofu/system default.
const notoSansJP = Noto_Sans_JP({
  variable: "--font-noto-jp",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: "Ringo",
  description:
    "Generate Japanese subtitles for local video files, with a translation and a per-word breakdown you can click through while you watch.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme script below rewrites this element's class list before React
    // hydrates, so the server's markup and the client's DOM legitimately
    // differ here. Without this, that expected difference is reported as a
    // hydration mismatch on every launch.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${notoSansJP.variable} h-full antialiased`}
    >
      {/* All three run before first paint: the theme so a dark-mode user never
          sees a flash of the light one, the interface scale so the window
          doesn't lay itself out at 100% and then reflow, and the colour scheme
          so a recoloured app doesn't show its stock palette first. Each
          script's doc comment explains why the logic is duplicated here rather
          than shared with the hook that owns it.

          The order matters for the last one: it picks a palette by reading the
          `dark` class the theme script has just set, rather than asking the OS
          a second time. */}
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {themeInitScript()}
        </Script>
        <Script id="appearance-init" strategy="beforeInteractive">
          {appearanceInitScript()}
        </Script>
        <Script id="colors-init" strategy="beforeInteractive">
          {colorSchemeInitScript()}
        </Script>
      </head>
      {/* `overflow-hidden` because the app owns its own scroll regions: the
          transcript and the library each scroll independently, and a scrolling
          document would let the video player slide off-screen. */}
      <body className="flex h-full flex-col overflow-hidden bg-background">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}

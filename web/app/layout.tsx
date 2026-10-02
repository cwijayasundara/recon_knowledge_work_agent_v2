import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Affiliate onboarding workbench", description: "Investran exports to Sage Intacct imports" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

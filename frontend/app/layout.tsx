import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AutoTest AI — AI-Driven Playwright Test Generation",
  description: "AI-powered Playwright test generation and execution platform. Generate, run, and self-heal browser tests with LLM assistance.",
};

import AuthInterceptor from "@/components/shared/AuthInterceptor";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Theme initialization: runs synchronously before React hydrates to prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function() {
  try {
    var theme = localStorage.getItem('autotest-theme');
    if (theme !== 'light') {
      document.documentElement.classList.add('dark');
    }
  } catch(e) {}
  })();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AuthInterceptor />
        {children}
      </body>
    </html>
  );
}


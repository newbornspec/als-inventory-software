import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ServiceWorkerRegister } from "./sw-register";
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
  title: "Als Inventory",
  description: "Scan and manage IT assets, online or offline.",
  // Declared explicitly because Next gives app/favicon.ico precedence and never
  // emits a link for app/icon.svg when both exist — which threw away the whole
  // point of the vector: staying sharp at the 16px a browser tab actually uses.
  // Modern browsers take the SVG; the .ico is the fallback, and is still what
  // anything requesting /favicon.ico by convention gets.
  // Only the SVG is listed: Next still emits its own link for app/favicon.ico
  // from the file convention, so naming it here as well just linked it twice.
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: "/apple-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Als Inventory",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* First thing a keyboard reaches on any page: a way past the nav
            straight into the content (WCAG 2.4.1). Every page's <main> carries
            id="main-content" as the target. */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}

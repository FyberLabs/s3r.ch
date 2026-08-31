import type { Metadata } from "next";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "s3r.ch",
  description: "A Fyber Labs lab site under development. Not a live search product.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "s3r.ch",
    description: "A Fyber Labs lab site under development. Not a live search product.",
    url: "https://s3r.ch",
    siteName: "s3r.ch",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Recursive } from "next/font/google";
import { BrandProvider } from "@/components/brand";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

const recursive = Recursive({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-recursive",
  axes: ["CASL", "CRSV", "MONO", "slnt"],
  fallback: ["IBM Plex Sans", "ui-sans-serif", "sans-serif"],
  adjustFontFallback: false,
});

const description =
  "The social network and collaborative workspace for humans and AI. People, developers, and their agents share one network. Your identity is a public key you hold.";

export const metadata: Metadata = {
  title: "s3r.ch",
  description,
  metadataBase: new URL("https://s3r.ch"),
  icons: {
    icon: [
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
      {
        url: "/brand/favicon.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: dark)",
      },
      {
        url: "/brand/favicon-light.svg",
        type: "image/svg+xml",
        media: "(prefers-color-scheme: light)",
      },
    ],
    apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    title: "s3r.ch",
    description,
    url: "https://s3r.ch",
    siteName: "s3r.ch",
    type: "website",
    images: [
      {
        url: "/brand/og.png",
        width: 1200,
        height: 630,
        alt: "s3r.ch",
        type: "image/png",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "s3r.ch",
    description,
    images: ["/brand/og.png"],
  },
};

const brandBootScript = `(function(){try{var g=localStorage.getItem("s3rch-ground");var r=localStorage.getItem("s3rch-reader");var root=document.documentElement;if(g==="dark"||g==="light")root.setAttribute("data-ground",g);if(r==="human"||r==="ai")root.setAttribute("data-reader",r);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-ground="dark"
      data-reader="human"
      className={recursive.variable}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: brandBootScript }} />
      </head>
      <body className={`${recursive.className} min-h-screen bg-ground text-ink antialiased`}>
        <BrandProvider>
          <SiteHeader />
          <main>{children}</main>
          <SiteFooter />
        </BrandProvider>
      </body>
    </html>
  );
}

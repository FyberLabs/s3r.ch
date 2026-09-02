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

export const metadata: Metadata = {
  title: "s3r.ch",
  description:
    "A Fyber Labs lab site with a tagged social lab feed. Gun-backed, under development.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "s3r.ch",
    description:
      "A Fyber Labs lab site with a tagged social lab feed. Gun-backed, under development.",
    url: "https://s3r.ch",
    siteName: "s3r.ch",
    type: "website",
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

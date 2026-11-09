"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ViewRoute } from "@/components/ViewRoute";

export function SavedViewLink() {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const match = /^\/views\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    try {
      return <ViewRoute key={match[1]} id={decodeURIComponent(match[1])} />;
    } catch {
      // Invalid percent encoding does not identify a saved view.
    }
  }
  return <p>Open a saved View from its link.</p>;
}

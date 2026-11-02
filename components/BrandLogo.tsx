"use client";

import { useBrand } from "@/components/brand";

/**
 * Approved s3r.ch wordmark. Paper ground uses the on-light file.
 * Assets live under public/brand.
 */
export function BrandLogo({ className = "h-8 w-auto" }: { className?: string }) {
  const { ground } = useBrand();
  const src =
    ground === "light" ? "/brand/wordmark-on-light.svg" : "/brand/wordmark.svg";

  return (
    <img
      src={src}
      alt="s3r.ch"
      width={160}
      height={48}
      className={className}
    />
  );
}

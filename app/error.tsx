"use client";
import { useEffect } from "react";
export default function ErrorPage({error,reset}: {error: Error; reset:()=>void}) {
  useEffect(() => { window.dispatchEvent(new Event("s3rch:render-error")); },[error]);
  return <section role="alert"><p>This page could not load.</p><button onClick={reset}>Try again</button></section>;
}

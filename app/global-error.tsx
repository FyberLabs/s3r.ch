"use client";
import { useEffect } from "react";
export default function GlobalError({error,reset}: {error: Error; reset:()=>void}) {
  useEffect(() => { window.dispatchEvent(new Event("s3rch:render-error")); },[error]);
  return <html lang="en"><body><main role="alert"><p>The site could not load.</p><button onClick={reset}>Try again</button></main></body></html>;
}

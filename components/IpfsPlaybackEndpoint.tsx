"use client";

export function IpfsPlaybackEndpoint({value,onChange,disabled}: {
  value:string; onChange:(value:string)=>void; disabled?:boolean;
}) {
  return <label className="block text-sm">
    IPFS playback endpoint (optional)
    <input type="url" className="block w-full border p-2" value={value} maxLength={512}
      disabled={disabled} onChange={event=>onChange(event.target.value)} />
    <span className="text-ink-muted">Use a trusted HTTPS block endpoint. This address stays in this tab.</span>
  </label>;
}

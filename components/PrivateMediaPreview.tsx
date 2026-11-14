import { PostContent, postCardClassName } from "./PostContent";
import { mediaPreviewKind } from "@/lib/media-preview";
export function PrivateMediaPreview({preview}: {preview:{url:string;name:string;mediaType:string;tags?:readonly string[]}}) {
  const kind=mediaPreviewKind(preview.mediaType);
  if(!kind || !preview.url.startsWith("blob:"))return null;
  return <article className={postCardClassName} aria-label="Private media post">
    <PostContent title={preview.name} kind={kind} tags={preview.tags?.map(tag=>`#${tag}`)} tagsLabel="Image tags">
    <figure className="mt-3 space-y-2">
    {kind==="image" ?
      // Decrypted bytes stay in a temporary browser URL, never an image optimizer.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={preview.url} alt={preview.name} className="max-h-[70vh] max-w-full object-contain" /> :
      kind==="audio" ? <audio controls preload="metadata" src={preview.url} aria-label={preview.name} className="w-full" /> :
      <video controls playsInline preload="metadata" src={preview.url} aria-label={preview.name} className="max-h-[70vh] max-w-full" />}
    <figcaption>{preview.name}</figcaption>
    </figure>
    </PostContent>
  </article>;
}

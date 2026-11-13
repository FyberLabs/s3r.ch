/** Only inert browser media formats supported by the encrypted file envelope. */
export function mediaPreviewKind(type: string): "image" | "audio" | "video" | null {
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(type)) return "image";
  if (/^audio\/(mpeg|ogg|wav|webm|mp4)$/.test(type)) return "audio";
  if (/^video\/(mp4|webm|ogg)$/.test(type)) return "video";
  return null;
}

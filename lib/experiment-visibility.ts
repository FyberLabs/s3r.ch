/** Initial observer notifications can intersect below the configured threshold. */
export function experimentHeadingVisible(entries: readonly { isIntersecting: boolean; intersectionRatio: number }[]): boolean {
  return entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.5);
}

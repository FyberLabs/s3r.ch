import { normalizeTags } from "./feed-types";
/** Descriptive only; keep private tags inside authenticated ciphertext. */
export function privateMediaTags(input:unknown):readonly string[] {
  if(!Array.isArray(input)||input.length>12||input.some(tag=>typeof tag!=="string"||tag.length>40||!tag.isWellFormed()||/[\u0000-\u001f\u007f]/.test(tag)))
    throw Error("Use up to 12 tags of 40 characters each.");
  const tags=normalizeTags(input);
  if(tags.some(tag=>tag.length>40))throw Error("Use up to 12 tags of 40 characters each.");
  return Object.freeze(tags);
}

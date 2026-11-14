import { isCanonicalObjectId } from "./identity/object-id";
import { objectPrincipal } from "./identity/forum-authority-records";

export type MediaCatalogPage = { at: number; objects: string[]; nextPage: number | null };
export const isMediaCatalogPageNumber = (page: unknown): page is number =>
  Number.isInteger(page) && (page as number) >= 0 && (page as number) < 16;

/** Navigation only: each open/write still requires current protected authorization. */
export function parseMediaCatalogPage(value: unknown, page: number, principal: string): MediaCatalogPage {
  if (!isMediaCatalogPageNumber(page) || !value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid media catalog");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== "at,nextPage,objects" || !Number.isSafeInteger(row.at) || (row.at as number) < 0 ||
      row.nextPage !== (page < 15 ? page + 1 : null) || !Array.isArray(row.objects) || row.objects.length > 4 ||
      new Set(row.objects).size !== row.objects.length || row.objects.some(object => typeof object !== "string" ||
        !object.startsWith("media_") || !isCanonicalObjectId(object) || objectPrincipal(object) !== principal)) throw Error("Invalid media catalog");
  return { at: row.at as number, objects: [...row.objects] as string[], nextPage: row.nextPage as number | null };
}

export type MediaCleanupItem = Readonly<{object:string;command:string}>;
export function parseMediaCleanupPage(value:unknown,page:number,principal:string) {
  if(!value || typeof value!=="object" || Array.isArray(value))throw Error("Invalid cleanup catalog");
  const row=value as Record<string,unknown>;
  if(!Array.isArray(row.objects) || row.objects.some(item=>!item || typeof item!=="object" || Array.isArray(item) ||
    Object.keys(item).sort().join()!=="command,object" || typeof item.command!=="string" || !/^[0-9a-f]{64}$/.test(item.command)))
    throw Error("Invalid cleanup catalog");
  const parsed=parseMediaCatalogPage({...row,objects:row.objects.map(item=>item.object)},page,principal);
  return {...parsed,objects:row.objects.map(item=>Object.freeze({object:item.object as string,command:item.command as string}))};
}

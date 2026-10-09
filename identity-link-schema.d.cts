import type { LinkStore } from "./lib/identity/link";
export function parseLinkFile(value: unknown): ReturnType<LinkStore["load"]>;

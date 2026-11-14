/** Undefined means observation is disabled or unresolved, not signed out. */
export function mineOwnerChanged(previous: string | null, observed: string | null | undefined): boolean {
  return observed !== undefined && observed !== previous;
}

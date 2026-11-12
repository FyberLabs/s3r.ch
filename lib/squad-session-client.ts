import { createSeaSessionClient } from "./identity/sea-session-client";
import { squadView, type LiveSquadSpec } from "./squad-view";

/** Compatibility adapter: identity proof belongs to the shared site issuer. */
export function createSquadSessionClient(input: Parameters<typeof createSeaSessionClient>[0] & { squad: LiveSquadSpec }) {
  if (!squadView(input.squad).live) throw Error("Explicit HTTPS session scope required");
  return createSeaSessionClient(input);
}

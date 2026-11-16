import { parseTerminalScope } from "./terminal-run-client";
import { withTerminalIdentityPolicy } from "./terminal-run";
/** Uninstalled classifier for verified native identities. A missing grant is not
 * evidence of unrelated traffic. Copy the declared deployment scope before use. */
export function createTerminalFixturePolicy(scopes: readonly unknown[]) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > 2) throw Error("Terminal fixture configuration unavailable");
  const declared = scopes.map(parseTerminalScope);
  if (new Set(declared.map(scope => scope.suite)).size !== declared.length) throw Error("Terminal fixture configuration unavailable");
  const subjects = new Set(declared.flatMap(scope => [scope.subject, ...scope.identities.sea]));
  return <T>(work: () => Promise<T>): Promise<T> => withTerminalIdentityPolicy(token => token.subject !== null && subjects.has(token.subject), work);
}

import { getAddress } from "viem";
import { MESH_LINK_STATEMENT } from "./config";
import { isAllowedSiweDomain } from "./siwe";

export { MESH_LINK_STATEMENT };

export type MeshLinkStatementInput = {
  domain: string;
  uri: string;
  address: string;
  seaPub: string;
};

/**
 * Short domain-bound statement the wallet signs: this SEA `pub` belongs to
 * this checksummed address. Session subject stays the address, never the pub.
 * Do not put this payload or its signature on the public Gun graph.
 */
export function buildMeshLinkStatement(input: MeshLinkStatementInput): string {
  const binding = assertMeshLinkBinding(input);
  return [
    MESH_LINK_STATEMENT,
    `Domain: ${binding.domain}`,
    `URI: ${binding.uri}`,
    `Address: ${binding.address}`,
    `SEA pub: ${input.seaPub}`,
  ].join("\n");
}

export function assertMeshLinkBinding(input: {
  domain: string;
  uri: string;
  address: string;
}): { domain: string; uri: string; address: string } {
  if (!isAllowedSiweDomain(input.domain)) {
    throw new Error("Mesh link domain is not allowed.");
  }
  let parsed: URL;
  try {
    parsed = new URL(input.uri);
  } catch {
    throw new Error("Mesh link URI is not valid.");
  }
  if (!isAllowedSiweDomain(parsed.host)) {
    throw new Error("Mesh link URI host is not allowed.");
  }
  if (parsed.host.toLowerCase() !== input.domain.toLowerCase()) {
    throw new Error("Mesh link domain does not match URI.");
  }
  return {
    domain: input.domain,
    uri: input.uri,
    address: getAddress(input.address),
  };
}

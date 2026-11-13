/** Sale and cross-context advertising sharing are disabled site-wide. Signals
 * may strengthen that choice; their absence is never opt-in consent. */
export function privacyPreferences(secGpc: string | null, navigatorGpc?: unknown) {
  return Object.freeze({ globalPrivacyControl: secGpc === "1" || navigatorGpc === true,
    saleAllowed: false as const, sharingAllowed: false as const });
}

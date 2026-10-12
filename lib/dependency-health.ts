/**
 * Optional integration settings, reported by /api/health. Missing settings are
 * not an error: the site runs without them and hides the matching features.
 */
type EnvLike = Record<string, string | undefined>;

const SERVICES = {
  payments: "PANOPTICON_PAYMENTS_BASE",
  oracles: "PANOPTICON_ORACLES_BASE",
  turn: "PANOPTICON_TURN_BASE",
} as const;

export function panopticonHealth(env: EnvLike = process.env) {
  const services = Object.fromEntries(
    Object.entries(SERVICES).map(([name, key]) => [
      name,
      { status: String(env[key] ?? "").trim() ? "configured" : "not-configured" },
    ]),
  ) as Record<keyof typeof SERVICES, { status: "configured" | "not-configured" }>;
  const anyConfigured = Object.values(services).some((service) => service.status === "configured");
  return { status: anyConfigured ? "configured" : "not-configured", services };
}

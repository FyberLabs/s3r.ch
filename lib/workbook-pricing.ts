export type PricingInputs = { quantity: number; unitPriceCents: number; discountBps: number };

export const pricingSheet = "Pricing";
export const pricingFormula = "ROUND(B2*B3*(1-B4),2)";
export const pricingTotalCell = "B5";

export function parsePricingInputs(value: unknown): PricingInputs | null {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).join() !== "discountBps,quantity,unitPriceCents") return null;
  const inputs = value as PricingInputs;
  const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
  if (!integer(inputs.quantity, 1, 100_000) || !integer(inputs.unitPriceCents, 0, 100_000_000) ||
      !integer(inputs.discountBps, 0, 10_000)) return null;
  return { quantity: inputs.quantity, unitPriceCents: inputs.unitPriceCents || 0, discountBps: inputs.discountBps || 0 };
}

export function pricingTotalCents(inputs: PricingInputs): number {
  const scaled = BigInt(inputs.quantity) * BigInt(inputs.unitPriceCents) * BigInt(10_000 - inputs.discountBps);
  return Number((scaled + 5_000n) / 10_000n);
}

export function pricingAnchor(value: unknown): string | null {
  if (typeof value !== "string" || !/^[AB][1-5](?::[AB][1-5])?$/.test(value)) return null;
  const [first, last] = value.split(":");
  if (last && (first[0] > last[0] || first[1] > last[1])) return null;
  return value;
}

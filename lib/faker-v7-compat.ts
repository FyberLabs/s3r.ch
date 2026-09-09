/**
 * @farcaster/core@0.20.0 still calls faker v7 APIs (and Factory.build)
 * while the module evaluates. The CVE override installs @faker-js/faker
 * >=10.5.0, which dropped datatype.number, random.alphaNumeric, and the
 * two-arg date.between. Patch both the ESM and CJS singletons before
 * that import (tsx / Next may load either copy).
 *
 * Import this module before @farcaster/core (see farcaster-outbound.ts).
 */

import { createRequire } from "node:module";
import { faker } from "@faker-js/faker";

type NumberOpts = { min?: number; max?: number } | number | undefined;
type DatetimeOpts = { min?: number; max?: number } | undefined;

type FakerV7Aliases = typeof faker & {
  datatype: typeof faker.datatype & {
    number: (opts?: NumberOpts) => number;
    datetime: (opts?: DatetimeOpts) => Date;
  };
  random: { alphaNumeric: (count?: number) => string };
};

function applyV7Aliases(target: typeof faker): void {
  const aliased = target as FakerV7Aliases;

  if (typeof aliased.datatype.number !== "function") {
    aliased.datatype.number = (opts) => {
      if (typeof opts === "number") return target.number.int(opts);
      return target.number.int({
        min: opts?.min ?? 0,
        max: opts?.max ?? Number.MAX_SAFE_INTEGER,
      });
    };
  }

  if (typeof aliased.datatype.datetime !== "function") {
    aliased.datatype.datetime = (opts) =>
      target.date.between({
        from: opts?.min ?? 0,
        to: opts?.max ?? Date.now(),
      });
  }

  if (typeof aliased.random?.alphaNumeric !== "function") {
    aliased.random = {
      alphaNumeric: (count = 1) => target.string.alphanumeric(count),
    };
  }

  const dateBetween = target.date.between.bind(target.date);
  target.date.between = ((
    fromOrOpts:
      | Date
      | number
      | string
      | { from: Date | number | string; to: Date | number | string },
    to?: Date | number | string,
  ) => {
    if (
      fromOrOpts instanceof Date ||
      typeof fromOrOpts === "string" ||
      typeof fromOrOpts === "number"
    ) {
      return dateBetween({ from: fromOrOpts, to: to ?? Date.now() });
    }
    return dateBetween(fromOrOpts);
  }) as typeof target.date.between;
}

applyV7Aliases(faker);

try {
  const required = createRequire(import.meta.url)("@faker-js/faker") as {
    faker?: typeof faker;
  } & typeof faker;
  applyV7Aliases(required.faker ?? required);
} catch {
  // ESM-only loaders without require(esm)
}

/**
 * @farcaster/core@0.20.0 still calls faker v7 APIs (and Factory.build)
 * while the module evaluates. The CVE override installs @faker-js/faker
 * >=10.5.0, which dropped datatype.number, random.alphaNumeric, and the
 * two-arg date.between. Patch every Node-reachable singleton before
 * that import (tsx ESM, CJS require, Next server collect).
 *
 * Next/Turbopack must list @faker-js/faker in serverExternalPackages
 * next to @farcaster/core. Otherwise the bundler inlines faker into the
 * app chunk, this file mutates that copy, and core still loads Node's
 * unpatched instance (`faker.datatype.number is not a function` while
 * collecting /api/outbound).
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

const DATE_BETWEEN_V7 = Symbol.for("s3rch.faker.v7.date.between");

function applyV7Aliases(target: typeof faker): void {
  const aliased = target as FakerV7Aliases;
  if (!aliased.datatype || typeof aliased.datatype !== "object") {
    (aliased as { datatype: FakerV7Aliases["datatype"] }).datatype = {
      boolean: target.datatype.boolean.bind(target.datatype),
    } as FakerV7Aliases["datatype"];
  }

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

  const currentBetween = target.date.between as typeof target.date.between & {
    [DATE_BETWEEN_V7]?: true;
  };
  if (currentBetween[DATE_BETWEEN_V7]) return;

  const dateBetween = currentBetween.bind(target.date);
  const wrapped = ((
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
  }) as typeof target.date.between & { [DATE_BETWEEN_V7]?: true };
  wrapped[DATE_BETWEEN_V7] = true;
  target.date.between = wrapped;
}

function patchRequiredCopy(requireFaker: NodeRequire): void {
  const required = requireFaker("@faker-js/faker") as {
    faker?: typeof faker;
  } & typeof faker;
  applyV7Aliases(required.faker ?? required);
}

applyV7Aliases(faker);

try {
  patchRequiredCopy(createRequire(import.meta.url));
} catch {
  try {
    patchRequiredCopy(createRequire(`${process.cwd()}/package.json`));
  } catch {
    // ESM-only loaders without require(esm)
  }
}

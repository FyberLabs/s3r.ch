/** Current-key proof receipts for the app receive paths. Saved replay floors,
 * parsed objects and signatures alone are not display or roster admission. */
export function createForumReceiveProofs(input: {
  key: (principal: string) => string | null;
  ready: () => boolean;
  verify: (signature: string, key: string) => Promise<unknown>;
}) {
  type Receipt = { keys: readonly (readonly [string, string])[]; content: string; allowed: () => boolean };
  let inFlight = 0;
  let operations = 0, receipts = new WeakMap<object, Receipt>();
  const admissions = new Map<string, object>();
  const content = (row: object) => {
    try { const s = JSON.stringify(row); return s && s.length <= 32768 ? s : null; } catch { return null; }
  };
  const keysCurrent = (keys: readonly (readonly [string, string])[]) => keys.every(([principal, key]) => input.key(principal) === key);
  const valid = (row: object | null | undefined): boolean => {
    if (!row || !input.ready()) return false;
    const held = receipts.get(row);
    return !!held && held.content === content(row) && keysCurrent(held.keys) && held.allowed();
  };
  return {
    ready: input.ready, valid,
    // Network loss fences pending work but retained signed receipts still need
    // current authority before reuse. Reset is for a new source/connection.
    interrupt() { operations++; },
    reset() { operations++; receipts = new WeakMap(); admissions.clear(); },
    enrolled(principal: string) { return valid(admissions.get(principal)); },
    enroll(principal: string, row: object) {
      if (!valid(row) || (!admissions.has(principal) && admissions.size >= 128)) return false;
      admissions.set(principal, row); return true;
    },
    begin() {
      const operation = operations, keys = new Map<string, string>();
      let conflict = false;
      const dependencies: (() => boolean)[] = [];
      const current = () => operation === operations && !conflict && keysCurrent([...keys]) && dependencies.every(check => check());
      return {
        current,
        async read(sig: string, principal: string): Promise<unknown> {
          if (inFlight >= 32 || !current() || typeof sig !== "string" || sig.length > 32768) return null;
          const key = input.key(principal); if (!key) return null;
          inFlight++;
          try {
            const row = await input.verify(sig, key);
            if (!row || !current() || input.key(principal) !== key) return null;
            if (keys.has(principal) && keys.get(principal) !== key) { conflict = true; return null; }
            keys.set(principal, key);
            return row;
          } catch { return null; } finally { inFlight--; }
        },
        depend(row: object | null | undefined) {
          if (!valid(row)) return false;
          const receipt = receipts.get(row!)!;
          dependencies.push(() => receipt.content === content(row!) && receipt.allowed());
          for (const [principal, key] of receipt.keys) {
            if (keys.has(principal) && keys.get(principal) !== key) conflict = true;
            keys.set(principal, key);
          }
          return current();
        },
        retain(row: object, allowed: () => boolean = () => true) {
          const body = content(row);
          if (!keys.size || !current() || !body || !allowed()) return false;
          receipts.set(row, { keys: [...keys], content: body, allowed: () => allowed() && dependencies.every(check => check()) });
          return true;
        },
      };
    },
  };
}

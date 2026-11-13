import assert from "node:assert/strict";

// The scheduled caller supplies browser operations and Date.now. Unit tests
// supply fake operations; this helper never launches a browser itself.
export async function checkExperimentExpiry({ assignment, latest, offline, wait, now, label, recover, passed }) {
  assert.equal(assignment.variant, "create", "Declared TEST treatment required for visible expiry");
  assert.match(assignment.cohort, /^[a-f0-9]{64}$/);
  // A valid cached response can be near expiry. Wait online for a usable
  // observation window rather than attributing fixture timing to the browser.
  const readyUntil = now() + 75000;
  while (true) {
    const candidate = latest();
    assert.equal(candidate.variant, assignment.variant);
    assert.equal(candidate.cohort, assignment.cohort);
    assert.ok(Number.isFinite(candidate.expiresAt));
    const remaining = candidate.expiresAt * 1000 - now();
    assert.ok(remaining <= 300000, "Bounded display required");
    if (remaining > 10000) break;
    assert.ok(now() < readyUntil, "Fresh display window unavailable");
    await wait(250);
  }
  let disconnected = false;
  try {
    await offline(true); disconnected = true;
    // Existing product requests have a five-second timeout. Let those settle
    // before choosing the final observed deadline; never inject a clock.
    await wait(5500);
    const before = latest();
    assert.equal(before.variant, "create");
    assert.equal(before.cohort, assignment.cohort);
    assert.ok(Number.isFinite(before.expiresAt));
    const deadline = before.expiresAt * 1000;
    const remaining = deadline - now();
    assert.ok(remaining > 2500 && remaining <= 300000, "Live bounded display required");
    await label("create");
    await wait(Math.max(0, deadline - now() - 2000));
    await label("create");
    await wait(Math.max(0, deadline - now() + 1000));
    await label("control");
    passed("browser-display-expires-offline");
    await offline(false); disconnected = false;
    const after = await recover(before);
    assert.ok(Number.isFinite(after.expiresAt) && after.expiresAt * 1000 > now() && after.expiresAt > before.expiresAt);
    assert.equal(after.cohort, assignment.cohort);
    assert.equal(after.variant, assignment.variant);
    await label("create");
    passed("browser-display-recovers-online");
  } finally {
    if (disconnected) await offline(false);
  }
}

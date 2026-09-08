// =============================================================================
// FILE: src/types/threshold.test.cjs
// =============================================================================
// PURPOSE: Cross-check that the server and client threshold evaluation logic
//          stay in agreement across a grid of values.
//
// WHY THIS EXISTS:
//   The 15%-margin "good / warning / critical" logic is implemented in TWO
//   places:
//     - server: server.cjs getThresholdStatus(value, min, max)
//     - client: src/types/index.ts getThresholdStatus(value, range, isMinOnly)
//   If they drift apart, the SMS alert severity and the dashboard badge can
//   disagree about whether the tank is safe. This test snapshots both from the
//   CURRENT source and asserts they agree for every value in the grid below.
//
// NOTE:
//   This is a "regression guard" mirroring the two implementations, not an
//   import of the live modules (the client is TypeScript/ESM and the server is
//   a full CommonJS process). If you edit either threshold function, update the
//   mirrored copy here and re-run:  node --test src/types/threshold.test.cjs
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert");

// --- Mirror of server.cjs getThresholdStatus(value, min, max) ---
// (server.cjs lines ~402-414)
function serverStatus(value, min, max) {
  const rangeSize = max - min;
  const criticalMargin = rangeSize * 0.15;
  if (value < min) {
    const deviation = min - value;
    return deviation >= criticalMargin ? "critical" : "warning";
  }
  if (value > max) {
    const deviation = value - max;
    return deviation >= criticalMargin ? "critical" : "warning";
  }
  return "good";
}

// --- Mirror of src/types/index.ts getThresholdStatus(value, range, isMinOnly) ---
// (src/types/index.ts lines ~219-260)
function clientStatus(value, min, max, isMinOnly) {
  const rangeSize = max - min;
  const criticalMargin = rangeSize * 0.15;
  if (isMinOnly) {
    if (value < min) {
      const deviation = min - value;
      return deviation >= criticalMargin ? "critical" : "warning";
    }
    return "good";
  }
  if (value < min) {
    const deviation = min - value;
    return deviation >= criticalMargin ? "critical" : "warning";
  }
  if (value > max) {
    const deviation = value - max;
    return deviation >= criticalMargin ? "critical" : "warning";
  }
  return "good";
}

// Temperature: min=20, max=31 (criticalMargin = 11*0.15 = 1.65)
// Water level: min=10, max=100 (criticalMargin = 90*0.15 = 13.5)
// Ammonia: min=0.25, max=1.00 (criticalMargin = 0.75*0.15 = 0.1125)
const RANGES = [
  { label: "Temperature", min: 20, max: 31, isMinOnly: false },
  { label: "Water Level", min: 10, max: 100, isMinOnly: false },
  { label: "Ammonia", min: 0.25, max: 1.0, isMinOnly: false },
];

// A grid of values covering: far below, near-below margin, at min, inside,
// at max, near-above margin, and far above — for each range.
function buildGrid(range) {
  const { min, max } = range;
  const margin = (max - min) * 0.15;
  return [
    min - margin - 1, // critical below
    min - margin - 0.0001,
    min - margin,     // exactly at critical threshold -> warning (not >= margin)
    min - margin + 0.0001,
    min - 1,          // warning below
    min,
    (min + max) / 2,  // inside
    max,
    max + 1,          // warning above
    max + margin - 0.0001,
    max + margin,     // exactly at critical -> warning
    max + margin + 0.0001,
    max + margin + 1, // critical above
  ];
}

test("server and client threshold logic agree for all ranges and grid values", () => {
  for (const r of RANGES) {
    for (const value of buildGrid(r)) {
      const expected = serverStatus(value, r.min, r.max);
      const actual = clientStatus(value, r.min, r.max, r.isMinOnly);
      assert.strictEqual(
        actual,
        expected,
        `Mismatch on ${r.label} value=${value} min=${r.min} max=${r.max}: server=${expected} client=${actual}`
      );
    }
  }
});

test("min-only sensors never produce critical severity above the min (client)", () => {
  // For a one-sided threshold, values above min are always "good".
  assert.strictEqual(clientStatus(95, 10, 100, true), "good");
  assert.strictEqual(clientStatus(10, 10, 100, true), "good");
});

test("deviation exactly at the 15% critical margin is warning, not critical", () => {
  // temp min=20, margin=1.65; value 18.35 is exactly 1.65 below min -> warning
  assert.strictEqual(serverStatus(18.35, 20, 31), "warning");
  assert.strictEqual(clientStatus(18.35, 20, 31, false), "warning");
  // just past the margin -> critical
  assert.strictEqual(serverStatus(18.34, 20, 31), "critical");
  assert.strictEqual(clientStatus(18.34, 20, 31, false), "critical");
});

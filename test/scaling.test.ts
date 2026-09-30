import { describe, expect, it } from "vitest";
import { classifyDocument, splitSentences } from "../src/index.js";

// Adversarial inputs that made the 0.1.1 splitter quadratic. Each case has a
// hard time budget (generous for a slow CI runner, far below what the old
// code needed) and the bracket family also has a scaling check.
const TIME_BUDGET_MS = 500;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function fastest(fn: () => unknown, samples: number): number {
  fn(); // warm up
  let best = Infinity;
  for (let i = 0; i < samples; i++) best = Math.min(best, timed(fn).ms);
  return best;
}

const nested = (pairs: number) => "[".repeat(pairs) + "x" + "]".repeat(pairs);

describe("GK-F01: matched-bracket shielding is linear", () => {
  it("keeps 100,000 characters of nested matched brackets as one unit within budget", () => {
    const input = nested(50_000);
    expect(input.length).toBe(100_001);
    const { value, ms } = timed(() => splitSentences(input));
    expect(value).toEqual([input]);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("grows about linearly: 4x the nested pairs takes far less than 16x the time", () => {
    // Linear growth gives about 4x, quadratic about 16x. The threshold sits
    // between them with room for noise, and each size uses its fastest of
    // seven runs so a stray pause cannot fake a slowdown.
    const small = nested(50_000);
    const large = nested(200_000);
    const smallMs = fastest(() => splitSentences(small), 7);
    const largeMs = fastest(() => splitSentences(large), 7);
    // Guard the divisor so a near-zero reading cannot hide a regression.
    expect(largeMs / Math.max(smallMs, 0.5)).toBeLessThan(8);
  });

  it("still splits at a separator that sits outside every matched pair", () => {
    const text = `${"[".repeat(1000)}a; b${"]".repeat(999)}; tail`;
    // 1000 opens, 999 closes: the outermost '[' is unmatched, the inner 999
    // pairs still shield the inner ';'.
    expect(splitSentences(text)).toEqual([`${"[".repeat(1000)}a; b${"]".repeat(999)}`, "tail"]);
  });
});

// Each family below was quadratic in 0.1.1. For every one, 4x the input must
// cost well under 16x the time (linear is about 4x), and the large input must
// also finish inside a loose absolute budget.
function expectRoughlyLinear(build: (n: number) => string, n: number): void {
  const small = build(n);
  const large = build(n * 4);
  const smallMs = fastest(() => splitSentences(small), 5);
  const largeMs = fastest(() => splitSentences(large), 5);
  expect(largeMs / Math.max(smallMs, 0.5)).toBeLessThan(8);
  expect(largeMs).toBeLessThan(1000);
}

describe("other quadratic inputs found by the fix-pass review", () => {
  it("handles many cited sentences (marker adjacency was quadratic)", () => {
    const build = (n: number) => "Foo bar [[cite:e1]]. ".repeat(n);
    expect(splitSentences(build(1000))).toHaveLength(1000);
    expectRoughlyLinear(build, 12_500);
  });

  it("handles many leading markers after one sentence", () => {
    const build = (n: number) => `Claim. ${"[[cite:e1]] ".repeat(n)}Next.`;
    expect(splitSentences(build(1000))).toHaveLength(2);
    expectRoughlyLinear(build, 25_000);
  });

  it("handles a long run of unclosed default placeholders", () => {
    const build = (n: number) => "[TK".repeat(n);
    expect(splitSentences(build(1000))).toEqual([build(1000)]);
    expectRoughlyLinear(build, 15_000);
  });

  it("handles a long run of letters that ends in a digit and a period", () => {
    // The trailing-word regex retried its unbounded scan from every start.
    const build = (n: number) => `${"a".repeat(n)}1.`;
    expect(splitSentences(build(1000))).toEqual([build(1000)]);
    expectRoughlyLinear(build, 25_000);
  });

  it("handles a long run of letter-dot pairs that ends in a digit and a period", () => {
    const build = (n: number) => `${"a.".repeat(n)}1.`;
    expect(splitSentences(build(10)).join("")).toBe(build(10));
    expectRoughlyLinear(build, 12_500);
  });

  it("classifies a large cited document in linear time", () => {
    const build = (n: number) => "Foo bar [[cite:e1]]. ".repeat(n);
    const run = (n: number) => () => classifyDocument(build(n), { e1: "foo bar" });
    expect(run(1000)().counts.grounded).toBe(1000);
    const smallMs = fastest(run(12_500), 5);
    const largeMs = fastest(run(50_000), 5);
    expect(largeMs / Math.max(smallMs, 0.5)).toBeLessThan(8);
  });
});

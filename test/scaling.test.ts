import { describe, expect, it } from "vitest";
import { classifyDocument, splitSentences } from "../src/index.js";

// Adversarial inputs that made the 0.1.1 splitter quadratic. Each case has a
// hard time budget (generous for a slow CI runner, far below what the old
// code needed) and the bracket family also has a scaling check.
const TIME_BUDGET_MS = 500;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = Date.now();
  const value = fn();
  return { value, ms: Date.now() - start };
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
    const small = nested(20_000);
    const large = nested(80_000);
    const smallMs = fastest(() => splitSentences(small), 7);
    const largeMs = fastest(() => splitSentences(large), 7);
    // Guard the divisor so a 0 ms reading cannot hide a regression.
    expect(largeMs / Math.max(smallMs, 1)).toBeLessThan(8);
  });

  it("still splits at a separator that sits outside every matched pair", () => {
    const text = `${"[".repeat(1000)}a; b${"]".repeat(999)}; tail`;
    // 1000 opens, 999 closes: the outermost '[' is unmatched, the inner 999
    // pairs still shield the inner ';'.
    expect(splitSentences(text)).toEqual([`${"[".repeat(1000)}a; b${"]".repeat(999)}`, "tail"]);
  });
});

describe("other quadratic inputs found by the fix-pass review", () => {
  it("handles 50,000 cited sentences (marker adjacency was quadratic)", () => {
    const input = "Foo bar [[cite:e1]]. ".repeat(50_000);
    const { value, ms } = timed(() => splitSentences(input));
    expect(value).toHaveLength(50_000);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("handles 100,000 leading markers after one sentence", () => {
    const input = `Claim. ${"[[cite:e1]] ".repeat(100_000)}Next.`;
    const { value, ms } = timed(() => splitSentences(input));
    expect(value).toHaveLength(2);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("handles a long run of unclosed default placeholders", () => {
    const input = "[TK".repeat(33_000);
    const { value, ms } = timed(() => splitSentences(input));
    expect(value).toEqual([input]);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("handles a long run of letters that ends in a digit and a period", () => {
    // The trailing-word regex retried its unbounded scan from every start.
    const input = `${"a".repeat(100_000)}1.`;
    const { value, ms } = timed(() => splitSentences(input));
    expect(value).toEqual([input]);
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("handles a long run of letter-dot pairs that ends in a digit and a period", () => {
    const input = `${"a.".repeat(50_000)}1.`;
    const { value, ms } = timed(() => splitSentences(input));
    expect(value.join("")).toBe(input.replace(/ /g, ""));
    expect(ms).toBeLessThan(TIME_BUDGET_MS);
  });

  it("classifies a 50,000-sentence cited document within budget", () => {
    const input = "Foo bar [[cite:e1]]. ".repeat(50_000);
    const { value, ms } = timed(() => classifyDocument(input, { e1: "foo bar" }));
    expect(value.counts.grounded).toBe(50_000);
    expect(ms).toBeLessThan(2000);
  });
});

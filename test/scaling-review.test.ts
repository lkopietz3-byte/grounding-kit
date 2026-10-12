import { describe, expect, it } from "vitest";
import { classifyDocument, defaultSupports, splitSentences, type ClassifyConfig } from "../src/index.js";

// Inputs from the 2662560 and 2042351 reviews (Codex and the false-pass
// hunt) that were quadratic, checked at 20k and 80k characters (or 4x more
// items), by CPU time. Linear code takes about 4x longer; quadratic about
// 16x. The limit leaves room for a noisy runner.
const GROWTH = 4;
const SCALING_LIMIT = 12;

// CPU time of this process, in milliseconds. Wall-clock time on a busy
// machine measures the machine, not the code.
declare const process: { cpuUsage(previous?: { user: number; system: number }): { user: number; system: number } };

function cpuMs(fn: () => unknown): number {
  const start = process.cpuUsage();
  fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

function fastest(fn: () => unknown, samples = 5): number {
  fn();
  let best = Infinity;
  for (let i = 0; i < samples; i++) best = Math.min(best, cpuMs(fn));
  return best;
}

function expectLinear(run: (n: number) => unknown, n = 20_000): void {
  const small = fastest(() => run(n));
  const large = fastest(() => run(n * GROWTH));
  expect(large / Math.max(small, 2)).toBeLessThan(SCALING_LIMIT);
  expect(large).toBeLessThan(2000);
}

const md: ClassifyConfig = { markdown: true };

describe("review inputs stay linear", { timeout: 30_000 }, () => {
  it("a long letter run, a digit, then a capitalized wrapped line (markdown)", () => {
    expectLinear((n) => splitSentences(`${"a".repeat(n)}1\nUpper.`, md));
  });

  it("a long letter run, a digit, then a single-letter initial", () => {
    expectLinear((n) => splitSentences(`${"a".repeat(n)}1 X. Upper.`));
  });

  it("a heading of spaces with no closing hashes (markdown)", () => {
    expectLinear((n) => splitSentences(`# ${" ".repeat(n)}x`, md));
  });

  it("unclosed link targets in the default matcher", () => {
    expectLinear((n) => defaultSupports(`${"](".repeat(n / 2)}Claim`, "Claim"), 60_000);
  });

  it("a long chain of hard-wrapped lines (markdown)", () => {
    expectLinear((n) => classifyDocument("The battery lasts and\n".repeat(n / 20) + "ends here [[cite:e]].", { e: "x" }, md));
  });

  it("many unclosed fence openers (markdown)", () => {
    expectLinear((n) => splitSentences("```x\n".repeat(n / 5), md), 80_000);
  });

  it("many distinct ids with one-word spans in one sentence", () => {
    // Each span is too short to judge alone, so every id is judged against the
    // whole sentence. The sentence is normalized once, so this stays linear.
    const build = (n: number) => {
      const ids = Math.floor(n / 25);
      const text = Array.from({ length: ids }, (_, i) => `battery [[cite:e${i}]]`).join(" and ") + ".";
      const evidence: Record<string, string> = {};
      for (let i = 0; i < ids; i++) evidence[`e${i}`] = "battery life";
      return { text, evidence };
    };
    const small = build(20_000);
    const large = build(80_000);
    const a = fastest(() => classifyDocument(small.text, small.evidence), 3);
    const b = fastest(() => classifyDocument(large.text, large.evidence), 3);
    expect(b / Math.max(a, 2)).toBeLessThan(SCALING_LIMIT);
  });
});

describe("2042351 review: one id in many separate groups", { timeout: 30_000 }, () => {
  it("checks the whole sentence once per id, not once per occurrence", () => {
    const build = (n: number) => `${"battery [[cite:e]] and ".repeat(n)}.`;
    const evidence = { e: "solar furnace precision" };
    const small = fastest(() => classifyDocument(build(4_000), evidence), 3);
    const large = fastest(() => classifyDocument(build(16_000), evidence), 3);
    expect(large / Math.max(small, 2)).toBeLessThan(SCALING_LIMIT);
    expect(large).toBeLessThan(1000);
  });
});

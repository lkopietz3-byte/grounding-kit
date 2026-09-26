import { describe, expect, it } from "vitest";
import { classifyDocument, splitSentences, type EvidenceMap } from "../src/index.js";

describe("bug: non-ASCII / punctuation-only content dropped after a peeled marker", () => {
  // peelLeadingMarkers() moves a citation marker sitting at the start of a
  // unit back onto the PRECEDING sentence (so it can't ground what follows).
  // The old code only kept the leftover `rest` when it contained an ASCII
  // letter or digit (`[A-Za-z0-9]`) — so a marker followed directly by a
  // whole sentence in a non-Latin script, or by bare punctuation, vanished
  // from the output entirely instead of surviving as its own unit.
  it("keeps a CJK sentence that follows a peeled leading marker", () => {
    const text = "The device passed testing. [[cite:e1]] こんにちは。 It shipped.";
    const sentences = splitSentences(text);
    expect(sentences).toEqual([
      "The device passed testing. [[cite:e1]]",
      "こんにちは。",
      "It shipped.",
    ]);
  });

  it("does not silently delete the CJK sentence from document classification", () => {
    const text = "The device passed testing. [[cite:e1]] こんにちは。 It shipped.";
    const doc = classifyDocument(text, { e1: "the device passed testing" });
    expect(doc.sentences).toHaveLength(3);
    expect(doc.sentences.map((s) => s.sentence)).toContain("こんにちは。");
  });

  it("keeps bare punctuation that follows a peeled leading marker", () => {
    const text = "The device passed testing. [[cite:e1]] ! It shipped.";
    const sentences = splitSentences(text);
    expect(sentences).toEqual([
      "The device passed testing. [[cite:e1]]",
      "!",
      "It shipped.",
    ]);
  });

  it("keeps a CJK sentence glued directly to the marker with no separating space", () => {
    const sentences = splitSentences("Real claim. [[cite:e1]]こんにちは");
    expect(sentences).toEqual(["Real claim. [[cite:e1]]", "こんにちは"]);
  });

  it("does not merge a cited CJK clause into an unrelated preceding sentence (isCitationOnly path)", () => {
    // Distinct from the peelLeadingMarkers cases above: here the CJK text
    // comes BEFORE its marker within its own clause ("こんにちは[[cite:e2]]"),
    // so isCitationOnly() (not peelLeadingMarkers) decides whether it's real
    // content. The old ASCII-only check saw no [A-Za-z0-9] left after
    // stripping the marker and wrongly treated the whole clause as "just a
    // stray citation," merging it into the previous, unrelated sentence
    // instead of keeping it as its own grounding unit.
    const text = "First claim [[cite:e1]]; こんにちは[[cite:e2]].";
    expect(splitSentences(text)).toEqual([
      "First claim [[cite:e1]]",
      "こんにちは[[cite:e2]].",
    ]);
  });
});

describe("bug: quadratic-time (algorithmic-complexity DoS) inputs", () => {
  // Both cases below are realistic-shaped adversarial input (long runs of a
  // single character class), not contrived worst-case regexes. The old
  // implementation re-scanned an ever-larger slice of the string per
  // character in a hot loop, so cost grew with the SQUARE of input length;
  // ~300KB of input took over a second. The budget below is generous (the
  // fixed code finishes in single-digit-to-low-double-digit milliseconds on
  // a dev laptop) but comfortably below what the old O(n^2) code needed.
  const TIME_BUDGET_MS = 500;

  it("splits a long run of colon-separated, marker-free clauses in linear-ish time", () => {
    const input = "a: ".repeat(100_000) + "end.";
    const start = Date.now();
    const sentences = splitSentences(input);
    const elapsed = Date.now() - start;
    expect(sentences.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });

  it("splits a long run of single-letter initials in linear-ish time", () => {
    let input = "";
    for (let i = 0; i < 100_000; i++) {
      input += String.fromCharCode(65 + (i % 26)) + ". ";
    }
    input += "End.";
    const start = Date.now();
    const sentences = splitSentences(input);
    const elapsed = Date.now() - start;
    expect(sentences.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });

  it("handles one long unbroken run of letters with no period in linear-ish time", () => {
    // A long token/hash/base64 blob with no periods at all, pasted into a
    // document, is realistic input a grounding checker has to survive. The
    // old endsOnFalseBoundary() ran an unanchored `[A-Za-z][A-Za-z.]*\.$`
    // regex with no trailing "." anywhere to find, forcing the engine to
    // retry the greedy `*` from every start position before giving up:
    // O(n^2). 40,000 letters alone measured 827ms on the old code; this is
    // 100,000.
    const input = "a".repeat(100_000);
    const start = Date.now();
    const sentences = splitSentences(input);
    const elapsed = Date.now() - start;
    expect(sentences).toEqual([input]);
    expect(elapsed).toBeLessThan(TIME_BUDGET_MS);
  });
});

// Deterministic seeded PRNG (mulberry32) so these property tests are
// reproducible: same seed always generates the same corpus and must always
// produce the same result, with no reliance on Math.random or run order.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_WORDS = [
  "the", "device", "shipped", "quickly", "reviewed", "unit", "market",
  "grew", "40", "percent", "3.5", "example.com", "file.tar.gz", "battery",
  "life", "reached", "hours", "café", "Zoé", "naïve", "system", "network",
  "hardware", "e.g.", "i.e.", "U.S.", "a.m.", "p.m.", "approx.", "no.",
  "Corp.", "Dr.", "Mrs.", "J.", "R.", "Tolkien", "wrote", "it", "done",
  "“quoted”", "…", "こんにちは。",
  "你好。", "\u{1F600}", "éclair", "​", " gap",
];

// Deliberately excludes ';', '—' (em dash) and ':' — splitGroundingUnits
// treats these as clause boundaries and consumes the separator character
// itself as part of producing a grounding unit (documented in the README's
// "Clause-level splitting" section). That is intentional lossy behavior, not
// a bug, so it is out of scope for the character-preservation property below
// and is covered by its own explicit tests in test/grounding.test.ts instead.
function genFuzzDoc(rng: () => number, tokenCount: number): string {
  // Never start with a bare marker: a marker with nothing before it in the
  // whole document has no preceding sentence to ground, so it is
  // (correctly, and per the sentenceSplitter.ts comment) dropped — a second
  // documented exception that would otherwise make this property flaky.
  let out = "starter text ";
  let markerCounter = 0;
  for (let i = 0; i < tokenCount; i++) {
    const r = rng();
    if (r < 0.08) {
      markerCounter += 1;
      out += `[[cite:e${markerCounter}]] `;
    } else if (r < 0.12) {
      out += "[citation needed] ";
    } else if (r < 0.16) {
      out += FUZZ_WORDS[Math.floor(rng() * FUZZ_WORDS.length)] + " ";
      out += ["." , "!", "?", "。", "．"][Math.floor(rng() * 5)] + " ";
    } else {
      out += FUZZ_WORDS[Math.floor(rng() * FUZZ_WORDS.length)] + " ";
    }
  }
  return `${out}end.`;
}

describe("property: splitSentences preserves every non-whitespace character", () => {
  it("never loses a non-whitespace character across 200 random documents", () => {
    for (let seed = 0; seed < 200; seed++) {
      const rng = mulberry32(seed);
      const doc = genFuzzDoc(rng, 40);
      const rejoined = splitSentences(doc).join("");
      const strip = (s: string) => s.replace(/\s+/gu, "");
      expect(strip(rejoined), `seed ${seed} input: ${doc}`).toBe(strip(doc));
    }
  });
});

describe("property: classification is deterministic", () => {
  it("returns byte-identical output for the same input across repeated calls, 100 random documents", () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = mulberry32(seed);
      const doc = genFuzzDoc(rng, 30);
      const evidence: EvidenceMap = { e1: "a stable evidence span used across every run" };
      const first = JSON.stringify(classifyDocument(doc, evidence));
      const second = JSON.stringify(classifyDocument(doc, evidence));
      expect(second, `seed ${seed}`).toBe(first);
    }
  });

  it("does not depend on evidenceMap key insertion order", () => {
    const text = "Battery life reached 14 hours [[cite:e1]]. Warranty is one year [[cite:e2]].";
    const inOrder: EvidenceMap = {
      e1: "battery life reached 14 hours in testing",
      e2: "the product carries a one year warranty",
    };
    const reversed: EvidenceMap = {
      e2: "the product carries a one year warranty",
      e1: "battery life reached 14 hours in testing",
    };
    expect(classifyDocument(text, reversed)).toEqual(classifyDocument(text, inOrder));
  });
});

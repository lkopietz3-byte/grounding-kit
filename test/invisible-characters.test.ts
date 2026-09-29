import { describe, expect, it } from "vitest";
import { classifyDocument, splitSentences } from "../src/index.js";

// Bug class 7: "shows nothing" is more than whitespace. Characters a renderer
// draws as nothing (zero-width space and joiners, word joiner, soft hyphen,
// every bidi control, variation selectors, Hangul fillers) sit between a
// terminator and what follows without changing how the text looks. If the
// splitter only recognizes \s, they hide a sentence boundary and let an
// uncited claim ride a citation, or make a phantom "claim" out of nothing.

const invisible: Array<[string, string]> = [
  ["U+200B zero-width space", "\u200b"],
  ["U+200C zero-width non-joiner", "\u200c"],
  ["U+200D zero-width joiner", "\u200d"],
  ["U+2060 word joiner", "\u2060"],
  ["U+00AD soft hyphen", "\u00ad"],
  ["U+061C Arabic letter mark", "\u061c"],
  ["U+200E left-to-right mark", "\u200e"],
  ["U+202E right-to-left override", "\u202e"],
  ["U+2066 left-to-right isolate", "\u2066"],
  ["U+2069 pop directional isolate", "\u2069"],
  ["U+FE0F variation selector-16", "\ufe0f"],
  ["U+034F combining grapheme joiner", "\u034f"],
  ["U+3164 Hangul filler", "\u3164"],
];

const evidence = { e1: "supporting text one", e2: "supporting text two" };
// These tests are about where sentences split, not about evidence matching.
const always = { supports: () => true };

describe("an invisible character does not hide a sentence boundary", () => {
  for (const [name, ch] of invisible) {
    it(`terminator + ${name} + marker: the marker stays with the sentence it ends`, () => {
      const text = `It happens occasionally.${ch}[[cite:e1]] The claimant lost $500,000.`;
      expect(splitSentences(text)).toEqual([
        `It happens occasionally. ${ch}[[cite:e1]]`,
        "The claimant lost $500,000.",
      ]);
      const doc = classifyDocument(text, evidence, always);
      expect(doc.counts).toEqual({ grounded: 1, placeholder: 0, ungrounded: 1, invalid: 0 });
      expect(doc.isClean).toBe(false);
    });

    it(`space + ${name} + marker after a period: the marker is peeled back`, () => {
      expect(splitSentences(`Claim. ${ch}[[cite:e1]] Next.`)).toEqual([
        `Claim. ${ch}[[cite:e1]]`,
        "Next.",
      ]);
    });

    it(`terminator + ${name} + space: the uncited sentence is not fused into the next one`, () => {
      const doc = classifyDocument(`Uncited claim.${ch} Next claim [[cite:e1]].`, evidence, always);
      expect(doc.counts).toEqual({ grounded: 1, placeholder: 0, ungrounded: 1, invalid: 0 });
      expect(doc.sentences.map((s) => s.status)).toEqual(["ungrounded", "grounded"]);
    });
  }

  it("keeps every character: the invisible one travels with the text after it", () => {
    expect(splitSentences("Uncited claim.\u200b Next claim.")).toEqual([
      "Uncited claim.",
      "\u200b Next claim.",
    ]);
  });

  it("peels several markers even when invisible characters sit between them", () => {
    expect(splitSentences("Claim. \u200b[[cite:e1]]\u2060 [[cite:e2]] Next.")).toEqual([
      "Claim. \u200b[[cite:e1]] \u2060 [[cite:e2]]",
      "Next.",
    ]);
  });

  it("splits after a non-ASCII terminator followed by an invisible character too", () => {
    expect(splitSentences("完了。\u200b次の文。")).toEqual(["完了。", "\u200b次の文。"]);
  });
});

describe("a unit that shows nothing is never a claim", () => {
  it("drops a line made only of invisible characters between two cited sentences", () => {
    const doc = classifyDocument("Claim [[cite:e1]].\n\u200b\nNext [[cite:e2]].", evidence, always);
    expect(doc.sentences).toHaveLength(2);
    expect(doc.counts.ungrounded).toBe(0);
    expect(doc.isClean).toBe(true);
  });

  for (const [name, ch] of invisible) {
    it(`returns no units for text that is only ${name}`, () => {
      expect(splitSentences(ch)).toEqual([]);
      expect(splitSentences(` ${ch}${ch} `)).toEqual([]);
    });
  }

  it("returns no units for text of only bidi isolates and control characters", () => {
    expect(splitSentences("\u2066\u2069")).toEqual([]);
    expect(splitSentences("\u0001\u0002")).toEqual([]);
    expect(splitSentences("Claim.\n\u0001\nNext.")).toEqual(["Claim.", "Next."]);
  });

  it("drops an invisible clause between separators", () => {
    expect(splitSentences("A [[cite:e1]]; \u200b; B [[cite:e2]].")).toEqual([
      "A [[cite:e1]]",
      "B [[cite:e2]].",
    ]);
  });

  it("drops an invisible remainder left after a peeled marker", () => {
    expect(splitSentences("Claim. [[cite:e1]] \u200b")).toEqual(["Claim. [[cite:e1]]"]);
  });

  it("keeps visible text in every script, and visible text wrapped in bidi controls", () => {
    expect(splitSentences("\u2066Visible claim\u2069.")).toEqual(["\u2066Visible claim\u2069."]);
    expect(splitSentences("مرحبا\u061c بالعالم. 你好。")).toEqual(["مرحبا\u061c بالعالم.", "你好。"]);
    expect(splitSentences("Fine \u{1f600}.")).toEqual(["Fine \u{1f600}."]);
    expect(splitSentences("!")).toEqual(["!"]);
    expect(splitSentences("x")).toEqual(["x"]);
  });
});

describe("a marker glued to an astral-plane letter still gets its separating space", () => {
  it("splits after a marker's terminator when the next letter is outside the BMP", () => {
    // U+20000 is a CJK ideograph written as two UTF-16 units.
    expect(splitSentences("A [[cite:e1]].\u{20000} B.")).toEqual(["A [[cite:e1]].", "\u{20000} B."]);
    expect(splitSentences("A [[cite:e1]].B C.")).toEqual(["A [[cite:e1]].", "B C."]);
  });

  it("does not add a space before an astral symbol that is not a letter or digit", () => {
    expect(splitSentences("A [[cite:e1]].\u{1f600} B.")).toEqual(["A [[cite:e1]].\u{1f600} B."]);
  });
});

import { describe, expect, it } from "vitest";
import { classifyDocument, classifySentence, defaultSupports, splitSentences } from "../src/index.js";

describe("a marker glued to the PRECEDING terminator gets its own boundary", () => {
  // The core laundering vector: "occasionally.[[cite:e1]]The claimant lost
  // $500,000." reads as ONE sentence if nothing separates the period, the
  // marker and the next word, so the fabricated second claim rides e1.
  const cases: Array<[string, string, string[]]> = [
    [
      "period",
      "occasionally.[[cite:e1]]The claimant lost $500,000.",
      ["occasionally. [[cite:e1]]", "The claimant lost $500,000."],
    ],
    ["exclamation mark, spaced after", "Really![[cite:e1]] Next.", ["Really! [[cite:e1]]", "Next."]],
    ["question mark, glued after", "Really?[[cite:e1]]Next.", ["Really? [[cite:e1]]", "Next."]],
    ["ideographic full stop", "本当。[[cite:e1]]次", ["本当。 [[cite:e1]]", "次"]],
    ["two markers in a row", "A [[cite:e1]].[[cite:e2]] B.", ["A [[cite:e1]]. [[cite:e2]]", "B."]],
    ["marker at the very start of the text", "[[cite:e1]]Claim.", ["Claim."]],
  ];
  for (const [name, text, expected] of cases) {
    it(`separates them: ${name}`, () => {
      expect(splitSentences(text)).toEqual(expected);
    });
  }

  it("keeps the fabricated second claim uncited", () => {
    const doc = classifyDocument(
      "It happens occasionally.[[cite:e1]]The claimant lost $500,000.",
      { e1: "it happens occasionally" },
    );
    expect(doc.sentences.map((s) => s.status)).toEqual(["grounded", "ungrounded"]);
    expect(doc.isClean).toBe(false);
  });

  it("adds a space only after a terminator, not after any character", () => {
    expect(splitSentences("Claim[[cite:e1]] more.")).toEqual(["Claim[[cite:e1]] more."]);
    expect(splitSentences("Claim,[[cite:e1]] more.")).toEqual(["Claim,[[cite:e1]] more."]);
    expect(splitSentences("sentence. [[cite:e1]] Next sentence.")).toEqual([
      "sentence. [[cite:e1]]",
      "Next sentence.",
    ]);
  });
});

describe("a marker glued to the FOLLOWING text gets a separating space", () => {
  const cases: Array<[string, string, string[]]> = [
    ["terminator then a letter", "A [[cite:e1]].B C.", ["A [[cite:e1]].", "B C."]],
    ["terminator then a digit", "A [[cite:e1]].5 items.", ["A [[cite:e1]].", "5 items."]],
    ["exclamation mark then a letter", "A [[cite:e1]]!Next", ["A [[cite:e1]]!", "Next"]],
    ["ideographic full stop then a letter", "A [[cite:e1]]。次の", ["A [[cite:e1]]。", "次の"]],
    ["a letter directly", "A [[cite:e1]]Bcd. E.", ["A [[cite:e1]] Bcd.", "E."]],
    ["a digit directly", "A [[cite:e1]]9 lives.", ["A [[cite:e1]] 9 lives."]],
    ["a non-Latin letter directly", "A [[cite:e1]]こんにちは.", ["A [[cite:e1]] こんにちは."]],
    ["a terminator then punctuation (no space added)", "A [[cite:e1]].) tail.", ["A [[cite:e1]].) tail."]],
  ];
  for (const [name, text, expected] of cases) {
    it(`handles ${name}`, () => {
      expect(splitSentences(text)).toEqual(expected);
    });
  }
});

describe("a fragment that is only a marker (plus punctuation) joins the sentence before it", () => {
  it("attaches a dash-and-marker line to the previous sentence", () => {
    expect(splitSentences("Claim one is true.\n- [[cite:e1]]")).toEqual(["Claim one is true. - [[cite:e1]]"]);
  });

  it("attaches a marker on its own line after a blank line", () => {
    expect(splitSentences("First.\n\n[[cite:e1]]")).toEqual(["First. [[cite:e1]]"]);
  });

  it("keeps a first fragment that has nothing to attach to", () => {
    expect(splitSentences("- [[cite:e1]]")).toEqual(["- [[cite:e1]]"]);
  });

  it("does not join a fragment that has prose next to its marker", () => {
    expect(splitSentences("Claim one is true.\n- see [[cite:e1]]")).toEqual([
      "Claim one is true.",
      "- see [[cite:e1]]",
    ]);
  });
});

describe("classifyDocument's clean flag", () => {
  const ev = { e1: "supported statement here" };
  const flag = (text: string) => classifyDocument(text, ev, { supports: () => true }).isClean;

  it("is false for an ungrounded sentence alone", () => {
    expect(flag("Nothing cited here.")).toBe(false);
  });

  it("is false for an invalid sentence alone", () => {
    expect(flag("Unknown id [[cite:zzz]].")).toBe(false);
  });

  it("is true for grounded and placeholder sentences", () => {
    expect(flag("Fine [[cite:e1]]. Gap [citation needed].")).toBe(true);
    expect(flag("Only a gap [TK].")).toBe(true);
  });

  it("is true for a document with no checkable sentences", () => {
    expect(flag("")).toBe(true);
    expect(flag("   \n  ")).toBe(true);
  });
});

describe("defaultSupports word rules", () => {
  it("ignores words of three characters or fewer, and counts words of four", () => {
    // Every word is <= 3 characters: nothing left to overlap, so only a
    // substring match can pass.
    expect(defaultSupports("it is ok", "we say it works")).toBe(false);
    expect(defaultSupports("it is ok", "yes it is ok too")).toBe(true);
    // "the" (3) is ignored, "abcd" (4) counts: 1 of 1 significant words overlaps.
    expect(defaultSupports("the abcd", "zzz abcd nope")).toBe(true);
  });

  it("needs at least 60% of the significant words", () => {
    expect(defaultSupports("alpha bravo charlie delta echo", "alpha bravo charlie xxxx yyyy")).toBe(true); // 3/5
    expect(defaultSupports("alpha bravo charlie delta echo", "alpha bravo xxxx yyyy zzzz")).toBe(false); // 2/5
    expect(defaultSupports("alpha bravo charlie", "alpha bravo zzzz")).toBe(true); // 2/3
    expect(defaultSupports("alpha bravo", "alpha zzzz")).toBe(false); // 1/2
  });

  it("normalizes case, punctuation and spacing on both sides", () => {
    expect(defaultSupports("BATTERY LASTED LONG", "battery lasted long")).toBe(true);
    expect(defaultSupports("battery-life", "battery life")).toBe(true);
    expect(defaultSupports("up   to  9", "up to 9")).toBe(true);
    expect(defaultSupports("up to 9!", "up to 9")).toBe(true);
    expect(defaultSupports("up to 9", "  up to 9 ...")).toBe(true);
  });

  it("is false when either side normalizes to nothing", () => {
    expect(defaultSupports("!!!", "something")).toBe(false);
    expect(defaultSupports("something", "??")).toBe(false);
    expect(defaultSupports("", "")).toBe(false);
  });
});

describe("classifySentence reports what it cites", () => {
  it("lists a repeated id twice and validates it once per mention", () => {
    const result = classifySentence("A claim [[cite:e1]] and again [[cite:e1]].", { e1: "a claim and again" });
    expect(result.citedIds).toEqual(["e1", "e1"]);
    expect(result.validIds).toEqual(["e1", "e1"]);
    expect(result.status).toBe("grounded");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLACEHOLDER_PATTERN,
  GroundingConfigError,
  classifyDocument,
  classifySentence,
  defaultSupports,
  splitSentences,
  stripCitationMarkers,
} from "../src/index.js";

// API-level contracts added by the 2026-10-10 hunt fixes. The verdict table
// (test/verdict-table.test.ts) covers whole-document behavior.

describe("config validation", () => {
  it("throws for an unknown config key on every entry point", () => {
    const bad = { markerPatern: /\[(\d+)\]/g } as never;
    const message = /config has an unknown option "markerPatern"/;
    expect(() => splitSentences("x.", bad)).toThrow(TypeError);
    expect(() => splitSentences("x.", bad)).toThrow(message);
    expect(() => classifySentence("x.", {}, bad)).toThrow(message);
    expect(() => classifyDocument("x.", {}, bad)).toThrow(message);
  });

  it("accepts supports in a splitSentences config, so one config can be shared", () => {
    expect(splitSentences("A. B.", { supports: () => true } as never)).toEqual(["A. B."]);
  });

  it("throws for an unknown abbreviations key", () => {
    expect(() =>
      splitSentences("x.", { abbreviations: { alwaysFuse: [], contextFuse: [], always: [] } as never }),
    ).toThrow(/abbreviations has an unknown option "always"/);
  });

  it("throws for a markdown option that is not a boolean", () => {
    expect(() => splitSentences("x.", { markdown: "no" as never })).toThrow(
      /config\.markdown must be a boolean \(got string\)/,
    );
  });

  it("normalizes abbreviation entries written with dots", () => {
    const abbreviations = { alwaysFuse: ["Dr.", "e.g."], contextFuse: [] };
    expect(splitSentences("Dr. Vance spoke. Use e.g. Python.", { abbreviations })).toEqual([
      "Dr. Vance spoke.",
      "Use e.g. Python.",
    ]);
  });

  it("accepts entries in other cased scripts and throws for entries that can never match", () => {
    const cyrillic = { alwaysFuse: ["г"], contextFuse: [] };
    expect(splitSentences("В 2020 г. рост был. Потом спад.", { abbreviations: cyrillic })).toEqual([
      "В 2020 г. рост был.",
      "Потом спад.",
    ]);
    expect(() => splitSentences("x.", { abbreviations: { alwaysFuse: ["d2"], contextFuse: [] } })).toThrow(
      /abbreviations\.alwaysFuse\[0\] must be letters/,
    );
    expect(() => splitSentences("x.", { abbreviations: { alwaysFuse: [], contextFuse: ["e g"] } })).toThrow(
      /abbreviations\.contextFuse\[0\] must be letters/,
    );
  });

  it("does not loop on a placeholder pattern that can match nothing", () => {
    expect(splitSentences("One. Two.", { placeholderPattern: /x*/ })).toEqual(["One.", "Two."]);
  });
});

describe("per-id reasons", () => {
  const evidence = { e1: "the battery lasts 14 hours on a full charge", bad: 42 as never };

  it("names each reason", () => {
    expect(classifySentence("The battery lasts 14 hours [[cite:e1]].", evidence).reasons).toEqual({
      e1: "supported",
    });
    expect(classifySentence("Prices doubled last spring [[cite:e1]].", evidence).reasons).toEqual({
      e1: "not-supported",
    });
    expect(classifySentence("Claim [[cite:nope]].", evidence).reasons).toEqual({ nope: "unknown-id" });
    expect(classifySentence("Claim [[cite:bad]].", evidence).reasons).toEqual({ bad: "invalid-evidence" });
    const yes = classifySentence("Yes [[cite:e1]].", evidence);
    expect(yes.status).toBe("invalid");
    expect(yes.reasons).toEqual({ e1: "no-content-words" });
    expect(classifySentence("It's 99% [[cite:e1]].", evidence).reasons).toEqual({ e1: "no-content-words" });
  });

  it("is empty for an uncited sentence and keeps a prototype-named id as an ordinary key", () => {
    expect(classifySentence("No citation here.", evidence).reasons).toEqual({});
    const proto = classifySentence("Claim [[cite:__proto__]].", evidence);
    expect(Object.keys(proto.reasons)).toEqual(["__proto__"]);
    expect(proto.reasons.__proto__).toBe("unknown-id");
    expect(JSON.stringify(proto.reasons)).toBe('{"__proto__":"unknown-id"}');
  });

  it("reports the worst occurrence of a repeated id", () => {
    const result = classifySentence(
      "The battery lasts 14 hours [[cite:e1]] while prices doubled last spring [[cite:e1]].",
      evidence,
    );
    expect(result.status).toBe("invalid");
    expect(result.validIds).toEqual(["e1"]);
    expect(result.reasons).toEqual({ e1: "not-supported" });
  });

  it("only the default matcher reports no-content-words", () => {
    expect(classifySentence("Yes [[cite:e1]].", evidence, { supports: () => false }).reasons).toEqual({
      e1: "not-supported",
    });
  });
});

describe("multi-cite spans", () => {
  it("passes each group its own span, and the last group the text after it", () => {
    const calls: Array<[string, string]> = [];
    const supports = (claim: string, text: string): boolean => {
      calls.push([claim, text]);
      return true;
    };
    classifySentence(
      "Battery lasts 14 hours [[cite:a]] and weighs 1.2 kilograms in independent tests [[cite:b]] today.",
      { a: "A", b: "B" },
      { supports },
    );
    expect(calls).toEqual([
      ["Battery lasts 14 hours", "A"],
      ["and weighs 1.2 kilograms in independent tests today.", "B"],
    ]);
  });

  it("gives adjacent markers one shared span: the whole sentence", () => {
    const claims: string[] = [];
    classifySentence("Battery lasts 14 hours [[cite:a]][[cite:b]].", { a: "A", b: "B" }, {
      supports: (claim) => {
        claims.push(claim);
        return true;
      },
    });
    expect(claims).toEqual(["Battery lasts 14 hours.", "Battery lasts 14 hours."]);
  });
});

describe("nonClaims", () => {
  const text = "# Title\n\n---\n\n| A | B |\n|---|---|\n| x | y [[cite:e1]] |\n\n**Note**\n\n```\ncode line\n```\n";

  it("by default sets aside only lines that hold no claim", () => {
    const doc = classifyDocument(text, { e1: "x y" });
    expect(doc.nonClaims).toEqual(["---", "|---|---|", "```", "```"]);
    expect(doc.sentences.map((s) => s.sentence)).toEqual([
      "# Title",
      "| A | B |",
      "| x | y [[cite:e1]] |",
      "**Note**",
      "code line",
    ]);
  });

  it("with markdown: true lists the scaffolding that was set aside, in order", () => {
    const doc = classifyDocument(text, { e1: "x y" }, { markdown: true });
    expect(doc.nonClaims).toEqual(["# Title", "---", "| A | B |", "|---|---|", "**Note**", "```\ncode line\n```"]);
    expect(doc.sentences.map((s) => s.sentence)).toEqual(["| x | y [[cite:e1]] |"]);
  });

  it("splitSentences leaves scaffolding out too", () => {
    expect(splitSentences("## Battery\n\nIt lasts.\n\n***\n\n1.")).toEqual(["## Battery", "It lasts."]);
    expect(splitSentences("## Battery\n\nIt lasts.\n\n***", { markdown: true })).toEqual(["It lasts."]);
  });
});

describe("stripCitationMarkers changes only marker sites", () => {
  it("leaves spacing elsewhere exactly as given", () => {
    expect(stripCitationMarkers("Two  spaces here [[cite:e1]].")).toBe("Two  spaces here.");
    expect(stripCitationMarkers("No markers.   \n")).toBe("No markers.   \n");
    expect(stripCitationMarkers("Keep a space , here [[cite:e1]] and there.")).toBe(
      "Keep a space , here and there.",
    );
  });

  it("separates words a marker was glued between", () => {
    expect(stripCitationMarkers("word[[cite:e1]]word and 3[[cite:e1]]4")).toBe("word word and 3 4");
  });

  it("closes up before punctuation, a line break or the end, and at a line start", () => {
    expect(stripCitationMarkers("Claim [[cite:e1]] [[cite:e2]].")).toBe("Claim.");
    expect(stripCitationMarkers("(see note [[cite:e1]])")).toBe("(see note)");
    expect(stripCitationMarkers("One [[cite:e1]]\n[[cite:e2]] Two")).toBe("One\nTwo");
  });
});

describe("defaultSupports details", () => {
  it("keeps combining marks with their letters", () => {
    expect(defaultSupports("बैटरी चौदह घंटे तक चलती है", "परीक्षण में बैटरी लगभग चौदह घंटे तक चलती है")).toBe(true);
  });

  it("compares unspaced scripts by character pairs, all of which must appear", () => {
    expect(defaultSupports("電池が14時間持続", "テストでは電池が14時間持続しました")).toBe(true);
    expect(defaultSupports("価格は二倍になった", "テストでは電池が14時間持続しました")).toBe(false);
    // An inserted negation or a changed number adds a piece the evidence lacks.
    expect(defaultSupports("该耳机不支持防水功能", "该耳机支持防水功能。")).toBe(false);
    expect(defaultSupports("Acme X3耳机单次充电续航200小时", "Acme X3耳机单次充电续航20小时。")).toBe(false);
    // A paraphrase that rewords the evidence is a miss (0.2.1 missed it too).
    expect(defaultSupports("電池は14時間持続します", "テストでは電池が14時間持続しました")).toBe(false);
  });

  it("ignores link targets and bare URLs", () => {
    expect(
      defaultSupports(
        "The [battery](https://example.com/a/b/c/d) lasts 14 hours, see https://example.com/x/y",
        "the battery lasts 14 hours",
      ),
    ).toBe(true);
  });

  it("has nothing to compare in a claim of short words and numbers", () => {
    expect(defaultSupports("Tax is 9%", "the tax rate is 5%")).toBe(false);
    expect(defaultSupports("It's 129 g", "The Acme X3 retails for $129")).toBe(false);
  });
});

describe("DEFAULT_PLACEHOLDER_PATTERN word boundary", () => {
  it("needs a word boundary after TK", () => {
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[TK]")).toBe(true);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[TK: Q3 numbers]")).toBe(true);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[tk source]")).toBe(true);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[Tkachenko 2019]")).toBe(false);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[TKO Group]")).toBe(false);
    expect(DEFAULT_PLACEHOLDER_PATTERN.test("[tkinter docs]")).toBe(false);
  });
});

describe("README examples", () => {
  it("quick start reasons", () => {
    const evidence = {
      e1: "independent lab testing measured 14 hours of battery life on a full charge",
      e2: "the product ships with a 90 day return window and a 1 year limited warranty",
    };
    const text = `
Battery life reached 14 hours in independent lab testing [[cite:e1]].
Some reviewers claim the app drains battery overnight.
The warranty covers accidental damage for five years [[cite:e2]].
We could not verify the exact refund processing time [citation needed].
`;
    const result = classifyDocument(text, evidence);
    expect(result.counts).toEqual({ grounded: 1, placeholder: 1, ungrounded: 1, invalid: 1 });
    expect(result.sentences[2].reasons).toEqual({ e2: "not-supported" });
    expect(result.nonClaims).toEqual([]);
  });

  it("splitSentences examples", () => {
    expect(splitSentences("Dr. Alvarez reviewed the unit. It shipped the next day.")).toEqual([
      "Dr. Alvarez reviewed the unit.",
      "It shipped the next day.",
    ]);
    expect(splitSentences("1. The battery lasts 14 hours.\n2. The warranty is one year.")).toEqual([
      "1. The battery lasts 14 hours.",
      "2. The warranty is one year.",
    ]);
  });

  it("abbreviation table and documented misses", () => {
    expect(splitSentences("Acme Corp. filed the report. Acme Corp. The filing was late.")).toEqual([
      "Acme Corp. filed the report.",
      "Acme Corp.",
      "The filing was late.",
    ]);
    expect(splitSentences("Sr. García reviewed it.")).toEqual(["Sr. García reviewed it."]);
    expect(splitSentences("The answer is no. 3 people disagreed.")).toEqual(["The answer is no. 3 people disagreed."]);
    expect(splitSentences("Sales grew in the U.S. Prices rose.")).toEqual(["Sales grew in the U.S.", "Prices rose."]);
    expect(splitSentences("Sales grew in the UK. Prices rose.")).toEqual(["Sales grew in the UK.", "Prices rose."]);
    expect(splitSentences("Gov. Rivera signed it. It shipped Jan. 5, 2024 to stores.")).toEqual([
      "Gov. Rivera signed it.",
      "It shipped Jan. 5, 2024 to stores.",
    ]);
    expect(splitSentences("Acme shipped a firmware rev. The update helped.")).toEqual([
      "Acme shipped a firmware rev.",
      "The update helped.",
    ]);
    expect(splitSentences("Data came from the U.S. The rest came later.")).toEqual([
      "Data came from the U.S.",
      "The rest came later.",
    ]);
    expect(splitSentences("We chose plan B. Prices doubled.")).toEqual(["We chose plan B.", "Prices doubled."]);
    expect(splitSentences("See p. 4 for details.", { abbreviations: { alwaysFuse: [], contextFuse: [] } })).toEqual([
      "See p. 4 for details.",
    ]);
    expect(splitSentences("According to J. Smith, it works.")).toEqual(["According to J. Smith, it works."]);
    expect(splitSentences("We chose Plan B. The vendor agreed.")).toEqual(["We chose Plan B.", "The vendor agreed."]);
    expect(splitSentences("We hired Agent K. Prices doubled.")).toEqual(["We hired Agent K. Prices doubled."]);
    expect(splitSentences("The U.S. Department of Energy agreed.")).toEqual(["The U.S.", "Department of Energy agreed."]);
    expect(splitSentences("Brands, e.g. Apple, agreed.")).toEqual(["Brands, e.g.", "Apple, agreed."]);
    expect(splitSentences("It opens at 9 a.m. ET daily. It closes at noon.")).toEqual([
      "It opens at 9 a.m. ET daily.",
      "It closes at noon.",
    ]);
  });

  it("markdown section examples", () => {
    expect(
      splitSentences("Prices doubled last spring\nThe battery lasts 14 hours [[cite:e1]].", { markdown: true }),
    ).toEqual(["Prices doubled last spring", "The battery lasts 14 hours [[cite:e1]]."]);
    expect(splitSentences("## Prices doubled in 2025.\n## Battery", { markdown: true })).toEqual([
      "## Prices doubled in 2025.",
    ]);
  });
});

describe("401409e review: protected ranges are tested where the cut happens", () => {
  it("keeps a boundary right after a marker that ends in its own terminator", () => {
    const markerPattern = /\{\{(\w+)\}\}[.!?]/g;
    expect(splitSentences("Claim one {{a}}.​Claim two.", { markerPattern })).toEqual([
      "Claim one {{a}}.",
      "​Claim two.",
    ]);
  });

  it("never splits inside a marker that holds a period and a space", () => {
    const markerPattern = /\[\[([^\]]+)\]\]/g;
    expect(splitSentences("Claim [[a. B]] more.", { markerPattern })).toEqual(["Claim [[a. B]] more."]);
  });

  it("refuses a marker pattern that swallows trailing whitespace (f39a77e review)", () => {
    const markerPattern = /\{\{(\w+)\}\}\. /g;
    expect(() => splitSentences("Claim one {{a}}.  Claim two.", { markerPattern })).toThrow(GroundingConfigError);
  });

  it("does not let a cited dash run eat into a marker that starts with dashes", () => {
    const markerPattern = /(--\w+--)/g;
    const units = splitSentences("Claim --a-- then more --b--.", { markerPattern });
    expect(units.join(" ")).toContain("--b--");
  });
});

describe("f39a77e review: a marker or placeholder may not start or end with whitespace", () => {
  const refused: Array<[string, Record<string, RegExp>]> = [
    ["marker ending in a space", { markerPattern: /\{\{(\w+)\}\}\. /g }],
    ["marker ending in \\s*", { markerPattern: /\{\{(\w+)\}\}\s*/g }],
    ["marker starting with a space", { markerPattern: / \{\{(\w+)\}\}/g }],
    ["marker starting with \\s", { markerPattern: /\s\[(\d+)\]/g }],
    ["marker ending in a class with a space", { markerPattern: /\{\{(\w+)\}\}[ .]/g }],
    ["one alternative ending in a space", { markerPattern: /\{\{(\w+)\}\}|\[(\d+)\] /g }],
    ["placeholder ending in an optional space", { placeholderPattern: /\[tbd\] ?/i }],
  ];
  for (const [name, config] of refused) {
    it(`refuses a ${name} before reading any text`, () => {
      expect(() => splitSentences("", config)).toThrow(GroundingConfigError);
      expect(() => classifyDocument("", {}, config)).toThrow(/may not start or end with whitespace/);
    });
  }

  it("refuses at the first real match when the source does not show it", () => {
    const config = { markerPattern: /\{\{(\w+)\}\}(?:\.| )/g };
    expect(splitSentences("Claim {{a}}.", config)).toEqual(["Claim {{a}}."]);
    expect(() => classifyDocument("Claim {{a}} more.", { a: "claim" }, config)).toThrow(GroundingConfigError);
  });

  it("accepts the default patterns and ordinary custom ones", () => {
    for (const config of [{}, { markerPattern: /\[(\d+)\]/g }, { placeholderPattern: /\[(?:tbd|unsourced)\]/i }]) {
      expect(() => classifyDocument("Claim [1] [tbd] [[cite:e1]].", { e1: "claim" }, config)).not.toThrow();
    }
  });

  it("classification cannot turn a lost unknown id into a clean placeholder (the review's document)", () => {
    expect(() =>
      classifyDocument("Claim [TK] {{missing}}.  Another gap [TK].", {}, { markerPattern: /\{\{(\w+)\}\}\. /g }),
    ).toThrow(GroundingConfigError);
  });

  it("a marker pattern that depends on its surroundings fails loudly instead of losing a citation", () => {
    // The lookbehind finds "[1]" after a space in the whole text, but not at
    // the start of the sentence it lands in, so the citation would vanish.
    const config = { markerPattern: /(?<= )\[(\d+)\]/g };
    expect(() =>
      classifyDocument("Claim one. [1] Claim two [2] [TK].", { "1": "claim one", "2": "claim two" }, config),
    ).toThrow(/matched different text once the document was split/);
  });
});

describe("README recipes", () => {
  const numbersIn = (text: string) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];
  const numberAware = (claim: string, evidence: string): boolean => {
    const available = new Set(numbersIn(evidence));
    return numbersIn(claim).every((n) => available.has(n)) && defaultSupports(claim, evidence);
  };

  it("a number-aware supports catches a changed number the default passes", () => {
    const evidence = { e1: "the tower stands 330 metres tall in Paris" };
    const wrong = "The tower stands 300 metres tall in Paris [[cite:e1]].";
    const right = "The tower stands 330 metres tall in Paris [[cite:e1]].";
    expect(classifyDocument(wrong, evidence).isClean).toBe(true);
    expect(classifyDocument(wrong, evidence, { supports: numberAware }).isClean).toBe(false);
    expect(classifyDocument(right, evidence, { supports: numberAware }).isClean).toBe(true);
  });

  it("splits verdicts into hard blocks and review flags", () => {
    const evidence = { e1: "the dataset is not publicly available to avoid overfitting" };
    const result = classifyDocument(
      "The test data is kept private so models cannot overfit it [[cite:e1]]. Prices doubled. A claim [[cite:nope]].",
      evidence,
    );
    const hard = (s: (typeof result.sentences)[number]) =>
      s.status === "ungrounded" ||
      Object.values(s.reasons).some((r) => r === "unknown-id" || r === "invalid-evidence");
    expect(result.sentences.filter(hard).map((s) => s.sentence)).toEqual(["Prices doubled.", "A claim [[cite:nope]]."]);
    expect(result.sentences.filter((s) => s.status === "invalid" && !hard(s)).map((s) => s.sentence)).toEqual([
      "The test data is kept private so models cannot overfit it [[cite:e1]].",
    ]);
  });
});

describe("1eb99c9 review: negated classes are not whitespace at a pattern edge", () => {
  it("accepts a pattern that starts and ends with a negated whitespace class", () => {
    const markerPattern = /[^\s](\d+)[^\s]/g;
    expect(() => splitSentences("Claim x1y here.", { markerPattern })).not.toThrow();
    expect(() => classifyDocument("Claim x1y here.", { "1": "claim here" }, { markerPattern })).not.toThrow();
  });

  it("still refuses a pattern whose real match ends with whitespace", () => {
    const markerPattern = /\[(\d+)\][^\]x]/g;
    expect(() => classifyDocument("Claim [1] here.", { "1": "claim here" }, { markerPattern })).toThrow(GroundingConfigError);
  });
});

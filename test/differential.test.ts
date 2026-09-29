import { describe, expect, it } from "vitest";
import { splitSentences, type SplitterConfig } from "../src/index.js";
import { splitSentences as legacySplitSentences } from "./legacy/legacySplitter.js";
import { mulberry32, pick } from "./helpers/prng.js";

// The rewrite of the bracket shielding (GK-F01), the marker scans (GK-F02,
// GK-F03) and the trailing-word scan must not change what the splitter
// returns for any input the old code handled. The frozen copy of the 0.1.1
// splitter in test/legacy is the oracle. Inputs deliberately avoid invisible
// (default-ignorable) characters, zero-length markers and sticky flags, the
// three places where the new behavior is intended to differ; those are
// covered by their own tests.

const configs: Array<[string, SplitterConfig]> = [
  ["defaults", {}],
  [
    "numeric footnotes",
    { markerPattern: /\[(\d+)\]/g, placeholderPattern: /\[(?:tbd|unsourced)\]/i },
  ],
  ["braces, no brackets", { markerPattern: /\{\{ref:(\w+)\}\}/, placeholderPattern: /\{\{gap\}\}/ }],
  ["marker ending in a period", { markerPattern: /#(\d+)\./g }],
  [
    "custom abbreviations",
    { abbreviations: { alwaysFuse: ["dr", "sra"], contextFuse: ["etc", "no"] } },
  ],
];

const fixtures = [
  "",
  "   ",
  "Plain sentence.",
  "Dr. Alvarez reviewed the unit. [[cite:e1]] It shipped the next day.",
  "occasionally.[[cite:e1]]The claimant lost $500,000.",
  "Real claim [[cite:e1]] Fabricated claim.",
  "First claim [[cite:e1]]; こんにちは[[cite:e2]].",
  "The device passed testing. [[cite:e1]] こんにちは。 It shipped.",
  "Real claim. [[cite:e1]]こんにちは",
  "A [b [c] d] e; f",
  "[[[[x]]]]; y",
  "[a] [b] [c]; [d [e] f]; [g",
  "[ [ [ x ] ; still inside ] ; outside",
  "open [ never closed; then a clause; and another",
  "close ] before open [ x ]; tail",
  "[".repeat(50) + "x; y" + "]".repeat(50),
  "[".repeat(50) + "x" + "]".repeat(49) + "; z",
  "[".repeat(49) + "x" + "]".repeat(50) + "; z",
  "[[cite:e1;e2]] tail; more",
  "Claim [[cite:e1]]: cited colon splits here, then more [[cite:e2]].",
  "Results: leading label stays intact [[cite:e1]].",
  "Meet at 9:30 with a 3:1 ratio; then leave.",
  "Dana M. Whitfield signed it. Corp. filed the report. Corp. reserves the right.",
  "Vol. 2 no. 5 is out. It ends etc. And more.",
  "Ends with question? Yes! Really. Done。終わり！",
  "line one.\nline two [[cite:e1]].\n\n[[cite:e2]] orphan after blank line",
  "[[cite:e1]] leading marker with nothing before it. Next.",
  "A. B. C. D. E. F. G. Done.",
  "text [citation needed]. More text [TK]; and [more research needed: see p. 4].",
  "a".repeat(200) + "1.",
  "a.".repeat(100) + "1.",
  "x [[cite:e1]] [[cite:e2]] [[cite:e3]]. y [[cite:e1]] [[cite:e1]].",
  "Claim. [[cite:e1]] [[cite:e2]] Second. [[cite:e3]]",
  "Note [1]. Another [2]; a third [3]: and more [4].",
  "Ref {{ref:a}}; clause {{ref:b}}.{{ref:c}}Next.",
  "A #1.#2. B #3.Next. Last.",
];

const words = [
  "The", "device", "passed", "testing", "Dr.", "Mr.", "Corp.", "e.g.", "etc.", "No.", "2",
  "9:30", "3:1", "A.", "M.", "Whitfield", "is", "claim", "ok", "$500,000", "U.S.", "p.m.",
  "こんにちは", "日本語", "no", "vol.", "and", "it", "a.b", "x1.", "3.14",
];
const glue = [" ", " ", " ", " ", "  ", "\n", "", ""];
const stops = [".", ".", "!", "?", "。", "！", ";", "—", ":", ",", ".."];
const marks = [
  "[[cite:e1]]", "[[cite:e2]]", "[[cite: e3 ]]", "[citation needed]", "[TK]",
  "[more research needed: x]", "[1]", "[22]", "[tbd]", "{{ref:a}}", "{{gap}}", "#1.", "#22.",
];
const brackets = ["[", "]", "[x]", "[a; b]", "[[", "]]", "[ ", " ]"];

function randomText(rand: () => number): string {
  const count = 1 + Math.floor(rand() * 40);
  let out = "";
  for (let i = 0; i < count; i++) {
    const r = rand();
    if (r < 0.5) out += pick(rand, words);
    else if (r < 0.65) out += pick(rand, stops);
    else if (r < 0.8) out += pick(rand, marks);
    else if (r < 0.9) out += pick(rand, brackets);
    else out += pick(rand, words);
    out += pick(rand, glue);
  }
  return out;
}

describe("splitSentences is unchanged from the 0.1.1 splitter", () => {
  for (const [name, config] of configs) {
    it(`matches on every fixture (${name})`, () => {
      for (const text of fixtures) {
        expect(splitSentences(text, config), JSON.stringify(text)).toEqual(
          legacySplitSentences(text, config),
        );
      }
    });

    it(`matches on 4,000 seeded random documents (${name})`, () => {
      const rand = mulberry32(20260928 + name.length);
      for (let i = 0; i < 4000; i++) {
        const text = randomText(rand);
        expect(splitSentences(text, config), JSON.stringify(text)).toEqual(
          legacySplitSentences(text, config),
        );
      }
    });
  }

  it("matches on nested, sibling and unbalanced bracket shapes at several depths", () => {
    for (let depth = 0; depth <= 12; depth++) {
      for (let extraOpen = 0; extraOpen <= 2; extraOpen++) {
        for (let extraClose = 0; extraClose <= 2; extraClose++) {
          const text =
            "[".repeat(extraOpen) +
            "[".repeat(depth) + "in; side" + "]".repeat(depth) +
            "]".repeat(extraClose) + "; out [a; b] [c] ; tail: end.";
          expect(splitSentences(text), JSON.stringify(text)).toEqual(legacySplitSentences(text));
        }
      }
    }
  });
});

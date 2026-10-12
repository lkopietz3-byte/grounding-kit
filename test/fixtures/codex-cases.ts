// Documents from the Codex reviews of 2662560, 2042351 and 9ca1177
// (2026-10-10). Every one contains an uncited or unsupported claim, so
// isClean must be false. Cases without `config` are checked under default
// options (the release gate); cases with `config` are checked under that
// config, and against 0.2.1 under the same config when 0.2.1 had the options.

import type { ClassifyConfig } from "../../src/index.js";

type CodexCase = {
  id: string;
  kind: "launder";
  ev: Record<string, string>;
  text: string;
  config?: ClassifyConfig;
};

const CJK_CLOSERS = ["」", "』", "）", "〕", "】", "》", "〉", "＂", "＇", '"', "'", ")"];
// 401409e review: a custom marker that ends with its own terminator, then an
// invisible character, then a new sentence. Every terminator kind (ASCII,
// spaced non-ASCII, CJK) and every invisible character the spacing step
// handles.
const MARKER_TERMINATORS = [".", "!", "?", "…", "。", "！", "？"];
const INVISIBLES = [
  "\u200b", "\u200c", "\u200d", "\u2060", "\u00ad", "\u061c", "\u200e",
  "\u202e", "\u2066", "\u2069", "\ufe0f", "\u034f", "\u3164",
];
const WESTERN_CLOSERS = ['"', "'", "”", "’", ")", "»", "**"];

export const CODEX_CASES: CodexCase[] = [
  { id: "CX-table-header-statement", kind: "launder", ev: {}, text: "| Prices doubled last spring. |\n|---|" },
  { id: "CX-four-backtick-fence", kind: "launder", ev: {}, text: "````\nClaim [[cite:missing]].\n```" },
  { id: "CX-tilde-closer-for-backtick", kind: "launder", ev: {}, text: "```\nClaim [[cite:missing]].\n~~~" },
  // 2042351 review, P1: a CJK terminator, a closing bracket or quote, then
  // text with no space must still be a boundary.
  ...CJK_CLOSERS.flatMap((closer) =>
    ["", " "].map((space) => ({
      id: `CX2-cjk-closer-${closer}-${space ? "space" : "nospace"}`,
      kind: "launder" as const,
      ev: { e: "電池は14時間持続" },
      text: `「電池は14時間持続[[cite:e]]。${closer}${space}電池は14時間持続。`,
    })),
  ),
  // The same for a Western terminator, a closing quote and a capital.
  ...WESTERN_CLOSERS.flatMap((closer) =>
    ["", " "].map((space) => ({
      id: `CX2-western-closer-${closer}-${space ? "space" : "nospace"}`,
      kind: "launder" as const,
      ev: { e: "the battery lasts 14 hours on a full charge" },
      text: `He said "the battery lasts 14 hours on a full charge [[cite:e]].${closer}${space}Prices doubled last spring.`,
    })),
  ),
  // P2: a month before a number that is not a day.
  {
    id: "CX2-month-thousands",
    kind: "launder",
    ev: { e: "5,000 devices exploded overnight" },
    text: "They arrived in Jan. 5,000 devices exploded overnight [[cite:e]].",
  },
  {
    id: "CX2-month-decimal",
    kind: "launder",
    ev: { e: "5.5 percent of devices exploded overnight" },
    text: "They arrived in Jan. 5.5 percent of devices exploded overnight [[cite:e]].",
  },
  {
    id: "CX2-month-percent",
    kind: "launder",
    ev: { e: "5% of devices exploded overnight" },
    text: "They arrived in Jan. 5% of devices exploded overnight [[cite:e]].",
  },
  {
    id: "CX2-month-ordinal",
    kind: "launder",
    ev: { e: "5th generation devices exploded overnight" },
    text: "They arrived in Jan. 5th generation devices exploded overnight [[cite:e]].",
  },
  // P2 (markdown: true): a fenced block that carries a citation is a claim.
  {
    id: "CX2-md-fence-unknown-id",
    kind: "launder",
    ev: {},
    text: "```\nClaim [[cite:missing]].\n```",
    config: { markdown: true },
  },
  // 9ca1177 review, P2: a sentence boundary must never fall inside a
  // recognized marker (here a custom pattern whose id holds `."X`).
  {
    id: "CX3-custom-marker-holds-closer-capital",
    kind: "launder",
    ev: { e: "Battery provides reliable portable power throughout outdoor camping" },
    text: 'Battery provides reliable portable power throughout outdoor camping [[e]][[missing."X]] [TK].',
    config: { markerPattern: /\[\[([^\]]+)\]\]/g },
  },
  {
    id: "CX3-custom-marker-holds-period-space",
    kind: "launder",
    ev: { e: "Battery provides reliable portable power throughout outdoor camping" },
    text: "Battery provides reliable portable power throughout outdoor camping [[e]][[missing. X]].",
    config: { markerPattern: /\[\[([^\]]+)\]\]/g },
  },
  ...MARKER_TERMINATORS.flatMap((terminator) =>
    INVISIBLES.map((invisible) => ({
      id: `CX4-marker-ends-${terminator}-then-U+${invisible.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
      kind: "launder" as const,
      ev: { e: "the battery lasts 14 hours on a full charge" },
      text: `The battery lasts 14 hours on a full charge {{e}}${terminator}${invisible}Prices doubled.`,
      config: { markerPattern: /\{\{(\w+)\}\}[.!?…。！？]/g },
    })),
  ),
  // 401409e review (markdown: true): a fence opener that carries a citation.
  {
    id: "CX4-md-fence-opener-cited-body-cited",
    kind: "launder",
    ev: { e: "the battery lasts 14 hours on a full charge" },
    text: "```text [[cite:missing]]\nThe battery lasts 14 hours on a full charge [[cite:e]].\n```",
    config: { markdown: true },
  },
  {
    id: "CX4-md-fence-opener-cited-body-uncited",
    kind: "launder",
    ev: {},
    text: "```text [[cite:missing]]\nnpm install laptop-x\n```",
    config: { markdown: true },
  },
  {
    id: "CX2-md-fence-placeholder-and-unknown",
    kind: "launder",
    ev: { e: "the battery lasts 14 hours" },
    text: "The battery lasts 14 hours [[cite:e]].\n\n~~~text\nPrices doubled [[cite:nope]] last spring.\n~~~",
    config: { markdown: true },
  },
];

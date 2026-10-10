// Documents from the Codex reviews of 2662560 and 2042351 (2026-10-10). Every
// one contains an uncited or unsupported claim, so isClean must be false.
// Cases without `config` are checked under default options (the release
// gate); cases with `config` are checked under that config.

type CodexCase = {
  id: string;
  kind: "launder";
  ev: Record<string, string>;
  text: string;
  config?: { markdown: boolean };
};

const CJK_CLOSERS = ["」", "』", "）", "〕", "】", "》", "〉", "＂", "＇", '"', "'", ")"];
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
  {
    id: "CX2-md-fence-placeholder-and-unknown",
    kind: "launder",
    ev: { e: "the battery lasts 14 hours" },
    text: "The battery lasts 14 hours [[cite:e]].\n\n~~~text\nPrices doubled [[cite:nope]] last spring.\n~~~",
    config: { markdown: true },
  },
];

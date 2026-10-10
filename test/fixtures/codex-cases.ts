// Documents from the Codex review of 2662560 (2026-10-10) that must be flagged.
export const CODEX_CASES: Array<{ id: string; kind: "launder"; ev: Record<string, string>; text: string }> = [
  { id: "CX-table-header-statement", kind: "launder", ev: {}, text: "| Prices doubled last spring. |\n|---|" },
  { id: "CX-four-backtick-fence", kind: "launder", ev: {}, text: "````\nClaim [[cite:missing]].\n```" },
  { id: "CX-tilde-closer-for-backtick", kind: "launder", ev: {}, text: "```\nClaim [[cite:missing]].\n~~~" },
];

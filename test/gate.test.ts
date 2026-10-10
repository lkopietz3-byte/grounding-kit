import { describe, expect, it } from "vitest";
import { classifyDocument, splitSentences } from "../src/index.js";
import { HUNTER_CASES } from "./fixtures/hunter-corpus.js";
import { CODEX_CASES } from "./fixtures/codex-cases.js";
import { ROWS, type VerdictRow } from "./fixtures/verdict-rows.js";
import { HUNT_ROWS } from "./fixtures/hunt-rows.js";
import V021 from "./fixtures/v021-verdicts.json";
import { withWatchdog } from "./helpers/watchdog.js";

// The release gate from the 2662560 review: under DEFAULT options, no
// laundering document that grounding-kit@0.2.1 flagged may come back clean,
// and no honest document that 0.2.1 passed may come back flagged. The 0.2.1
// verdicts were recorded from the published package into
// fixtures/v021-verdicts.json (regenerate only with the real 0.2.1 build).

const v021 = V021 as { hunter: Record<string, boolean>; codex: Record<string, boolean>; table: Record<string, boolean> };
const cleanByDefault = (text: string, evidence: Record<string, string>) =>
  classifyDocument(text, evidence).isClean;

// A table row is honest when it expects a clean result and is not a pinned
// limit (a limit row documents a laundering document that only an opt-in mode
// lets through).
const honestRow = (row: VerdictRow) => row.clean && row.finding !== "limit";

describe("gate: no new false passes and no honest regressions against 0.2.1 (default options)", () => {
  it("hunter corpus: every laundering document 0.2.1 flagged is still flagged", () => {
    const hits = HUNTER_CASES.filter(
      (c) => c.kind === "launder" && v021.hunter[c.id] === false && cleanByDefault(c.text, c.ev),
    ).map((c) => c.id);
    expect(hits).toEqual([]);
  });

  it("hunter corpus: every honest document 0.2.1 passed still passes", () => {
    const regressions = HUNTER_CASES.filter(
      (c) => c.kind === "honest" && v021.hunter[c.id] === true && !cleanByDefault(c.text, c.ev),
    ).map((c) => c.id);
    expect(regressions).toEqual([]);
  });

  it("Codex review documents are flagged (under their own config, default when none)", () => {
    const missed = CODEX_CASES.filter((c) => classifyDocument(c.text, c.ev, c.config).isClean).map((c) => c.id);
    expect(missed).toEqual([]);
  });

  it("Codex review documents that 0.2.1 flagged stay flagged under default options", () => {
    const hits = CODEX_CASES.filter(
      (c) => c.config === undefined && v021.codex[c.id] === false && cleanByDefault(c.text, c.ev),
    ).map((c) => c.id);
    expect(hits).toEqual([]);
  });

  it("verdict table: no laundering row flips to clean, no honest row flips to flagged", () => {
    const hits: string[] = [];
    const regressions: string[] = [];
    for (const row of [...ROWS, ...HUNT_ROWS]) {
      const before = v021.table[row.name];
      expect(typeof before, row.name).toBe("boolean");
      const now = cleanByDefault(row.text, row.evidence);
      if (!honestRow(row) && before === false && now) hits.push(row.name);
      if (honestRow(row) && before === true && !now) regressions.push(row.name);
    }
    expect(hits).toEqual([]);
    expect(regressions).toEqual([]);
  });

  it("the hunter corpus is complete (55 laundering, 25 honest)", () => {
    expect(HUNTER_CASES.filter((c) => c.kind === "launder")).toHaveLength(55);
    expect(HUNTER_CASES.filter((c) => c.kind === "honest")).toHaveLength(25);
  });
});

describe("Codex review: an empty Unicode placeholder match cannot hang the scan", () => {
  it("advances by a whole code point", () => {
    expect(withWatchdog(() => splitSentences("😀.", { placeholderPattern: /x*/u }), 2000)).toEqual(["😀."]);
    expect(withWatchdog(() => splitSentences("a😀b. c.", { placeholderPattern: new RegExp("(?:)", "v") }), 2000)).toEqual([
      "a😀b.",
      "c.",
    ]);
  });
});

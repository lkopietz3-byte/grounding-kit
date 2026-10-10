import { describe, expect, it } from "vitest";
import { classifyDocument } from "../src/index.js";
import { ROWS } from "./fixtures/verdict-rows.js";
import { HUNT_ROWS } from "./fixtures/hunt-rows.js";

// The verdict regression table. Each row is a realistic AI-written document
// with the expected status of every grounding unit and the expected isClean.
// A failure prints the row name and the finding it pins.

describe("verdict table", () => {
  for (const row of [...ROWS, ...HUNT_ROWS]) {
    it(`${row.name} [${row.finding}]`, () => {
      const doc = classifyDocument(row.text, row.evidence, row.config);
      const got = doc.sentences.map((s) => s.status);
      const detail = JSON.stringify(doc.sentences.map((s) => [s.status, s.sentence]), null, 1);
      expect(got, detail).toEqual(row.expect);
      expect(doc.isClean, detail).toBe(row.clean);
    });
  }

  it("has unique row names", () => {
    const names = [...ROWS, ...HUNT_ROWS].map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

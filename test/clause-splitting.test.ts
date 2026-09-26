import { describe, expect, it } from "vitest";
import { classifyDocument, splitSentences, type EvidenceMap } from "../src/index.js";

// Coverage for splitGroundingUnits(), the clause-level split on ';', an
// em-dash, and a colon that follows an already-cited clause. This is a
// documented, security-relevant behavior (README: "Clause-level splitting")
// with no prior direct test: an uncited clause riding a citation elsewhere in
// the same sentence is exactly the laundering vector this library exists to
// catch, so each boundary rule gets its own explicit case here.

const growthEvidence: EvidenceMap = {
  e1: "revenue grew 40 percent in the fiscal year according to the filed report",
};

describe("clause-level splitting: semicolon and em-dash", () => {
  it("splits on ';' so an uncited clause can't ride the cited clause before it", () => {
    const text = "Revenue grew 40 percent [[cite:e1]]; the CEO was fired for fraud.";
    expect(splitSentences(text)).toEqual([
      "Revenue grew 40 percent [[cite:e1]]",
      "the CEO was fired for fraud.",
    ]);
    const doc = classifyDocument(text, growthEvidence);
    expect(doc.sentences.map((s) => s.status)).toEqual(["grounded", "ungrounded"]);
  });

  it("splits on an em dash the same way", () => {
    const text = "Revenue grew 40 percent [[cite:e1]]—the CEO was fired for fraud.";
    expect(splitSentences(text)).toEqual([
      "Revenue grew 40 percent [[cite:e1]]",
      "the CEO was fired for fraud.",
    ]);
    const doc = classifyDocument(text, growthEvidence);
    expect(doc.sentences.map((s) => s.status)).toEqual(["grounded", "ungrounded"]);
  });
});

describe("clause-level splitting: colon", () => {
  it("does NOT split an uncited label colon (comma-join behavior)", () => {
    const text = "Results: revenue grew 40 percent [[cite:e1]].";
    expect(splitSentences(text)).toEqual([text]);
    const doc = classifyDocument(text, growthEvidence);
    expect(doc.sentences.map((s) => s.status)).toEqual(["grounded"]);
  });

  it("DOES split a colon whose preceding clause already carries a citation", () => {
    const text = "The filed report shows growth [[cite:e1]]: the CEO was fired for fraud.";
    expect(splitSentences(text)).toEqual([
      "The filed report shows growth [[cite:e1]]",
      "the CEO was fired for fraud.",
    ]);
  });

  it("never treats a numeric colon (time) as a clause boundary", () => {
    const text = "The report was filed at 9:30 showing 40 percent growth [[cite:e1]].";
    expect(splitSentences(text)).toEqual([text]);
    const doc = classifyDocument(text, growthEvidence);
    expect(doc.sentences.map((s) => s.status)).toEqual(["grounded"]);
  });

  it("never treats a numeric colon (ratio) as a clause boundary", () => {
    const text = "The filed report shows a 3:1 vote favoring 40 percent growth [[cite:e1]].";
    expect(splitSentences(text)).toEqual([text]);
  });
});

describe("clause-level splitting: bracket shielding is fail-closed", () => {
  it("does not split a ';' that sits inside a real [ ... ] span", () => {
    const text = "See the filed report [details; page 2] showing 40 percent growth [[cite:e1]].";
    // A single un-split unit is the behavior under test here; classification
    // is a separate concern (defaultSupports' word-overlap ratio dips below
    // 0.6 once the bracketed aside dilutes the claim, which is a
    // defaultSupports precision limit documented in the README, not a
    // clause-splitting bug).
    expect(splitSentences(text)).toEqual([text]);
  });

  it("an earlier unbalanced '[' does not suppress a later real split", () => {
    const text =
      "Unmatched [ bracket before the filed report shows 40 percent growth [[cite:e1]]; the CEO was fired for fraud.";
    const sentences = splitSentences(text);
    expect(sentences).toHaveLength(2);
    expect(sentences[1]).toBe("the CEO was fired for fraud.");
  });
});

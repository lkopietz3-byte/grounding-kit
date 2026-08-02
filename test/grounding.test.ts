import { describe, expect, it } from "vitest";
import {
  classifyDocument,
  classifySentence,
  splitSentences,
  type EvidenceMap,
} from "../src/index.js";

// Generic, non-legal domain: a product-review / news-summary style evidence
// set, so the tests double as documentation of how the library reads in a
// typical AI-writing-with-citations product.
const evidence: EvidenceMap = {
  e1: "independent lab testing measured 14 hours of battery life on a full charge",
  e2: "the product ships with a 90 day return window and a 1 year limited warranty",
};

describe("classifySentence", () => {
  it("marks a correctly grounded sentence as grounded", () => {
    const sentence =
      "Battery life reached 14 hours in independent lab testing [[cite:e1]].";
    const result = classifySentence(sentence, evidence);
    expect(result.status).toBe("grounded");
    expect(result.citedIds).toEqual(["e1"]);
    expect(result.validIds).toEqual(["e1"]);
  });

  it("marks an explicit gap placeholder as placeholder, not ungrounded", () => {
    const sentence = "We could not verify the exact refund processing time [citation needed].";
    const result = classifySentence(sentence, evidence);
    expect(result.status).toBe("placeholder");
    expect(result.citedIds).toEqual([]);
  });

  it("marks a sentence with no citation and no placeholder as ungrounded", () => {
    const sentence = "Some reviewers claim the app drains battery overnight.";
    const result = classifySentence(sentence, evidence);
    expect(result.status).toBe("ungrounded");
    expect(result.citedIds).toEqual([]);
  });

  it("marks a forged marker (id not in evidenceMap) as invalid, not placeholder", () => {
    const sentence = "The device is waterproof up to 30 meters [[cite:e99]].";
    const result = classifySentence(sentence, evidence);
    expect(result.status).toBe("invalid");
    expect(result.citedIds).toEqual(["e99"]);
    expect(result.validIds).toEqual([]);
  });

  it("marks a marker whose evidence does not support the claim as invalid", () => {
    // e2 is about the return/warranty window, not accidental-damage coverage.
    const sentence = "The warranty covers accidental damage for five years [[cite:e2]].";
    const result = classifySentence(sentence, evidence);
    expect(result.status).toBe("invalid");
    expect(result.citedIds).toEqual(["e2"]);
    expect(result.validIds).toEqual([]);
  });

  it("invalid outranks placeholder when a sentence has both", () => {
    const sentence =
      "The exact failure rate is unclear [citation needed], but it exceeds 50% [[cite:e99]].";
    const result = classifySentence(sentence, evidence);
    expect(result.status).toBe("invalid");
  });
});

describe("splitSentences: leading-marker peeling", () => {
  const text =
    "The device passed drop testing. [[cite:e1]] It also survived being run over by a car.";
  const dropTestEvidence: EvidenceMap = {
    e1: "the device passed all drop testing without visible damage",
  };

  it("attaches the marker to the sentence it actually terminates, not the one that follows", () => {
    const sentences = splitSentences(text);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]).toBe("The device passed drop testing. [[cite:e1]]");
    expect(sentences[1]).toBe("It also survived being run over by a car.");
  });

  it("does not let the peeled marker ground the following sentence", () => {
    const doc = classifyDocument(text, dropTestEvidence);
    expect(doc.counts.grounded).toBe(1);
    expect(doc.counts.ungrounded).toBe(1);
    expect(doc.counts.invalid).toBe(0);

    const [first, second] = doc.sentences;
    expect(first!.status).toBe("grounded");
    expect(first!.citedIds).toEqual(["e1"]);
    expect(second!.status).toBe("ungrounded");
    expect(second!.citedIds).toEqual([]);
  });
});

describe("splitSentences: abbreviation fusion", () => {
  it("does not split mid-sentence on a default-list abbreviation", () => {
    const sentences = splitSentences(
      "Dr. Alvarez reviewed the unit. It shipped the next day.",
    );
    expect(sentences).toEqual([
      "Dr. Alvarez reviewed the unit.",
      "It shipped the next day.",
    ]);
  });

  it("accepts a fully custom marker syntax and abbreviation list", () => {
    const sentences = splitSentences(
      "Dr. Vance's team retested the unit. {{ref:x1}} It failed under 40 degrees.",
      {
        markerPattern: /\{\{ref:\s*([a-zA-Z0-9_-]+)\s*\}\}/g,
        abbreviations: { alwaysFuse: ["dr"], contextFuse: [] },
      },
    );
    expect(sentences).toEqual([
      "Dr. Vance's team retested the unit. {{ref:x1}}",
      "It failed under 40 degrees.",
    ]);
  });
});

describe("classifyDocument", () => {
  it("summarizes counts and preserves the per-sentence breakdown", () => {
    const text = [
      "Battery life reached 14 hours in independent lab testing [[cite:e1]].",
      "We could not verify the exact refund processing time [citation needed].",
      "Some reviewers claim the app drains battery overnight.",
      "The device is waterproof up to 30 meters [[cite:e99]].",
    ].join(" ");

    const doc = classifyDocument(text, evidence);

    expect(doc.counts).toEqual({
      grounded: 1,
      placeholder: 1,
      ungrounded: 1,
      invalid: 1,
    });
    expect(doc.isClean).toBe(false);
    expect(doc.sentences).toHaveLength(4);
    expect(doc.citedEvidenceIds).toEqual(["e1"]);
  });

  it("is clean when every sentence is grounded or an honest placeholder", () => {
    const text =
      "Battery life reached 14 hours in independent lab testing [[cite:e1]]. We could not verify the exact refund processing time [citation needed].";
    const doc = classifyDocument(text, evidence);
    expect(doc.isClean).toBe(true);
  });
});

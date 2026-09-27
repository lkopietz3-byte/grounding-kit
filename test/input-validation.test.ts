import { describe, expect, it } from "vitest";
import { classifyDocument, classifySentence, splitSentences } from "../src/index.js";

// Before this fix, a null/wrong-type top-level argument crashed with a raw
// native error instead of this kit's own named TypeError -- and for
// classifySentence's evidenceMap, whether it crashed at all depended on
// whether the sentence happened to cite anything, since the bad value was
// only touched inside the per-citation loop.
describe("top-level argument validation", () => {
  it("classifySentence throws this kit's own TypeError for a non-string sentence", () => {
    expect(() => classifySentence(123 as unknown as string, {})).toThrow(
      new TypeError("sentence must be a string (got number)."),
    );
  });

  it("classifySentence throws this kit's own TypeError for a null/wrong-type evidenceMap", () => {
    const text = "The device is waterproof.";
    expect(() => classifySentence(text, null as unknown as Record<string, string>)).toThrow(
      new TypeError("evidenceMap must be an object (got null)."),
    );
    expect(() => classifySentence(text, undefined as unknown as Record<string, string>)).toThrow(
      new TypeError("evidenceMap must be an object (got undefined)."),
    );
    expect(() => classifySentence(text, "not-a-map" as unknown as Record<string, string>)).toThrow(
      new TypeError("evidenceMap must be an object (got string)."),
    );
  });

  it("classifySentence's evidenceMap check does not depend on whether the sentence cites anything", () => {
    // A sentence with NO citation marker used to slip past the bad
    // evidenceMap entirely (the loop that touched it never ran) and return a
    // normal-looking result instead of surfacing the caller's bug.
    const uncited = "The device is waterproof.";
    expect(() => classifySentence(uncited, null as unknown as Record<string, string>)).toThrow(TypeError);
  });

  it("classifyDocument throws this kit's own TypeError for a non-string text", () => {
    expect(() => classifyDocument(123 as unknown as string, {})).toThrow(
      new TypeError("text must be a string (got number)."),
    );
  });

  it("classifyDocument throws this kit's own TypeError for a null evidenceMap, even for empty text", () => {
    // Empty text produces zero sentences, so classifySentence's own check
    // (which only runs per sentence) would never fire -- classifyDocument
    // must validate evidenceMap itself, up front.
    expect(() => classifyDocument("", null as unknown as Record<string, string>)).toThrow(
      new TypeError("evidenceMap must be an object (got null)."),
    );
  });

  it("splitSentences throws this kit's own TypeError for a non-string text", () => {
    expect(() => splitSentences(123 as unknown as string)).toThrow(
      new TypeError("text must be a string (got number)."),
    );
    expect(() => splitSentences(null as unknown as string)).toThrow(
      new TypeError("text must be a string (got null)."),
    );
  });
});

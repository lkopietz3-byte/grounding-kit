import { describe, expect, it } from "vitest";
import {
  classifyDocument,
  classifySentence,
  type EvidenceMap,
} from "../src/index.js";

const evidence: EvidenceMap = {
  e1: "the sky measured a deep blue color during the survey",
};

describe("bug: prototype-chain keys used as citation marker ids", () => {
  // evidenceMap is a plain object. A marker id of "__proto__", "constructor",
  // or "toString" resolves through the prototype chain instead of failing an
  // own-property lookup, handing `supports()` a non-string (an object or a
  // function) instead of `undefined`. The old code called `.toLowerCase()` on
  // that non-string and crashed instead of reporting an invalid citation.
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "reports %s as an invalid (unknown) citation instead of throwing",
    (id) => {
      const sentence = `The sky is blue [[cite:${id}]].`;
      const result = classifySentence(sentence, evidence);
      expect(result.status).toBe("invalid");
      expect(result.citedIds).toEqual([id]);
      expect(result.validIds).toEqual([]);
    },
  );

  it("does not crash classifyDocument when a prototype-key id appears in a real document", () => {
    const text = "The sky is blue [[cite:constructor]]. It was a clear day.";
    const doc = classifyDocument(text, evidence);
    expect(doc.counts.invalid).toBe(1);
    expect(doc.isClean).toBe(false);
  });

  it("still classifies a legitimate evidence entry that happens to be named like a prototype key", () => {
    // A caller CAN legitimately use these ids if they set them as real own
    // properties (e.g. via computed keys or Object.defineProperty) — the fix
    // must not reject a genuinely present key, only a phantom prototype one.
    const oddEvidence: EvidenceMap = Object.defineProperty(
      {},
      "constructor",
      { value: "the sky measured a deep blue color", enumerable: true },
    );
    const result = classifySentence(
      "The sky is blue [[cite:constructor]].",
      oddEvidence,
    );
    expect(result.status).toBe("grounded");
    expect(result.validIds).toEqual(["constructor"]);
  });
});

describe("bug: Unicode normalization mismatch (NFC vs NFD) in defaultSupports", () => {
  it("supports a claim when the only difference from its evidence is accent-composition form", () => {
    // Same text, two different (both valid) Unicode encodings of the same
    // accented character: "é" as one codepoint (NFC) vs "e" + combining
    // acute accent (NFD). A generator and its evidence source can easily
    // disagree on form (macOS filesystems, some copy/paste paths, and some
    // web APIs normalize to NFD by default).
    const claim = "Café Zoé closed early.".normalize("NFC");
    const evidenceText =
      "The café down the street, run by Zoé, sells pastries and closes early on weekdays."
        .normalize("NFD");
    const result = classifySentence(claim, { e1: evidenceText });
    // No marker in the claim above; test the underlying supports() directly
    // instead via classifySentence with an explicit marker so it goes through
    // the real code path (evidenceMap lookup + defaultSupports).
    const markedClaim = "Café Zoé closed early [[cite:e1]].".normalize("NFC");
    const marked = classifySentence(markedClaim, { e1: evidenceText });
    expect(marked.status).toBe("grounded");
    expect(marked.validIds).toEqual(["e1"]);
    // sanity: the unmarked claim is ungrounded (no citation), not asserting on `result` beyond that it didn't throw
    expect(result.status).toBe("ungrounded");
  });
});

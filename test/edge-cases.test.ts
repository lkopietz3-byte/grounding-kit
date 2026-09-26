import { describe, expect, it } from "vitest";
import {
  classifyDocument,
  classifySentence,
  splitSentences,
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

describe("fuzz categories: abbreviations, decimals, URLs, initials, unicode scripts", () => {
  // These lock in and document CURRENT behavior for input shapes the kit's
  // own comments call out as fault lines. Several are honest, disclosed
  // limits of the deliberately small default abbreviation list (see
  // DEFAULT_ABBREVIATIONS's doc comment and the README's "Limits" section),
  // not bugs — the point of testing them is to catch a silent regression,
  // not to claim more coverage than the defaults promise.

  it("does not fuse ordinal list markers ('1.', '2.') — not in the default list", () => {
    expect(splitSentences("1. Item one. 2. Item two.")).toEqual([
      "1.", "Item one.", "2.", "Item two.",
    ]);
  });

  it("does not fuse 'a.m.'/'p.m.' — not in the default list", () => {
    expect(splitSentences("The meeting is at 9 a.m. sharp.")).toEqual([
      "The meeting is at 9 a.m.", "sharp.",
    ]);
  });

  it("does not fuse 'U.S.' — not in the default list ('us' is absent from both fuse lists)", () => {
    expect(splitSentences("The U.S. economy grew.")).toEqual([
      "The U.S.", "economy grew.",
    ]);
  });

  it("fuses 'e.g.' via the contextFuse list (lower-case continuation)", () => {
    expect(splitSentences("Please see e.g. the appendix.")).toEqual([
      "Please see e.g. the appendix.",
    ]);
  });

  it("never splits mid-decimal (no whitespace after the decimal point)", () => {
    expect(splitSentences("The price is 3.5 percent higher. Not bad.")).toEqual([
      "The price is 3.5 percent higher.",
      "Not bad.",
    ]);
  });

  it("does not falsely split a multi-dot filename/URL that ends the sentence", () => {
    expect(splitSentences("Download the file at file.tar.gz. It is large.")).toEqual([
      "Download the file at file.tar.gz.",
      "It is large.",
    ]);
  });

  it("keeps chained single-letter initials together (J. R. R. Tolkien)", () => {
    expect(splitSentences("J. R. R. Tolkien wrote it. It sold well.")).toEqual([
      "J. R. R. Tolkien wrote it.",
      "It sold well.",
    ]);
  });

  it("fuses a corporate suffix inside parentheses via alwaysFuse-adjacent contextFuse handling", () => {
    expect(splitSentences("The company (Acme Corp.) filed suit. It lost.")).toEqual([
      "The company (Acme Corp.) filed suit.",
      "It lost.",
    ]);
  });

  it("does not crash on RTL script text mixed with a citation marker", () => {
    const text = "مرحبا [[cite:e1]] شكرا.";
    expect(() => splitSentences(text)).not.toThrow();
    const doc = classifyDocument(text, { e1: "evidence" });
    expect(doc.sentences.length).toBeGreaterThan(0);
  });

  it("does not crash on emoji and combining marks adjacent to a terminator", () => {
    const text = "Launch day \u{1F680}\u{1F389}! é́́ done.";
    expect(() => splitSentences(text)).not.toThrow();
  });

  it("does not crash on a non-breaking space between an abbreviation and its name", () => {
    // The NBSP is whitespace (JS \s matches it), so it's treated like any
    // other separator: consumed by the split, then re-inserted as an
    // ordinary space when the abbreviation fragment is rejoined. The name
    // itself is never lost or mis-split.
    const text = "Mr. Smith arrived. Then he left.";
    expect(splitSentences(text)).toEqual(["Mr. Smith arrived.", "Then he left."]);
  });
});

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

  it("fuses 'a.m.'/'p.m.' via the contextFuse list (lower-case continuation, round 2)", () => {
    expect(splitSentences("The meeting is at 9 a.m. sharp.")).toEqual([
      "The meeting is at 9 a.m. sharp.",
    ]);
  });

  it("fuses 'U.S.' via the contextFuse list (lower-case continuation, round 2)", () => {
    expect(splitSentences("The U.S. economy grew.")).toEqual([
      "The U.S. economy grew.",
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

describe("round 2: 'am'/'pm'/'us' added to contextFuse, not alwaysFuse", () => {
  // contextFuse (not alwaysFuse) is the only safe list for these three: it
  // only treats the trailing period as non-terminal when the NEXT fragment
  // continues in lower-case or a digit. A capitalized next fragment is read
  // as a genuine new sentence, so the pronoun/word forms below ("I am.",
  // "told us.") still end a sentence exactly as before. alwaysFuse would get
  // this wrong unconditionally and was rejected for that reason.

  it("does not swallow a real sentence end: 'I am.' still splits", () => {
    expect(splitSentences("I am. Then we left.")).toEqual([
      "I am.",
      "Then we left.",
    ]);
  });

  it("does not swallow a real sentence end: 'told us.' still splits", () => {
    expect(splitSentences("They told us. Then it rained.")).toEqual([
      "They told us.",
      "Then it rained.",
    ]);
  });

  it("fuses 'a.m.' mid-sentence: 'Meet at 9 a.m. tomorrow.' does not split", () => {
    expect(splitSentences("Meet at 9 a.m. tomorrow.")).toEqual([
      "Meet at 9 a.m. tomorrow.",
    ]);
  });

  it("fuses 'U.S.' mid-sentence: 'the U.S. economy' does not split", () => {
    expect(splitSentences("Growth in the U.S. economy slowed this year.")).toEqual([
      "Growth in the U.S. economy slowed this year.",
    ]);
  });

  it("matches case-insensitively: 'A.M.'/'P.M.'/'U.S.' (uppercase) fuse the same way", () => {
    expect(splitSentences("Meet at 9 A.M. tomorrow.")).toEqual([
      "Meet at 9 A.M. tomorrow.",
    ]);
    expect(splitSentences("It runs until 5 P.M. daily.")).toEqual([
      "It runs until 5 P.M. daily.",
    ]);
    // Note: a capitalized continuation ("The U.S. Congress...") is NOT used
    // here — contextFuse can't (and isn't meant to) tell that apart from a
    // real sentence end, the same known limitation "Corp." already has.
    expect(splitSentences("The U.S. economy is slowing.")).toEqual([
      "The U.S. economy is slowing.",
    ]);
  });

  it("uppercase pronoun/word forms still split on a real sentence end", () => {
    expect(splitSentences("I AM. THEN WE LEFT.")).toEqual([
      "I AM.",
      "THEN WE LEFT.",
    ]);
  });

  it("sentence-final 'a.m.'/'p.m.'/'U.S.' with nothing after: no fusion needed, stays intact", () => {
    // contextFuse only fuses when there IS a following fragment; at the true
    // end of the text there's nothing to fuse with, so this is just a
    // normal, correctly-terminated single sentence.
    expect(splitSentences("It ended at 5 p.m.")).toEqual(["It ended at 5 p.m."]);
    expect(splitSentences("Doors open at 9 a.m.")).toEqual(["Doors open at 9 a.m."]);
    expect(splitSentences("She works for the U.S.")).toEqual(["She works for the U.S."]);
  });

  it("sentence-final 'us.' with nothing after also stays a single, intact sentence", () => {
    expect(splitSentences("They gave it to us.")).toEqual(["They gave it to us."]);
  });
});

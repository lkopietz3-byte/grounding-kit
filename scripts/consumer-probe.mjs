// Imports grounding-kit by its package name from the installed tarball (the
// way a real consumer would) and calls the real API, asserting real outputs
// end to end: split -> classify sentence -> classify a whole document ->
// strip markers. Also exercises the prototype-pollution and NFC/NFD fixes
// directly, since those are the two subtlest behaviors a consumer could
// silently regress on.
import assert from "node:assert/strict";

const {
  classifyDocument,
  classifySentence,
  splitSentences,
  stripCitationMarkers,
  defaultSupports,
  DEFAULT_ABBREVIATIONS,
} = await import("grounding-kit");

// --- splitSentences: abbreviation fusion + leading-marker peeling ---------
const sentences = splitSentences(
  "Dr. Alvarez reviewed the unit. [[cite:e1]] It shipped the next day.",
);
assert.deepEqual(sentences, [
  "Dr. Alvarez reviewed the unit. [[cite:e1]]",
  "It shipped the next day.",
]);

// --- classifySentence: grounded / invalid precedence ----------------------
const evidence = {
  e1: "independent lab testing measured 14 hours of battery life",
};
const grounded = classifySentence(
  "Battery life reached 14 hours in independent lab testing [[cite:e1]].",
  evidence,
);
assert.equal(grounded.status, "grounded");
assert.deepEqual(grounded.validIds, ["e1"]);

const invalid = classifySentence("The device is waterproof [[cite:e99]].", evidence);
assert.equal(invalid.status, "invalid");
assert.deepEqual(invalid.citedIds, ["e99"]);
assert.deepEqual(invalid.validIds, []);

// --- classifyDocument: end-to-end document summary ------------------------
const doc = classifyDocument(
  "Battery life reached 14 hours in independent lab testing [[cite:e1]]. " +
    "Some reviewers claim it drains overnight. " +
    "We could not verify the refund window [citation needed].",
  evidence,
);
assert.deepEqual(doc.counts, { grounded: 1, placeholder: 1, ungrounded: 1, invalid: 0 });
assert.equal(doc.isClean, false);

// --- stripCitationMarkers --------------------------------------------------
assert.equal(
  stripCitationMarkers("Battery life reached 14 hours [[cite:e1]]."),
  "Battery life reached 14 hours.",
);

// --- fixed bug: a prototype-chain marker id never crashes -----------------
const protoResult = classifySentence("Claim [[cite:constructor]].", evidence);
assert.equal(protoResult.status, "invalid");

// --- fixed bug: NFC vs NFD evidence still matches --------------------------
assert.equal(
  defaultSupports("Café closed early.".normalize("NFC"), "The café closed early.".normalize("NFD")),
  true,
);

// --- DEFAULT_ABBREVIATIONS is frozen ---------------------------------------
assert.equal(Object.isFrozen(DEFAULT_ABBREVIATIONS), true);
assert.equal(Object.isFrozen(DEFAULT_ABBREVIATIONS.alwaysFuse), true);

console.log("consumer-probe.mjs: all assertions passed");

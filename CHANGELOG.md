# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-27

### Fixed

- `classifySentence(text, null)` and `classifyDocument(123, {})` crashed with
  a raw native error (e.g. "Cannot convert undefined or null to object", or
  "text.matchAll is not a function") instead of this kit's own named
  `TypeError`. `classifySentence`'s bad `evidenceMap` was previously only
  touched inside the per-citation loop, so the same call could throw or
  silently return a result depending on whether the sentence cited anything;
  it's now checked up front, in `classifySentence`, `classifyDocument`, and
  `splitSentences`.
- The shipped `.js.map` pointed at `../src/*.ts`, which isn't in the
  published tarball. `tsconfig.build.json` now sets `inlineSources`, so the
  map embeds the original source. `.d.ts.map` generation is turned off
  instead of shipping `src/`.

### Added

- CommonJS `require()` support: `package.json` `exports` now has a
  `"default"` condition alongside `"import"`, so `require("grounding-kit")`
  works on Node versions that support `require(esm)` (>=20.19.0, >=22.12.0).
  `scripts/consumer-probe.cjs`, run by `verify-package.mjs`, guards it in CI.
- A "Relationship to sibling kits" section in the README, cross-linking
  `provenance-kit` and `corroboration-kit`.

## [0.1.0] - 2026-09-27

First release.

### Added

- `splitSentences(text, config?)`: deterministic, dependency-free sentence
  (technically clause-level) splitter hardened against citation-marker
  laundering — abbreviation periods that don't end a sentence, non-ASCII
  terminators, a marker glued to adjacent text with no whitespace,
  leading-marker peeling (a marker after a period grounds the sentence it
  ends, never the one that follows), and clause-level splitting on `;`, an
  em dash, and a colon that follows an already-cited clause. Bracket
  matching for that clause split fails closed: an unbalanced `[` never
  suppresses a later real split.
- `classifySentence` / `classifyDocument`: classify each sentence as
  `grounded`, `placeholder`, `ungrounded`, or `invalid` against an
  `EvidenceMap`, with `invalid` (a forged or unattributable citation)
  outranking everything else, including an honest placeholder.
- `defaultSupports`: the default (naive, non-semantic) evidence-match
  function — normalized substring containment or ≥60% significant-word
  overlap — exported so callers can see exactly what it does and replace it.
  Comparison is NFC-normalized so accented text in different (both valid)
  Unicode forms still matches.
- `extractCitedIds`, `extractAllCitedIds`, `stripCitationMarkers`:
  marker-level utilities built on the same configurable `markerPattern`.
- `DEFAULT_ABBREVIATIONS`, `DEFAULT_MARKER_PATTERN`,
  `DEFAULT_PLACEHOLDER_PATTERN`: the shipped defaults, exported and frozen
  (`DEFAULT_ABBREVIATIONS`) or safe for direct reuse including `.test()`
  (the two regexes — the library always clones them internally, so a
  caller's own use of the same object is never corrupted).
  `DEFAULT_ABBREVIATIONS.contextFuse` includes `"am"`, `"pm"`, and `"us"`,
  so "9 a.m." and "the U.S." no longer split mid-sentence by default; they
  are in `contextFuse`, not `alwaysFuse`, so "I am." and "They told us."
  still correctly end a sentence when followed by a capitalized fragment.
- Zero runtime dependencies. ESM only, Node >= 20.

### Notes

Citation-lookup is now safe against adversarial marker ids: `"__proto__"`,
`"constructor"`, `"toString"`, etc. classify as an ordinary invalid citation
instead of crashing the classifier (own-property lookup via `Object.hasOwn`
plus a `typeof` guard on the evidence value). Three algorithmic-complexity
issues found by fuzzing the splitter with adversarial-shaped input (a long
run of colons, of single-letter initials, or of plain letters with no
period) were fixed — each was O(n²) and now runs in linear-ish time. A
data-loss bug where a citation-adjacent sentence written in a non-Latin
script (or bare punctuation) could vanish entirely from the output is also
fixed. See the kit's finishing report for full detail on each.

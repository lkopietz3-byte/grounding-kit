# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Fixes from the 2026-10-10 hunt. Statuses, exports and signatures are
unchanged; results gain two fields, and several inputs now split or classify
differently (listed under "Changed"). `test/verdict-table.test.ts` pins every
case as a named document with its expected per-sentence statuses.

### Fixed

- **Laundering past an abbreviation.** `...by Acme Inc. [[cite:e1]] Prices
  doubled.` was one grounded sentence. A marker or placeholder after a
  period now ends the sentence even when the word before the period is an
  abbreviation (`Inc.`, `etc.`, `U.S.`, `Co.`, `Dr.`, ...) or a single
  letter, unless the text after the marker continues in lower case.
- **Laundering past closing punctuation.** A period followed by a closing
  quote, parenthesis, bracket, bold marker, curly quote, CJK closing bracket
  or footnote sign (`."`, `.)`, `.**`, `.”`, `。」`, `.¹`) and a space now
  ends the sentence, so the marker after it is peeled back. This also fixes
  the false fail where `She said "..." [[cite:e1]] The warranty ... [[cite:e2]].`
  was one invalid sentence.
- **Laundering past a single letter.** A single letter before a period no
  longer fuses unconditionally: it continues only as a name initial (`Dana
  M. Whitfield`, `J. R. R. Tolkien`) or a reference (`p. 4`), so `Prices
  doubled in plan B. <cited claim>` is two sentences.
- **Laundering through a dash tail.** After a cited clause, an en dash,
  horizontal bar, `--` or a spaced hyphen now splits like a cited colon, so
  `<claim> [[cite:e1]] – Prices doubled.` checks `Prices doubled.` on its
  own. `…` `‼` `⁇` `⁈` `⁉` `।` `॥` `؟` `۔` are now sentence terminators.
- **Placeholders after a period.** `2020. [citation needed] Tickets sold
  out.` mislabeled the second sentence as the gap, and with no space the two
  fused into one placeholder that passed `isClean`. A placeholder after a
  period is now peeled onto the sentence before it, like a marker.
- **`TK` placeholder false positives.** The default placeholder pattern needs
  a word boundary after its keyword, so `[Tkachenko 2019]`, `[TKO Group]` and
  `[tkinter docs]` are no longer placeholders.
- **Multi-cite false fails.** `X [[cite:e1]] and Y [[cite:e2]].` failed both
  ids because each was judged against the whole sentence. Each citation is
  now judged against its own span (see "Changed").
- **Short-evidence false passes.** The default `supports` passed any claim
  that contained the evidence string anywhere (`"Acme"` supported a
  fabricated sentence; `"cat"` matched `"Catalog"`). Containment is now
  whole-word, and the evidence must be at least 12 characters and 60% of the
  claim for the containment shortcut.
- **Scripts with combining marks and without spaces.** The default
  `supports` stripped combining marks (Hindi vowel signs split words apart)
  and could not partially match Chinese, Japanese or Thai. Marks now stay
  with their letters, and unspaced scripts are compared by overlapping
  two-character pieces.
- **Markdown false fails.** Numbered lists, headings, rules, table header and
  separator rows, bold labels, `Step 1.` and `IV.` each became a phantom
  uncited sentence. See "Changed" for the new markdown handling.
- **Abbreviation false fails.** `U.S. Department`, `e.g. Apple`, `i.e. IP68`,
  `9 a.m. Eastern`, `Sr. García`, `Gov.`/`Sen.`/`Mt.`, `Acme Inc. CEO`,
  `Jan. 5` and `Sept. 12` split mid-sentence. The reverse also fused: `Ask
  us. 24 hours later` and `etc. iPhone cases` were one sentence.
- **Other false fails.** Hard-wrapped lines split per line; a `;` inside
  parentheses or an HTML entity (`&amp;`) split a clause; a URL after a
  citation split at its `:`; markdown link targets and bare URLs diluted the
  word overlap; CR-only and U+2028/U+2029 line breaks did not separate lines.
- **Silent configuration mistakes.** An unknown key in `config` or
  `abbreviations` was ignored; it now throws a `TypeError`. An abbreviation
  entry written with a dot (`"dr."`) never matched; entries are now compared
  without dots, and an entry that could never match (a digit, a space) throws.

### Changed (behavior)

- **Per-citation spans.** In a sentence with several groups of citations,
  each group is judged against its span (the text since the previous group,
  plus the trailing text for the last group). A span with three or more
  content words is judged on its own; a span with one or two is accepted if
  the whole sentence or the span passes; an empty span uses the whole
  sentence. Who notices: a sentence where a citation sits next to a claim it
  doesn't support now fails even if that id supports the whole sentence
  (`Prices doubled last spring [[cite:e1]] while <e1's claim> [[cite:e1]].`),
  and a custom `supports` may now receive a span instead of the whole
  sentence and be called once per distinct (id, text) pair.
- **Shared citation groups (default matcher).** Ids cited side by side may
  share the work: an id that fails alone is accepted when the group's
  evidence together covers 60% of the content words and this id covers at
  least two.
- **`reasons` on every `SentenceClassification`**: per distinct id,
  `supported`, `no-content-words`, `not-supported`, `invalid-evidence` or
  `unknown-id`. Code that deep-compares whole result objects will see the new
  field.
- **No-content claims.** With the default `supports`, a citation on a
  sentence with no word longer than three characters and no number (`Yes
  [[cite:e1]].`) is accepted unchecked with the reason `no-content-words`
  instead of being `invalid`. A claim with no long word but a number (`Tax is
  5%`) is compared by its numbers. `defaultSupports` itself still returns
  `false` for a claim with nothing to compare.
- **Markdown (`config.markdown`, default `true`).** Headings that don't end
  like a statement, rules, table header and separator rows, short emphasized
  labels, short lead-in lines ending in a colon before a list, table or code
  block, and fenced code blocks are set aside and listed in the new
  `DocumentClassification.nonClaims`; one that carries a marker or
  placeholder or ends like a statement is still checked. List numerals stay
  with their item, and a hard-wrapped line that continues a sentence is
  joined to it. `markdown: false` restores line-by-line plain text. Who
  notices: markdown reports that used to fail on phantom units now pass, and
  `splitSentences` no longer returns those lines.
- **Default abbreviations** gain `gov sen mt lt sgt capt rev messrs cf viz`
  (always fuse), move `eg ie` to always fuse, and gain `plc est ca phd md`,
  the month abbreviations, and `uk eu` (context fuse). `am`, `pm` and `us`
  count only when written with an inner period. A few context words continue
  before a capital in a narrow context (`a.m.` before a time zone, `U.S.`
  before a word that is not a sentence opener, `Inc.` before a title, any
  abbreviation that starts its sentence except `no`).
- **A placeholder at the start of a line or document** stays with the text
  after it; elsewhere a leading placeholder is peeled onto the previous unit.
- **`stripCitationMarkers`** changes only the text at marker sites. It no
  longer collapses double spaces, removes the space before punctuation, or
  trims the end of the text elsewhere, and it puts a space between words a
  marker was glued between (`word[[cite:e1]]word` becomes `word word`).
- **Contextual abbreviations now treat any upper-case letter as a capital**
  (`Corp. Über` splits), not only `A-Z`.

### Documented

- The default matcher is described as a lexical check: a `not-supported`
  result is a lead for review, not a forged citation. "Forged" is no longer
  used for a weak lexical match.
- The multi-cite rule, the markdown rules, the abbreviation rules (including
  why the README's Spanish example puts `sr` in `alwaysFuse` while the
  English default has it in `contextFuse`), the default marker id charset
  (`a-z A-Z 0-9 _ -`) and what happens to anything else, the exact
  `stripCitationMarkers` behavior, and new limits (no stemming or synonyms,
  every sentence is a claim, unchecked markdown scaffolding, `J. Smith` after
  a lower-case word, `no. 3`, `U.S.` before a capital).
- The cost section states the formula and measured numbers for prose, not
  only marker-heavy text.

### Not changed

- A non-string evidence value is still classified `invalid` (now with the
  reason `invalid-evidence`) rather than throwing: ENGINEERING.md invariant 2
  and the AGENTS.md review rules require it.

## [0.2.1] - 2026-10-07

No change to the library's behavior or API.

### Changed

- The README links to the [in-browser playground](https://lkopietz3-byte.github.io/honesty-kits/#grounding-kit) and the honesty kits family, and the npm homepage now points to the playground.
- Added the `honesty-kits` npm keyword so the family shows up together in search.

### Security

- Development lockfile: `source-map-js` 1.2.2 (GHSA-68fv-2mgg-jv7q). Development tooling only; the published package has no runtime dependencies.

## [0.2.0] - 2026-09-29

Minor release: some inputs that used to be accepted now throw, and a few
inputs now split differently. Every `splitSentences` result for text without
invisible characters is otherwise unchanged (checked against the 0.1.1
splitter on fixtures and a seeded random corpus). The ten runtime exports
keep their signatures; `GroundingConfigError` is new.

### Changed (breaking)

- **A marker pattern that matches zero characters throws (GK-F02).**
  `splitSentences('abc', { markerPattern: /()/g })` used to hang forever in
  the leading-marker step. Every marker scan, and the leading-marker step,
  now throws `GroundingConfigError` (a `TypeError` subclass) when a match is
  empty, for `/()/g`, for a lookahead such as `/(?=(a))/g`, and on every
  entry point (`splitSentences`, `classifySentence`, `classifyDocument`,
  `extractCitedIds`, `extractAllCitedIds`, `stripCitationMarkers`).
- **`supports` must return a real boolean (GK-F04).** A non-boolean result
  (a `Promise` from an `async` function, `"false"`, `0`, `1`, `undefined`, an
  object) used to be read by truthiness, so `async () => false` grounded
  every citation. It now throws `GroundingConfigError`. The result is never
  awaited, and a rejected `Promise` is marked handled so it cannot also crash
  the process. A non-function `supports` throws a `TypeError` up front.
- **`evidenceMap`, `config` and `abbreviations` must be plain objects.** A
  `Map`, `Set`, `Date`, array or class instance used to be read as empty
  (every citation `invalid`, or the defaults silently used) and now throws a
  `TypeError`. Plain objects, null-prototype objects and plain objects from
  another realm are accepted. A `null` config now throws a `TypeError`
  instead of a raw "Cannot read properties of null".
- **Abbreviation lists must be dense arrays of strings.** A sparse array or a
  non-string entry throws a `TypeError` with the offending index. Before,
  `map` skipped holes while the set built from them saw them.
- **`markerPattern` and `placeholderPattern` must be `RegExp`s**, and the
  string arguments of `extractCitedIds`, `extractAllCitedIds` and
  `stripCitationMarkers` must be strings; each throws a clear `TypeError`
  instead of a raw one.
- **Invisible characters no longer hide a sentence boundary.** A
  default-ignorable character (zero-width space or joiner, word joiner, soft
  hyphen, bidi control, variation selector, Hangul filler) right after a
  terminator kept the boundary regex from seeing "terminator, whitespace",
  so `"Uncited claim.\u200b Next claim [[cite:e1]]."` was one grounded
  sentence and `"...occasionally.\u200b[[cite:e1]] The claimant lost
  $500,000."` let the second claim ride the first claim's citation. A real
  space is now inserted after the terminator, and invisible characters in
  front of a marker count as leading space when the marker is peeled back to
  the sentence it ends. The invisible characters are kept in the output.
- **A unit that shows nothing is dropped.** A line, clause or remainder made
  only of whitespace, default-ignorable and control characters used to be
  returned as an "ungrounded" unit. It is no longer a unit.
- **The default placeholder pattern allows 200 characters of note** (was
  unbounded). `[more research needed: ...]` notes up to 200 characters still
  match; a longer note is no longer a placeholder and is classified by its
  citations. This removes a quadratic scan (see below).

### Fixed

- **Nested brackets were quadratic (GK-F01).** Each closing bracket repainted
  its whole matched interval, so 50,000 nested pairs (100,000 characters)
  took about 700 ms, and 4x the pairs took 16x the time. Matched intervals
  are now marked in a difference array and resolved with one prefix sum: the
  same input takes about 5 ms. (Timings are from one development machine on
  Node 26, not a promise.)
- **Four more quadratic inputs on the default path.** Marker adjacency
  indexed into a string built with `+=`, which flattens it on every marker (50,000
  cited sentences: about 2.4 s, now under 100 ms); a long run of unclosed
  `[TK` made the default placeholder scan every start position to the end of
  the text (60,000 repeats: about 4 s, now under 30 ms); and the trailing-word regex
  retried its scan from every start on a long run of letters ending in a
  digit and a period (100,000 letters: about 5 s, now under 5 ms).
- **A sticky marker or placeholder flag suppressed citations (GK-F03).** With
  `/\[\[cite:([\w-]+)\]\]/gy`, `"Claim [[cite:missing]] [citation needed]."`
  was `placeholder` and clean, because the scan only matched at index 0. Scans
  now use a private global, non-sticky copy, so `g`, `y`, `gy` and no flags
  agree. The caller's regex, `lastIndex` and flags are never touched.
- **Options and evidence were read more than once.** `classifyDocument` read
  `config` again for every sentence, and an evidence value once per citation,
  so a getter or Proxy could answer differently mid-document. Each is now read
  once per call.
- A marker followed by a terminator and a letter outside the Basic
  Multilingual Plane (for example a CJK Extension B ideograph) did not get its
  separating space, because only the first UTF-16 unit was tested.
- Error messages describe a value by kind only and cannot throw on a
  BigInt, a revoked Proxy or an object with a throwing `toString`.
- **`supports` ran once per citation, not once per distinct id.** A sentence
  that repeated one id 20,000 times (`"word [[cite:e1]] ".repeat(20000)`)
  called the default `supports` 20,000 times on the same claim text, which took
  about 10 s in `classifyDocument` on a developer laptop (the review measured
  about 36 s). Within a sentence, `supports` is now called once per distinct
  cited id and its answer is reused for repeats (the same input takes about
  10 ms). Results are identical for a pure callback; a callback that counts its
  calls now sees fewer of them. Classification cost is about (distinct ids per
  sentence) x (sentence length), and README and ENGINEERING.md now say so
  instead of implying linear work for classification.

### Added

- `GroundingConfigError`, exported, with TSDoc: a `TypeError` subclass for the
  zero-length-marker and non-boolean-`supports` errors.
- Tests: a frozen copy of the 0.1.1 splitter (`test/legacy`) compared with the
  new one on fixtures and 20,000 seeded random documents; scaling
  regressions for every quadratic family (time ratio for 4x the input, plus a
  100,000-character budget for nested brackets); watchdog-guarded liveness tests
  for zero-length markers; and tests for the glued-marker cases, the
  trailing-citation fragment, the `defaultSupports` word rules and the clean flag.

### Docs

- README: an ESM/`require()` compatibility table, the Node support policy,
  the sticky-flag and zero-length rules, the boolean-only `supports` rule, what
  `isClean` does and does not mean, an Errors section, and corrected sibling
  descriptions (provenance-kit and corroboration-kit) and citation-tool text.
- CI: the compatibility job also runs on Node 20.19.0 and 22.12.0 (the
  `require(esm)` floors); the release workflow runs the dependency audit and
  `npm run attw`, requires a `v*` tag on both triggers, and treats only a
  confirmed `E404` as "not published".

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

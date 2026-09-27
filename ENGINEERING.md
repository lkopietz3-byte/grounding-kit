# Engineering contract

## Invariants (the promises the code is tested against)

1. Classification precedence is fixed: `invalid` > `placeholder` >
   `grounded` > `ungrounded`. A forged/unknown citation always outranks an
   honest placeholder gap.
2. Evidence lookup is own-property-only (`Object.hasOwn` + a `typeof
   === "string"` guard). A marker id that names an inherited
   `Object.prototype` member (`"__proto__"`, `"constructor"`,
   `"toString"`, ...) or maps to a non-string value classifies as
   `invalid`; it never throws.
3. `splitSentences` never silently loses a non-whitespace character, with
   two documented exceptions: the separator character itself at an accepted
   `;` / em-dash / cited-colon clause boundary (consumed by design — see
   README "Clause-level splitting"), and a leading citation marker with
   nothing before it anywhere in the whole document (it can't ground
   anything, so it's dropped). Covered by a seeded-PRNG property test.
   Bracket matching for clause splitting fails closed: an unbalanced `[`
   never suppresses a later real split.
4. Classification is deterministic: same input -> same output, independent
   of `evidenceMap` key insertion order, with no `Date.now`/`Math.random`
   anywhere in the library.
5. No known quadratic-time input as of 2026-09-24 (three O(n²) inputs were
   found by fuzzing and fixed — see CHANGELOG). Empirical, not a formal
   proof; each fixed case has a hard-time-budget regression test.
6. Internal code never mutates a caller-supplied `RegExp`, and never
   mutates `DEFAULT_MARKER_PATTERN`/`DEFAULT_PLACEHOLDER_PATTERN`'s
   `lastIndex`. `DEFAULT_ABBREVIATIONS` is frozen (object + both arrays).
7. Zero runtime dependencies.

## Setup and verification

```bash
npm ci                 # install pinned dependencies
npm run verify          # lint + typecheck + test + build + verify:package
npm audit --include=dev
```

`npm run verify:package` packs the real tarball, installs it into a scratch
project, imports it by name, runs `scripts/consumer-probe.mjs` against the
real API, type-checks `scripts/consumer-probe.mts` under strict NodeNext,
and diffs the exported names against `api-surface.json` so an API change is
always a deliberate, reviewed diff (`--update-api` to accept one).

CI (`.github/workflows/verify.yml`) runs this on every PR and push to `main`,
plus a separate Node 20/22/24 compatibility job against the packed tarball.

## What this is NOT certified to do

See the README's "Limits" section in full. In short: `defaultSupports` is
normalized substring/word-overlap matching, not semantic entailment or
truth-checking; the sentence splitter is a heuristic (its default
abbreviation list is small and does not cover every common abbreviation,
e.g. month names like "Jan." or degree suffixes like "Ph.D." are not in
it); and `isClean`/`grounded` describe
"passed this library's mechanical structural check," never "verified true."

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs
automatically before publish via the `prepublishOnly` script. To cut a
release: bump `version` in `package.json`, add a `CHANGELOG.md` entry, tag
the commit, then `npm publish`. npm allows `npm unpublish` only within 72
hours of publishing, so prefer publishing a fixed patch release over trying
to unpublish a bad one — this package has no server component and no
migration state to reverse either way.

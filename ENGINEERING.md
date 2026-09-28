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

## Are the types wrong? (attw)

CI runs [`arethetypeswrong`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
(`npm run attw`, which is `attw --pack . --ignore-rules cjs-resolves-to-esm`)
against the packed tarball after the build step. The `cjs-resolves-to-esm` rule is ignored on
purpose: this is an ESM-only package (`"type": "module"`, no `require` entry point), so a
CommonJS consumer must use Node's `require(esm)` support (Node >=20.19 or >=22.12 — see
"Runtime support policy" below) rather than a native `require`. A dual CJS+ESM build was
rejected to avoid the dual-package hazard (two separately-identified copies of the same module,
with broken `instanceof` checks and duplicated module state across the CJS and ESM entry
points).

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs automatically before
publish via the `prepublishOnly` script, so a broken build cannot reach the registry by
accident. To release: add a dated entry to `CHANGELOG.md`, bump `version` in
`package.json`, commit, and push a `vX.Y.Z` tag that matches the new version, then let
`.github/workflows/release.yml` install, verify, and publish it. (You can also run
`npm publish` locally; `prepublishOnly` still guards it.)

npm's unpublish policy is deliberately narrow. Within 72 hours of publishing, a version can be
unpublished only if no other published package depends on it. After 72 hours, unpublishing also
requires fewer than 300 downloads in the last week and a single maintainer — most released
versions won't qualify either way. A given `name@version` can never be reused, published or
not, even after an unpublish. Treat unpublish as unavailable: prefer fixing forward with a new
patch version, and use `npm deprecate <name>@"<range>" "<message>"` to warn consumers off a
bad release while it stays installable for anyone already pinned to it.

### Runtime support policy

- **Supported (recommended for production):** Node 22 and 24 LTS; Node 26 current.
- **Compatibility-tested:** Node 20. Node 20 is end-of-life — nodejs.org's release page
  (<https://nodejs.org/en/about/previous-releases>) lists it as `EOL`, with its final release
  dated Mar 24, 2026. The `compat` job in `verify.yml` still runs on Node 20 to catch
  regressions, but that runtime gets no security fixes upstream; don't run production traffic
  on it.
- CommonJS `require()` of this package needs Node >=20.19 or >=22.12 (`require(esm)`
  support). ESM `import` works on every version this package tests (20, 22, 24).
- `engines` in `package.json` is unchanged by this policy.

### Publishing with provenance

`.github/workflows/release.yml` publishes using npm trusted publishing: it triggers on
`workflow_dispatch` or a pushed `v*` tag, requests a short-lived OIDC token instead of
reading a stored npm token (`permissions: id-token: write`), and runs a plain `npm publish`
with no token and no `--provenance` flag, because provenance attestation is generated
automatically under trusted publishing. Before publishing, the workflow confirms the tag
matches `package.json`'s `version` and checks whether that version is already on the
registry, so re-running it on a version that's already published is a no-op rather than an
error. Trusted publishing must be configured for this package on npmjs.com (linking it to this
GitHub repository and the `release.yml` workflow) before the first automated release will
work.

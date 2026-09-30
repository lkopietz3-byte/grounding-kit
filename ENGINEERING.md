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
3. `splitSentences` never silently loses a visible character, with three
   documented exceptions: the separator character itself at an accepted
   `;` / em-dash / cited-colon clause boundary (consumed by design — see
   README "Clause-level splitting"), a leading citation marker with
   nothing before it anywhere in the whole document (it can't ground
   anything, so it's dropped), and a unit made only of whitespace,
   default-ignorable and control characters (it shows nothing, so it is not
   a claim). Covered by a seeded-PRNG property test. Bracket matching for
   clause splitting fails closed: an unbalanced `[` never suppresses a later
   real split. A default-ignorable character right after a terminator, or in
   front of a marker, cannot hide a boundary.
4. Classification is deterministic: same input -> same output, independent
   of `evidenceMap` key insertion order, with no `Date.now`/`Math.random`
   anywhere in the library.
5. No known quadratic-time input to `splitSentences` as of 2026-09-28 for the
   default patterns (seven O(n²) inputs have been found and fixed — see
   CHANGELOG). Empirical, not a formal proof; each fixed case has a regression
   test, and the nested-bracket family has a hard 100,000-character time budget
   plus a scaling check. A caller-supplied regex that backtracks badly is the
   caller's configuration and is not covered. Classification is not linear in
   the worst case: `supports` runs once per distinct cited id per sentence, so
   one sentence costs about (distinct ids) x (sentence length) with the default
   `supports`, and one id repeated many times costs one call.
6. Internal code never mutates a caller-supplied `RegExp` (or the
   `lastIndex` of `DEFAULT_MARKER_PATTERN`/`DEFAULT_PLACEHOLDER_PATTERN`):
   it scans with a private global, non-sticky copy. `DEFAULT_ABBREVIATIONS`
   is frozen (object + both arrays).
7. Zero runtime dependencies.
8. A marker match of zero characters throws `GroundingConfigError`; the
   marker scans never loop. A `supports` result that is not a real boolean
   throws `GroundingConfigError`; it is never awaited or coerced.
9. Caller input is read once. `config` options, abbreviation lists and each
   evidence value are snapshotted per call, so a getter or Proxy cannot
   answer differently for a later sentence. `config`, `abbreviations` and
   `evidenceMap` must be plain or null-prototype objects.

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

CI (`.github/workflows/verify.yml`) runs this on every PR and push to `main`
(audit, lint, typecheck, test, build, `npm run attw`, package verification),
plus a compatibility job that runs the build, tests and package verification
(including the CommonJS `require()` probe) on Node 20, 20.19.0, 22, 22.12.0
and 24. 20.19.0 and 22.12.0 are the documented `require(esm)` floors.

`test/legacy/legacySplitter.ts` is a frozen copy of the 0.1.1 splitter. Only
`test/differential.test.ts` uses it, to prove the linear rewrite returns the
same output as the old code on fixtures and a seeded random corpus. Do not
import it elsewhere.

Mutation testing is run locally, not in CI: install
`@stryker-mutator/core` and `@stryker-mutator/vitest-runner` with
`npm i -D --no-save`, use a `stryker.config.json` that is not committed, and
leave out `test/scaling.test.ts` (instrumented code is too slow for its time
budgets).

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

This package has no server component and no migration state to reverse either way.

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
automatically under trusted publishing. Before publishing, the workflow requires
the run to be on a `v*` tag (a manual run started from a branch fails), confirms the tag
matches `package.json`'s `version`, runs `npm run audit:dependencies`, `npm run verify` and
`npm run attw`, and checks whether that version is already on the registry. Only a confirmed
`E404` counts as "not published"; any other registry error fails the job. Re-running it on a
version that's already published is a no-op rather than an error. Trusted publishing must be configured for this package on npmjs.com (linking it to this
GitHub repository and the `release.yml` workflow) before the first automated release will
work.

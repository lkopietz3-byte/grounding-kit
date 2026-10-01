# grounding-kit — agent instructions

Deterministic, zero-dependency sentence-level citation-grounding checker for AI-generated text. Splits text into sentences and classifies each as grounded, placeholder, ungrounded, or invalid (forged citation) — no LLM judge required.

## Read first
- `ENGINEERING.md` holds this package's invariants and design rules; read it before changing behavior.
- `PROJECT_CONTEXT.md` is the current project state and decisions.
- `SECURITY.md` covers the security posture; follow it for anything touching input handling.

## Commands (from package.json)
- `npm run verify`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run verify:package` packs and installs the tarball offline; run `npm run build` first.

## Rules
- Run `npm run verify` and read its output before calling work done. Report any step that did not run.
- Build cleans `dist/` first; never trust a stale `dist/` for declaration or package checks.
- Never weaken lint, tests or `api-surface.json` to get green. Public API changes are deliberate (`node scripts/verify-package.mjs --update-api`) and must be called out.
- Do not run `npm publish` or push tags without explicit permission. Treat any claim that a version is published as Reported until the registry confirms it.
- Runtime `dependencies` stay empty; add dev tooling only.
- Keep unrelated uncommitted work intact; never stage or reset the whole tree.

## Review preparation

See [docs/REVIEW_READINESS.md](docs/REVIEW_READINESS.md) for milestone review cadence, declared verification gates and the next launch-preparation task.

## Code Review Rules

- Preserve classification precedence: invalid citation outranks placeholder, then grounded and ungrounded. Missing, inherited or non-string evidence entries must classify as invalid rather than supporting a clean result.
- Keep defaultSupports described as substring/word-overlap matching, not semantic entailment. A custom supports hook must return a synchronous boolean; do not silently accept async or malformed hook results.
- Preserve documented sentence-splitting character handling and exceptions. isClean is structural: placeholders and a lack of checkable sentences can still yield true, so consumer publishing claims must account for counts and sentence results.

# Review and launch readiness

Updated September 30, 2026 for the 0.2.0 follow-up against main `20e5335`. This is a preparation plan, not a completed product audit or marketing certification.

## Review cadence

Keep automatic code reviews off during preparation. Request one focused `@codex review` on a meaningful candidate PR after relevant checks; repeat only when material changes invalidate that review. Do not add a recurring review schedule.

When this repo enters sustained launch or customer-facing development, enable its repository setting individually with **All PRs / On PR open / Exhaustive Off**. Keep the personal automatic default and credit-funded reviews off. Inspect the first result before expanding cadence. Review guidance lives in the root [AGENTS.md](../AGENTS.md); it supplements existing tests and release requirements.

Before changing review automation, inspect the current repository and personal settings in ChatGPT. This document does not activate or verify those settings.

## Next preparation task

For the next candidate after 0.2.0, attach a packed-consumer receipt for a cited sentence, an invalid evidence reference, a placeholder and an input with no checkable sentences. Existing semantic-limit disclosures should remain visible.

Finish condition: Actual result counts and classifications match the selected candidate; the demo does not present a structural clean result as semantic truth or a completed evidence review.

## Declared verification commands

Read from the inspected main's `package.json`. These are declared gates, not execution receipts; see the candidate PR for hosted-check results and report unavailable checks explicitly. Use focused checks during implementation and the existing release gates on the frozen candidate.

- `npm run verify`: `npm run lint && npm run typecheck && npm test && npm run build && npm run verify:package`
- `npm run lint`: `eslint . --max-warnings=0`
- `npm run typecheck`: `tsc --noEmit`
- `npm run test`: `vitest run`
- `npm run build`: `node -e "require('fs').rmSync('dist',{recursive:true,force:true})" && tsc -p tsconfig.build.json`
- `npm run verify:package`: `node scripts/verify-package.mjs`
- `npm run attw`: `attw --pack . --ignore-rules cjs-resolves-to-esm`

Local tests, hosted authorization, installed package behavior, deployment and buyer evidence are separate outcomes. A dated receipt applies to its recorded revision.

## Source basis

- [ENGINEERING.md](../ENGINEERING.md)
- [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
- [src/classify.ts](../src/classify.ts)

Public claims require current candidate evidence. Private-data transfers, commercial commitments, package publication, database promotion and deployment retain their existing authorization boundaries.

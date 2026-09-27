# grounding-kit

Deterministic, zero-runtime-dependency citation-grounding checker for
AI-generated text. Splits generated text into sentences and classifies each
one as `grounded`, `placeholder`, `ungrounded`, or `invalid` against a map of
the evidence you actually gave the model — so you can catch an ungrounded
claim, an honest "no source" gap, or a **forged citation marker** before it
ships to a user.

No LLM calls, no network access, no embeddings required to run (though you
can plug one in). Pure string/regex logic, framework-agnostic, works in any
JS/TS runtime.

## Why this exists

If your product generates text with inline citations — a summarizer, a
report drafter, a RAG answer engine, anything that emits `"claim [[cite:e1]]"`
— you have two independent failure modes to catch before the text ships:

1. **The claim is unsupported.** No citation at all, or an honest
   `[citation needed]`-style placeholder standing in for one.
2. **The citation is forged.** A marker is present and *looks* like grounding,
   but it points at evidence that doesn't say what the sentence claims — or
   at an id that doesn't exist at all. This is worse than an unsupported
   claim, because it reads as authoritative.

Generic RAG-hallucination tools (RAGAS, TruLens, DeepEval, and similar) exist
and are useful, but they're LLM-judge-based: they ask a model whether an
answer seems grounded in retrieved context. They don't parse citation markers
at the sentence level, they don't have a notion of "this specific marker is
forged onto the wrong sentence," and they're not zero-dependency — you need
an LLM call (and its cost, latency, and non-determinism) to get an answer.

The closest academic relative is
[CiteCheck (arXiv 2605.27700)](https://arxiv.org/abs/2605.27700), which
checks whether a **cited paper** exists and matches its citing statement —
a document/reference-level check. This library does something narrower and
more mechanical: it checks whether a citation **marker** in a piece of text
points to the actual **evidence span** that's supposed to support that
sentence, using a deterministic (non-LLM) parser. It is not a substitute for
CiteCheck's problem (paper-existence/matching) or for an LLM judge's problem
(open-ended semantic grounding). It's a fast, free, offline first pass that
catches a specific, mechanical, and surprisingly common failure: a citation
marker sitting on the wrong sentence, or pointing at nothing.

Run it before an LLM judge, not instead of one, if your stakes justify both.

**Relationship to corroboration-kit:** a sibling, similarly-shaped library
that answers a different question. grounding-kit checks that a citation
*marker* in generated text actually points at the evidence span it's
supposed to (mechanical, sentence-level, no judgment about the evidence
itself). corroboration-kit takes evidence *signals you've already collected*
about a claim and grades how independently corroborated that claim is (2+
independent sources vs. a single source vs. none). Use grounding-kit to catch
a forged or misattributed citation marker; use corroboration-kit once you
have real evidence in hand and need to grade how much it's worth.

## Install

```bash
npm install grounding-kit
```

Or build from source:

```bash
git clone https://github.com/lkopietz3-byte/grounding-kit.git
cd grounding-kit
npm install
npm run build
```

Zero runtime dependencies either way — nothing else gets pulled in.

## Quick start

```ts
import { classifyDocument } from "grounding-kit";

// evidenceMap: citation marker id -> the evidence text it's allowed to support.
// In a real app this is whatever you actually fed the model (retrieved
// chunks, a database row, a user-supplied source) — the closed world of
// things the model is allowed to cite.
const evidence = {
  e1: "independent lab testing measured 14 hours of battery life on a full charge",
  e2: "the product ships with a 90 day return window and a 1 year limited warranty",
};

// Text your model generated, using your citation convention. The default
// convention is [[cite:<id>]]; see "Configuring the marker syntax" below to
// use your own.
const text = `
Battery life reached 14 hours in independent lab testing [[cite:e1]].
Some reviewers claim the app drains battery overnight.
The warranty covers accidental damage for five years [[cite:e2]].
We could not verify the exact refund processing time [citation needed].
`;

const result = classifyDocument(text, evidence);

console.log(result.counts);
// { grounded: 1, placeholder: 1, ungrounded: 1, invalid: 1 }

console.log(result.isClean); // false — block export, flag for review

for (const s of result.sentences) {
  console.log(s.status.padEnd(11), "-", s.sentence);
}
// grounded    - Battery life reached 14 hours in independent lab testing [[cite:e1]].
// ungrounded  - Some reviewers claim the app drains battery overnight.
// invalid     - The warranty covers accidental damage for five years [[cite:e2]].
//               (e2 is about the return window, not damage coverage — forged cite)
// placeholder - We could not verify the exact refund processing time [citation needed].
```

## API

### `splitSentences(text, config?) => string[]`

Splits text into sentence-level (technically clause-level, see below)
grounding units, keeping each citation marker attached to the unit it
actually grounds. Hardened against:

- **Abbreviation periods that don't end a sentence** — "Dr. Alvarez reviewed
  the unit." stays one sentence, via a configurable fusion list (see below).
- **Non-ASCII sentence terminators** (`。` `．` `！` `？`), so a converted
  document or non-English text isn't silently mis-split.
- **A marker glued to adjacent text with no whitespace** — `"...reviewed.[[cite:e1]]The next..."`
  is normalized before splitting so it can't fuse two sentences into one.
- **Leading-marker peeling** — a marker sitting right after a sentence's
  terminal period is attached to *that* sentence, not read as grounding the
  sentence that follows. This is the core defense against citation
  laundering: without it, `"Real claim [[cite:e1]] Fabricated claim."` would
  let the fabricated half ride the real citation.
- **Clause-level splitting** on `;`, em-dash, and a colon that follows an
  already-cited clause, so an uncited clause can't hide behind a citation
  elsewhere in the same sentence. Commas are deliberately *not* split — one
  citation legitimately covers a comma-joined sentence.
- **Fail-closed bracket matching** — an unbalanced `[` never suppresses a
  later clause split. Erring toward more (smaller) units is always safe: it
  can only ask for more grounding, never launder a claim past the checker.

```ts
import { splitSentences, DEFAULT_ABBREVIATIONS } from "grounding-kit";

splitSentences("Dr. Alvarez reviewed the unit. It shipped the next day.");
// ["Dr. Alvarez reviewed the unit.", "It shipped the next day."]

// Override the abbreviation list entirely — e.g. for another language, or to
// add domain-specific ones. It replaces DEFAULT_ABBREVIATIONS, it doesn't
// merge with it, so you always know exactly what's active.
splitSentences(text, {
  abbreviations: {
    alwaysFuse: ["dr", "sra", "sr"],       // never ends a sentence
    contextFuse: ["etc", "no", "vol"],     // ends a sentence unless followed by lower-case/digit
  },
});
```

### `classifySentence(sentence, evidenceMap, config?) => SentenceClassification`

```ts
interface SentenceClassification {
  sentence: string;
  status: "grounded" | "placeholder" | "ungrounded" | "invalid";
  citedIds: string[];   // every marker id cited, including forged ones
  validIds: string[];   // cited ids that exist in evidenceMap AND pass supports()
}
```

Classification rule, in precedence order (highest first):

1. **`invalid`** — the sentence cites at least one marker id that either
   doesn't exist in `evidenceMap`, or whose evidence text doesn't pass the
   `supports()` check (see below). A forged citation outranks everything
   else: even if the sentence also contains a placeholder, a bad cite can't
   hide behind an honest gap.
2. **`placeholder`** — no invalid citation, and the sentence matches the
   placeholder pattern (default: `[citation needed]`, `[more research
   needed: ...]`, `[TK ...]`).
3. **`grounded`** — no invalid citation, no placeholder, and at least one
   citation marker, all of which are valid.
4. **`ungrounded`** — none of the above: a bare, uncited factual claim.

```ts
import { classifySentence } from "grounding-kit";

classifySentence(
  "The warranty covers accidental damage for five years [[cite:e2]].",
  { e2: "the product ships with a 90 day return window and a 1 year limited warranty" },
);
// { status: "invalid", citedIds: ["e2"], validIds: [] }
// e2 exists, but its text doesn't support "covers accidental damage" —
// this is what a forged/misattributed citation looks like.
```

### `classifyDocument(text, evidenceMap, config?) => DocumentClassification`

Runs `splitSentences` + `classifySentence` over a whole document.

```ts
interface DocumentClassification {
  sentences: SentenceClassification[];
  counts: Record<"grounded" | "placeholder" | "ungrounded" | "invalid", number>;
  citedEvidenceIds: string[]; // distinct ids validly cited anywhere in the document
  isClean: boolean;           // true iff ungrounded === 0 && invalid === 0
}
```

`isClean` is the export gate: block shipping the text (or route it to human
review) until it's `true`. `placeholder` is not a failure — it's the honest
alternative to fabricating, and should be surfaced for a human to fill in,
not silently accepted or silently rejected.

### Configuring the `supports()` check

```ts
type SupportsFn = (sentenceText: string, evidenceText: string) => boolean;
```

`classifySentence`/`classifyDocument` accept `config.supports` to decide
whether a piece of evidence actually backs a claim. The **default**
(`defaultSupports`) is intentionally naive: normalized substring containment,
falling back to a >=60% word-overlap ratio on words longer than 3 characters.
It's good enough to catch an obviously wrong or missing citation and to run
in CI with zero cost or latency — see **Limits** below for what it can't do.

```ts
import { classifyDocument, type SupportsFn } from "grounding-kit";

const embeddingSupports: SupportsFn = (claim, evidenceText) => {
  const sim = cosineSimilarity(embed(claim), embed(evidenceText));
  return sim >= 0.82; // tune against your own labeled examples
};

classifyDocument(text, evidence, { supports: embeddingSupports });
```

An NLI-style entailment model works the same way: return `true` only when
`evidenceText` entails `sentenceText` (not merely relates to it).

### Configuring the marker/placeholder syntax

Both are plain regexes, so you can match whatever your generator already
emits instead of adopting this library's default `[[cite:id]]` convention.

```ts
splitSentences(text, {
  markerPattern: /\[(\d+)\]/g,              // "claim [3]" style footnotes
  placeholderPattern: /\[(?:tbd|unsourced)\]/i,
});
```

`markerPattern` must contain exactly one capture group: the marker id. Any
regex flags are fine — the library always takes a fresh copy internally, so
reusing the same `RegExp` object elsewhere (including with `.test()`) is
safe.

**Note on bracket protection:** the fail-closed clause splitter treats any
matched `[ ... ]` span as unsplittable (so a `;` inside a marker or
placeholder is never mistaken for a clause boundary), and additionally
shields whatever `markerPattern`/`placeholderPattern` match directly even if
they use a different delimiter (`{{ref:1}}`, `<cite id="1">`, etc.). If your
convention doesn't use brackets at all, the second mechanism still covers it.

### Utilities

- `extractCitedIds(sentence, markerPattern?) => string[]` — every marker id
  in a sentence, in order, duplicates kept.
- `extractAllCitedIds(text, markerPattern?) => string[]` — distinct marker
  ids anywhere in a document, first-appearance order.
- `stripCitationMarkers(text, markerPattern?) => string` — remove markers for
  display/export, cleaning up any stray double-space or space-before-punctuation
  left behind.

## Limits (read this before shipping on the default config)

- **`defaultSupports()` is naive substring/word-overlap matching, not
  semantic entailment.** It will pass some claims that only coincidentally
  share words with their evidence, and it will fail some genuinely correct
  paraphrases that don't share enough vocabulary. It has no notion of
  negation, numeric precision, or logical entailment — `"revenue grew 40%"`
  and `"revenue grew 4%"` share every word except one digit and may read as
  supporting each other. For anything higher-stakes than a fast first pass
  or a CI smoke test, replace it with an embedding-similarity or NLI-based
  `supports` function trained/tuned on your domain.
- **This is a mechanical parser, not a truth checker.** It verifies that a
  citation marker points at evidence text that plausibly relates to the
  sentence — the same "does the shape hold together" contract a linter
  enforces on code. It cannot verify that the evidence itself is true, that
  the evidence was retrieved correctly, or that a "grounded" sentence hasn't
  subtly distorted what the evidence actually says (e.g. dropping a
  qualifier, reversing a comparison). Treat a `grounded` result as "passed
  the structural check," not "verified true."
- **The sentence splitter is a heuristic, not a full NLP pipeline.** The
  default abbreviation list is small and English-oriented; dense technical
  or non-English text may need a tuned `abbreviations` config to avoid
  spurious splits. When in doubt it fails toward *more* (smaller) units,
  which is the safe direction for a grounding checker but can over-split
  unusual prose.
- **Evidence granularity is on you.** `evidenceMap` values can be a whole
  document or a single sentence-length span; the tighter the span, the more
  meaningful both the default overlap check and any injected `supports()`
  function will be.

## Development

```bash
npm install
npm run test        # vitest
npm run typecheck    # tsc --noEmit, strict
npm run build         # emit dist/ (ESM + .d.ts)
```

## License

MIT

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

An LLM-judge approach asks a model whether an answer seems grounded in
retrieved context. That can judge meaning, but every check costs a model call
(money, latency, and answers that can vary between runs). This library does
something narrower and more mechanical: it checks whether a citation
**marker** in a piece of text points to the actual **evidence span** that is
supposed to support that sentence, using a deterministic (non-LLM) parser. It
never decides whether the evidence is true or whether the sentence follows
from it.

A related but different problem is checking the citations themselves:
[CiteCheck (arXiv 2605.27700)](https://arxiv.org/abs/2605.27700) checks
whether cited scholarly works exist and whether their metadata is faithful.
This library does not look anything up. It is a fast, free, offline first pass
that catches a specific, mechanical, and surprisingly common failure: a
citation marker sitting on the wrong sentence, or pointing at nothing.

Run it before an LLM judge, not instead of one, if your stakes justify both.

**Relationship to corroboration-kit:** a sibling library that answers a
different question. grounding-kit checks that a citation *marker* in generated
text points at the evidence span it is supposed to (mechanical, sentence-level,
no judgment about the evidence itself). corroboration-kit applies fixed rules
to signals you have already collected and labeled, and returns a verdict
bounded by the coverage you report; it trusts your labels and is not
independent verification. See "Relationship to sibling kits" below.

## Install

```bash
npm install grounding-kit
```

Zero runtime dependencies. Ships TypeScript declarations. Or build from
source:

```bash
git clone https://github.com/lkopietz3-byte/grounding-kit.git
cd grounding-kit
npm ci
npm run build
```

It is an ESM package (`"type": "module"`). `import` is the supported way to
load it. `require()` also works where Node can `require(esm)`:

| How you load it | Node 20.19+ | Node 22.12+ | Node 24 and 26 | Older Node 20 or 22 |
| --- | --- | --- | --- | --- |
| `import { classifyDocument } from "grounding-kit"` | works | works | works | works |
| `require("grounding-kit")` | works | works | works | fails (no `require(esm)`); use `import()` |

Recommended runtimes are Node 22 and 24 (LTS) and Node 26 (current). Node 20 is
end-of-life. CI still runs the tests and the installed-package probes on Node
20.19.0 and 22.12.0 (the `require(esm)` floors) to catch regressions, but that
is compatibility testing, not a recommendation. `engines` in `package.json` is
`>=20`.

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
- **Invisible characters** — a zero-width space, bidi control, soft hyphen or
  other default-ignorable character placed right after a terminator, or in
  front of a marker, cannot hide a sentence boundary. A unit made only of
  whitespace and invisible characters is dropped instead of being returned as
  an "uncited claim". (Besides whitespace, `splitSentences` drops only those
  blank units, the clause separator itself at a `;`, em-dash or cited-colon
  boundary, and a marker with nothing before it; see ENGINEERING.md.)

Work is linear in the length of `text` for the default patterns, including
deeply nested brackets, long runs of markers, and unclosed `[TK` runs. A
pattern you supply can still be slow if its own regex backtracks badly.
Throws a `TypeError` for a non-string `text`, a `config` that is not a plain
object, or an option of the wrong type (see "Errors" below).

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

`isClean` is a structural result, not a verdict. It is `true` for a document
whose only findings are placeholders (unresolved gaps), and also for a
document with no checkable sentences at all (empty text, whitespace, or a
lone marker). Check `counts.placeholder` and `sentences.length` before you
treat it as "done".

**Cost.** Within a sentence, `supports` is called once per distinct cited id,
however many times that id repeats, so a sentence that cites `e1` twenty
thousand times costs one call. The default `supports` reads the whole sentence
on every call, so classifying one sentence costs about (distinct ids in the
sentence) x (sentence length). Measured on a developer laptop with the default
`supports`: a 340,000-character sentence that repeats one id 20,000 times took
about 10 ms, and a 154,000-character sentence citing 1,000 different ids took
about 1.7 s (2,000 ids in 169,000 characters: about 3.2 s). Text made of many short cited sentences
grows about linearly with its length (a scaling test covers this), but one
very long sentence that cites many different ids does not: its cost grows with
ids x length. A slow `supports` (an embedding or model call) multiplies that by
the number of distinct ids per sentence. The "linear" claim under
`splitSentences` covers splitting only, not classification.

`config` and `evidenceMap` are read once per call: the same patterns,
`supports` function and evidence values apply to every sentence, even if you
pass getters or a Proxy. `evidenceMap` must be a plain object or a
null-prototype object; a `Map`, `Set`, `Date`, array or class instance throws
a `TypeError` instead of being read as an empty map.

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

Within one sentence `supports` is called once per distinct cited id (a repeated
id reuses the first answer), so don't count on the number of calls.

`supports` must be synchronous and must return a real `boolean`. Anything
else (a `Promise` from an `async` function, the string `"false"`, `0`, `1`,
`undefined`, an object) throws `GroundingConfigError`. The kit never awaits
the result and never guesses what a non-boolean meant, because a truthy
`Promise` would otherwise read as "supported". If your judge is async, run it
first and pass the answers in through a synchronous lookup. An exception
thrown inside `supports` propagates unchanged.

### Configuring the marker/placeholder syntax

Both are plain regexes, so you can match whatever your generator already
emits instead of adopting this library's default `[[cite:id]]` convention.

```ts
splitSentences(text, {
  markerPattern: /\[(\d+)\]/g,              // "claim [3]" style footnotes
  placeholderPattern: /\[(?:tbd|unsourced)\]/i,
});
```

`markerPattern` must contain exactly one capture group (the marker id) and
must match at least one character. The kit does not count the groups: with no
group a marker is still recognized but carries no id, so its sentence is
classified `ungrounded`; with more than one, the first group is the id.

The kit never uses your `RegExp` directly. Every call scans with a private
copy that is always global and never sticky, so `g`, `y`, `gy` and no flags
find the same markers, other flags (`i`, `u`, ...) are kept, and your object's
`lastIndex` and flags are never touched. Reusing the same `RegExp` elsewhere
(including with `.test()`) is safe.

A marker match of zero characters (for example `/()/g`, or a lookahead such as
`/(?=(a))/g`) throws `GroundingConfigError` as soon as one is found, instead
of looping. A pattern that can match nothing but never does on your text is
not an error.

The default placeholder pattern allows up to 200 characters of note before
the closing bracket (`[more research needed: ...]`). A longer note is not
recognized as a placeholder, so that sentence is classified by its citations
instead. If you need longer notes, pass your own `placeholderPattern`.

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

All three throw a `TypeError` for a non-string first argument or a
`markerPattern` that is not a `RegExp`, and `GroundingConfigError` for a
zero-length marker match.

### Errors

`GroundingConfigError` (exported) extends `TypeError` and has
`name === "GroundingConfigError"`. It means the calling code or its
configuration is wrong (a zero-length marker match, or a `supports` that
returned a non-boolean), never that the text has a problem. Plain `TypeError`
covers wrong argument types: a non-string text, a `config`, `abbreviations`
or `evidenceMap` that is not a plain object, abbreviation lists that are not
dense arrays of strings, a pattern that is not a `RegExp`, and a `supports`
that is not a function.

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
- **A clean result can still hide unresolved work.** `isClean` ignores
  placeholders and is `true` when nothing was checkable. It says the structure
  held together, not that the text is complete or ready to publish.
- **Only what it scans is protected.** The kit cannot see a citation that is
  not written as a marker your `markerPattern` matches, and it does not decide
  whether the evidence text itself is true.
- **Evidence granularity is on you.** `evidenceMap` values can be a whole
  document or a single sentence-length span; the tighter the span, the more
  meaningful both the default overlap check and any injected `supports()`
  function will be.

## Relationship to sibling kits

[`provenance-kit`](https://github.com/lkopietz3-byte/provenance-kit) labels
claims as verified, modeled or editorial and checks that the public wording
does not claim more certainty than the label allows. It never looks at
evidence, and `grounding-kit` does not read its labels, so the two share no
code and no data. A pipeline could run `grounding-kit` first (is this sentence
backed by a citation into the evidence map) and `provenance-kit` second (does
its wording match its tier).
[`corroboration-kit`](https://github.com/lkopietz3-byte/corroboration-kit)
applies fixed rules to signals you have already collected and labeled, and
returns a verdict bounded by the coverage you report. It trusts your labels
and is not independent verification. Use `grounding-kit` to find which
sentences claim support, then `corroboration-kit` if you want its rules
applied to the signals you gathered for a claim.

## Development

```bash
npm ci
npm run test        # vitest
npm run typecheck    # tsc --noEmit, strict
npm run build         # emit dist/ (ESM + .d.ts)
npm run verify        # lint, typecheck, test, build, installed-package probes
```

## License

MIT

# grounding-kit

**[Try it in your browser →](https://lkopietz3-byte.github.io/honesty-kits/#grounding-kit)** · Part of [honesty kits](https://github.com/lkopietz3-byte/honesty-kits), a family of small checks for the claims an AI product makes.

Deterministic, zero-runtime-dependency citation-grounding checker for
AI-generated text. Splits generated text into sentences and classifies each
one as `grounded`, `placeholder`, `ungrounded`, or `invalid` against a map of
the evidence you actually gave the model, so you can catch an uncited claim,
an honest "no source" gap, or a citation that points at nothing (or at
evidence that doesn't back the sentence) before it ships to a user.

No LLM calls, no network access, no embeddings required to run (though you
can plug one in). Pure string/regex logic, framework-agnostic, works in any
JS/TS runtime.

## Why this exists

If your product generates text with inline citations (a summarizer, a
report drafter, a RAG answer engine, anything that emits `"claim [[cite:e1]]"`),
you have two independent failure modes to catch before the text ships:

1. **The claim is unsupported.** No citation at all, or an honest
   `[citation needed]`-style placeholder standing in for one.
2. **The citation doesn't hold up.** A marker is present and *looks* like
   grounding, but it points at an id that doesn't exist (a citation to
   nothing), or at evidence that doesn't say what the sentence claims. This
   is worse than an unsupported claim, because it reads as authoritative.

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
// chunks, a database row, a user-supplied source): the closed world of
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

console.log(result.isClean); // false: block export, flag for review

for (const s of result.sentences) {
  console.log(s.status.padEnd(11), "-", s.sentence);
}
// grounded    - Battery life reached 14 hours in independent lab testing [[cite:e1]].
// ungrounded  - Some reviewers claim the app drains battery overnight.
// invalid     - The warranty covers accidental damage for five years [[cite:e2]].
//               (e2 is about the return window, not damage coverage)
// placeholder - We could not verify the exact refund processing time [citation needed].

console.log(result.sentences[2].reasons);
// { e2: "not-supported" }: the id exists, but its text didn't pass supports()
```

## API

### `splitSentences(text, config?) => string[]`

Splits text into sentence-level (technically clause-level, see below)
grounding units, keeping each citation marker attached to the unit it
actually grounds. Hardened against:

- **Abbreviation periods that don't end a sentence.** "Dr. Alvarez reviewed
  the unit." stays one sentence, via a configurable list (see
  "Abbreviations" below).
- **Non-ASCII sentence terminators**: `。` `．` `！` `？` (which also end a
  sentence with no space after them), and `…` `‼` `⁇` `⁈` `⁉` `।` `॥` `؟`
  `۔` (which need a space after them, like `.`).
- **A marker glued to adjacent text with no whitespace**:
  `"...reviewed.[[cite:e1]]The next..."` is normalized before splitting so it
  can't fuse two sentences into one.
- **Leading-marker peeling.** A marker sitting right after a sentence's
  terminal period is attached to *that* sentence, not read as grounding the
  sentence that follows. This is the core defense against citation
  laundering: without it, `"Real claim. [[cite:e1]] Fabricated claim."` would
  let the fabricated sentence ride the real citation. The same holds when the
  period is followed by a closing quote, parenthesis, bracket, bold marker or
  footnote sign (`."`, `.)`, `.**`, `.”`, `.¹`), and when the word before the
  period is an abbreviation or a single letter (`Acme Inc. [[cite:e1]]
  Prices doubled.`): the period ends the sentence unless the text after the
  marker continues in lower case. A placeholder after the period
  (`2020. [citation needed] Tickets sold out.`) is peeled the same way, so it
  marks the sentence before it, not the one after.
- **Clause-level splitting** on `;`, the em dash (`—`), and, when the clause
  before it already carries a citation, a colon or a dash separator (`–`,
  `―`, `--`, or a hyphen with a space on each side). An uncited clause can't
  hide behind a citation elsewhere in the same sentence. Commas are
  deliberately *not* split: one citation legitimately covers a comma-joined
  sentence. A `;` or `:` inside matched brackets or parentheses, the `;` of an
  HTML entity (`&amp;`), a URL's `://`, a time (`9:30`) and a numeric range
  (`2020–2025`) are never clause breaks.
- **Fail-closed bracket matching.** An unbalanced `[` or `(` never suppresses
  a later clause split. Erring toward more (smaller) units is always safe: it
  can only ask for more grounding, never launder a claim past the checker.
- **Invisible characters.** A zero-width space, bidi control, soft hyphen or
  other default-ignorable character placed right after a terminator, or in
  front of a marker, cannot hide a sentence boundary. A unit made only of
  whitespace and invisible characters is dropped instead of being returned as
  an "uncited claim".
- **Line breaks.** `\n`, `\r\n`, a lone `\r`, U+2028 and U+2029 all end a
  line.

With the default `markdown: true`, it also reads markdown and plain-text
layout the way a reader does (see "Markdown and layout" below): scaffolding
such as headings and table separators is not returned as a claim, a list
numeral stays with the item it labels, and a hard-wrapped line that
continues a sentence is joined to it.

Besides whitespace, `splitSentences` drops only: blank units, the clause
separator itself at an accepted boundary, a marker with nothing before it
anywhere in the document, and markdown scaffolding (see ENGINEERING.md).

Work is linear in the length of `text` for the default patterns, including
deeply nested brackets, long runs of markers, and unclosed `[TK` runs. A
pattern you supply can still be slow if its own regex backtracks badly.
Throws a `TypeError` for a non-string `text`, a `config` that is not a plain
object or has an unknown key, or an option of the wrong type (see "Errors"
below).

```ts
import { splitSentences } from "grounding-kit";

splitSentences("Dr. Alvarez reviewed the unit. It shipped the next day.");
// ["Dr. Alvarez reviewed the unit.", "It shipped the next day."]

splitSentences("1. The battery lasts 14 hours.\n2. The warranty is one year.");
// ["1. The battery lasts 14 hours.", "2. The warranty is one year."]
```

#### Abbreviations

A period after a word in `abbreviations.alwaysFuse` never ends a sentence
(titles such as `Dr.`, `Gov.`, `Mt.`, and `e.g.`, `i.e.`), except when a
citation marker or placeholder follows it and the text after that does not
continue in lower case. A period
after a word in `abbreviations.contextFuse` ends the sentence when the next
text starts with a capital letter, and not otherwise (`Corp. filed the
report` is one sentence, `Corp. The filing...` is two). A few known
`contextFuse` words also continue before a capital in a narrow context:

| Word | Continues before a capital when the next word is | Example |
| --- | --- | --- |
| `a.m.`, `p.m.` | a time zone (`ET`, `PT`, `UTC`, `Eastern`, ...) | `9 a.m. Eastern` |
| `U.S.`, `U.K.`, `E.U.` | not a common sentence opener (`The`, `It`, `We`, ...) | `the U.S. Department of Energy` |
| `Inc.`, `Co.`, `Corp.`, `Ltd.`, `LLC`, `PLC` | a title (`CEO`, `Chief`, `President`, ...) | `Acme Inc. CEO Dana Lee` |
| any word except `no` | (the abbreviation is the first word of its sentence) | `Sr. García reviewed it.` |

`am`, `pm` and `us` count as abbreviations only when written with an inner
period (`a.m.`, `U.S.`), so `I am. Then...` and `Ask us. 24 hours later...`
end where they should. A camel-case word (`iPhone`, `eBay`) counts as a
capital.

A single letter before a period is read as a name initial (`Dana M.
Whitfield`, `J. R. R. Tolkien`) when it is a capital that follows a
capitalized name word or another initial and is followed by a capitalized
word that is not a sentence opener, and as a reference when a lower-case
letter is followed by a number (`p. 4`). Otherwise it ends the sentence
(`plan B. Prices doubled.`, `vitamin D. studies...`).

The defaults are small and English-oriented:

```ts
import { DEFAULT_ABBREVIATIONS } from "grounding-kit";
// alwaysFuse: mr mrs ms dr prof hon st v vs gov sen mt lt sgt capt rev messrs eg ie cf viz
// contextFuse: no inc co corp ltd llc plc dept vol ed al etc approx est ca fig p pp jr sr
//              phd md jan feb mar apr jun jul aug sep sept oct nov dec am pm us uk eu
```

Your own lists replace the defaults entirely (they don't merge), so you
always know exactly what's active. Entries are compared without case and
without dots, so `"Dr."`, `"dr"` and `"D.R."` are the same entry. An entry
must be letters of a cased script (Latin, Greek, Cyrillic, ...); anything
else (a digit, a space) could never match a word and throws a `TypeError`.

```ts
// A Spanish-language override: here "Sr." and "Sra." are titles (señor,
// señora) that always precede a name, so they go in alwaysFuse. In the
// English defaults, "Sr." is a name suffix ("John Smith Sr.") and sits in
// contextFuse instead.
splitSentences(text, {
  abbreviations: {
    alwaysFuse: ["dr", "sra", "sr"],
    contextFuse: ["etc", "no", "vol"],
  },
});
```

#### Markdown and layout

With `markdown: true` (the default):

- These lines are **not claims** and are not returned: a heading (`#` to
  `######`) that doesn't end like a statement, a horizontal rule (`---`,
  `***`, `___`), a table separator row (`|---|:---:|`) and the header row
  above it, a short emphasized label on its own line (`**Summary**`,
  `**Battery:**`, `*Note*`, up to six words), a lead-in line that ends in a
  colon right before a list, table or code block (`Here is what the policy
  says:`, up to ten words), and a fenced code block (an unclosed fence hides
  nothing after it).
- Any of those is **still a claim** when it carries a citation marker or a
  placeholder, or ends like a statement (`.`, `!`, `。`, ...; a question mark
  doesn't count): `## Prices doubled in 2025.` is checked.
- A list numeral or label (`1.`, `2)`, `IV.`, `B.`, `Step 3.`) stays with the
  item it labels instead of becoming a phantom uncited sentence.
- A table data row is a claim, one unit per row.
- A line that continues the sentence of the line before it is joined to it:
  when it starts in lower case, or the line before ends with a comma or a
  word such as `the`, `of`, `and` or `is`. A capitalized line after a line
  with no end punctuation is not joined (`Prices doubled last spring` +
  newline + `The battery lasts 14 hours [[cite:e1]].` stays two units).

`classifyDocument` lists what it set aside in `nonClaims`, so you can review
it. Pass `markdown: false` to treat every line as plain text, as in 0.2.1:
nothing is set aside and wrapped lines are not joined.

### `classifySentence(sentence, evidenceMap, config?) => SentenceClassification`

```ts
interface SentenceClassification {
  sentence: string;
  status: "grounded" | "placeholder" | "ungrounded" | "invalid";
  citedIds: string[];   // every marker id cited, including bad ones
  validIds: string[];   // cited ids that exist in evidenceMap AND were accepted
  reasons: Record<string, CitationReason>; // why, per distinct cited id
}

type CitationReason =
  | "supported"         // accepted by supports()
  | "no-content-words"  // default matcher only: nothing to compare ("Yes [[cite:e1]].")
  | "not-supported"     // supports() said no: a lead for review
  | "invalid-evidence"  // the id maps to a non-string value
  | "unknown-id";       // the id is not in evidenceMap: a citation to nothing
```

Classification rule, in precedence order (highest first):

1. **`invalid`**: the sentence cites at least one marker id that doesn't
   exist in `evidenceMap`, or whose evidence doesn't pass the `supports()`
   check for the text it is attached to (see below). A bad citation outranks
   everything else: even if the sentence also contains a placeholder, a bad
   cite can't hide behind an honest gap. `reasons` says which kind it was:
   `unknown-id` is a hard failure (the model cited something you never gave
   it), while `not-supported` from the default lexical matcher means "not
   enough word overlap", a lead for a human to review rather than proof of a
   forged citation.
2. **`placeholder`**: no invalid citation, and the sentence matches the
   placeholder pattern (default: `[citation needed]`, `[more research
   needed: ...]`, `[TK ...]`).
3. **`grounded`**: no invalid citation, no placeholder, and at least one
   citation marker, all of which are valid.
4. **`ungrounded`**: none of the above: a bare, uncited factual claim.

`reasons` is a null-prototype object keyed by id in first-appearance order;
when an id is cited more than once, its worst result is reported.

```ts
import { classifySentence } from "grounding-kit";

classifySentence(
  "The warranty covers accidental damage for five years [[cite:e2]].",
  { e2: "the product ships with a 90 day return window and a 1 year limited warranty" },
);
// { status: "invalid", citedIds: ["e2"], validIds: [], reasons: { e2: "not-supported" } }
// e2 exists, but its text doesn't support "covers accidental damage".
```

#### Sentences with several citations

Each citation is judged against the text it is attached to:

- With **one group** of citations (one marker, or several markers side by
  side with nothing but spaces or punctuation between them), every id in the
  group is judged against the whole sentence, as in 0.2.1.
- With **several groups**, each group covers its **span**: the text since
  the previous group (or the start of the sentence), and for the last group
  also any text after it. `X [[cite:e1]] and Y [[cite:e2]].` judges `e1`
  against `X` and `e2` against `and Y.`.
  - A span with three or more content words is judged on its own, so a
    citation can't vouch for a claim it sits next to but doesn't support.
  - A span with one or two content words (`According to the lab`, `and costs
    $1,299`) is accepted if either the whole sentence or the span passes.
  - A span with no content words (`and`) uses the whole sentence.
- The sentence is grounded only if every citation is accepted for its own
  text.
- With the default matcher, ids in one group may share the work: an id that
  doesn't pass on its own is accepted when the group's evidence together
  covers 60% of the text's content words and this id's evidence covers at
  least two of them. An unrelated id in the group still fails.

A "content word" is what the default matcher compares: a word longer than
three characters, or a two-character piece of an unspaced script (see
below).

### `classifyDocument(text, evidenceMap, config?) => DocumentClassification`

Runs `splitSentences` + `classifySentence` over a whole document.

```ts
interface DocumentClassification {
  sentences: SentenceClassification[];
  counts: Record<"grounded" | "placeholder" | "ungrounded" | "invalid", number>;
  citedEvidenceIds: string[]; // distinct ids validly cited anywhere in the document
  nonClaims: string[];        // markdown scaffolding that was set aside, unjudged
  isClean: boolean;           // true iff ungrounded === 0 && invalid === 0
}
```

`isClean` is the export gate: block shipping the text (or route it to human
review) until it's `true`. `placeholder` is not a failure. It's the honest
alternative to fabricating, and should be surfaced for a human to fill in,
not silently accepted or silently rejected.

`isClean` is a structural result, not a verdict. It is `true` for a document
whose only findings are placeholders (unresolved gaps), and also for a
document with no checkable sentences at all (empty text, whitespace, a lone
marker, or only markdown scaffolding). Check `counts.placeholder`,
`sentences.length` and `nonClaims` before you treat it as "done".

**Cost.** `supports` is called at most once per distinct (id, text) pair in a
sentence, so repeating an id next to the same text costs one call. The
default `supports` reads the text it is given, so a sentence costs about
the sum, over its citations, of the length of the text each is judged
against:

- citations spread through a sentence: each is judged against its own span,
  so the total is about the sentence length;
- citations side by side (one group): each id is judged against the whole
  sentence, so the cost is (distinct ids) x (sentence length).

Measured with the default `supports` on a developer laptop under heavy load
(numbers vary with the machine):

- a 154,000-character sentence with 1,000 different ids spread through it:
  about 0.1 s (0.2.1, which judged every id against the whole sentence, took
  7 to 20 s on the same input);
- a 340,000-character sentence that repeats one id 20,000 times, each after a
  word: about 0.1 s;
- about 1 MB of short cited sentences (15,600 sentences): about 0.2 to 0.3 s;
- the worst case, citations side by side at the end of one long sentence:
  200 different ids after 157,000 characters took about 5 s, and 1,000 ids
  after 168,000 characters about 15 s (0.2.1: about 19 s).

Text made of many short cited sentences grows about linearly with its
length (a scaling test covers this). A slow `supports` (an embedding or model
call) multiplies the number of calls by its own latency. The "linear" claim
under `splitSentences` covers splitting only, not classification.

`config` and `evidenceMap` are read once per call: the same patterns,
`supports` function and evidence values apply to every sentence, even if you
pass getters or a Proxy. `evidenceMap` must be a plain object or a
null-prototype object; a `Map`, `Set`, `Date`, array or class instance throws
a `TypeError` instead of being read as an empty map. An id that maps to a
value that is not a string is classified `invalid` with the reason
`invalid-evidence`.

### Configuring the `supports()` check

```ts
type SupportsFn = (sentenceText: string, evidenceText: string) => boolean;
```

`classifySentence`/`classifyDocument` accept `config.supports` to decide
whether a piece of evidence actually backs a claim. `sentenceText` is the
marker-free text the citation is judged against: the whole sentence, or its
span (see "Sentences with several citations").

The **default** (`defaultSupports`) is intentionally naive lexical matching,
not semantic entailment. Both sides are normalized (Unicode NFC, lower case,
markdown link targets and bare URLs removed, punctuation turned into spaces;
letters keep their combining marks, so Hindi vowel signs and Arabic
diacritics stay part of the word). Then it returns `true` when:

- the claim appears in the evidence as whole words, or
- the evidence appears in the claim as whole words and is at least 12
  characters and 60% of the claim's length (a short evidence string such as
  `"Acme"` no longer supports any sentence that mentions it), or
- at least 60% of the claim's content words also appear in the evidence.
  Content words are words longer than three characters; when a claim has
  none, its numbers are compared instead (`Tax is 5%`). Text in a script
  written without spaces (Chinese, Japanese, Thai, Lao, Khmer, Burmese) is
  compared by overlapping two-character pieces instead of words.

A claim with no content words at all (`"Yes."`) returns `false` from
`defaultSupports`; when classifying with the default, such a citation is
accepted unchecked with the reason `no-content-words`, because there is
nothing to compare. It's good enough to catch an obviously wrong or missing
citation and to run in CI with zero cost or latency; see **Limits** below for
what it can't do.

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

`supports` is called once per distinct (id, text) pair within a sentence (a
repeat reuses the first answer), so don't count on the number of calls.

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

With the default pattern, a marker id is one or more of `a-z`, `A-Z`, `0-9`,
`_` and `-`, with optional spaces inside the brackets (`[[cite: e1 ]]`).
Anything else (`[[cite:e1,e2]]`, `[[cite:e.1]]`) is not a marker: it stays
in the text as prose and grounds nothing, so the sentence reads as uncited.

`markerPattern` must contain exactly one capture group (the marker id) and
must match at least one character. The kit does not count the groups: with no
group a marker is still recognized but carries no id, so its sentence is
classified `ungrounded`; with more than one, the first group is the id.

The kit never uses your `RegExp` directly. Every call scans with private
copies, so `g`, `y`, `gy` and no flags find the same markers, other flags
(`i`, `u`, ...) are kept, and your object's `lastIndex` and flags are never
touched. Reusing the same `RegExp` elsewhere (including with `.test()`) is
safe.

A marker match of zero characters (for example `/()/g`, or a lookahead such as
`/(?=(a))/g`) throws `GroundingConfigError` as soon as one is found, instead
of looping. A pattern that can match nothing but never does on your text is
not an error. A placeholder pattern that matches zero characters is not an
error either; its empty matches are ignored.

The default placeholder pattern needs a word boundary after its keyword, so
`[TK]`, `[TK: Q3 numbers]` and `[citation needed]` are placeholders, while
`[Tkachenko 2019]`, `[TKO Group](...)` and `[tkinter docs]` are not. It
allows up to 200 characters of note before the closing bracket. A longer
note is not recognized as a placeholder, so that sentence is classified by
its citations instead. If you need longer notes, pass your own
`placeholderPattern`.

**Note on bracket protection:** the fail-closed clause splitter treats any
matched `[ ... ]` or `( ... )` span as unsplittable (so a `;` inside a marker,
placeholder or aside is never mistaken for a clause boundary), and
additionally shields whatever `markerPattern`/`placeholderPattern` match
directly even if they use a different delimiter (`{{ref:1}}`, `<cite
id="1">`, etc.). If your convention doesn't use brackets at all, the second
mechanism still covers it.

### Utilities

- `extractCitedIds(sentence, markerPattern?) => string[]`: every marker id
  in a sentence, in order, duplicates kept.
- `extractAllCitedIds(text, markerPattern?) => string[]`: distinct marker
  ids anywhere in a document, first-appearance order.
- `stripCitationMarkers(text, markerPattern?) => string`: remove markers for
  display/export. Only the text at each marker site changes. A marker (or a
  run of markers separated by spaces) is removed with the spaces and tabs
  around it and replaced by one space when there was space on either side or
  it sat between two letters or digits (`word[[cite:e1]]word` becomes `word
  word`), or by nothing before punctuation, a line break or the end of the
  text (`reach [[cite:e1]].` becomes `reach.`). Spacing elsewhere is left
  exactly as given.

All three throw a `TypeError` for a non-string first argument or a
`markerPattern` that is not a `RegExp`, and `GroundingConfigError` for a
zero-length marker match.

### Errors

`GroundingConfigError` (exported) extends `TypeError` and has
`name === "GroundingConfigError"`. It means the calling code or its
configuration is wrong (a zero-length marker match, or a `supports` that
returned a non-boolean), never that the text has a problem. Plain `TypeError`
covers wrong argument types: a non-string text; a `config`, `abbreviations`
or `evidenceMap` that is not a plain object; an unknown key in `config` or
`abbreviations` (so a typo such as `markerPatern` can't silently fall back to
the default; `supports` is accepted by `splitSentences` so one config object
can be shared); abbreviation lists that are not dense arrays of strings, or
an entry that is not letters and dots; a pattern that is not a `RegExp`; a
`markdown` option that is not a boolean; and a `supports` that is not a
function.

## Limits (read this before shipping on the default config)

- **`defaultSupports()` is naive lexical matching, not semantic
  entailment.** It will pass some claims that only coincidentally share words
  with their evidence, and it will fail some genuinely correct paraphrases.
  It has no stemming (`weighs` and `weight` differ), no synonyms (`price` and
  `costs` differ), and no notion of negation, numeric precision, or logical
  entailment: `"revenue grew 40%"` and `"revenue grew 4%"` share every
  content word and read as supporting each other. Its `not-supported` result
  is a lead for review, not proof of a forged citation. For anything
  higher-stakes than a fast first pass or a CI smoke test, replace it with an
  embedding-similarity or NLI-based `supports` function tuned on your domain.
- **This is a mechanical parser, not a truth checker.** It verifies that a
  citation marker points at evidence text that plausibly relates to the
  sentence, the same "does the shape hold together" contract a linter
  enforces on code. It cannot verify that the evidence itself is true, that
  the evidence was retrieved correctly, or that a "grounded" sentence hasn't
  subtly distorted what the evidence actually says (e.g. dropping a
  qualifier, reversing a comparison). Treat a `grounded` result as "passed
  the structural check," not "verified true."
- **Every sentence is treated as a claim.** A question, an instruction or
  conversational filler (`Great question!`, `Hope this helps!`) counts as an
  uncited sentence. Strip those before checking, or review them.
- **The sentence splitter is a heuristic, not a full NLP pipeline.** The
  default abbreviation list is small and English-oriented. Known misses:
  an initial after a lower-case word splits (`according to J. Smith`);
  `no.` before a number is read as "number" (`The answer is no. 3 people
  disagreed.` is one sentence); `U.S.` before a capitalized word that is not
  a common sentence opener is read as continuing (`in the U.S. Prices
  rose.` is one sentence, judged as a whole); a capitalized line after a
  wrapped line with no end punctuation is not joined. When in doubt it fails
  toward *more* (smaller) units, which is the safe direction for a grounding
  checker but can over-split unusual prose.
- **Markdown scaffolding is not checked.** A heading, short bold label,
  table header or lead-in line that doesn't end like a statement and carries
  no marker is set aside even if it makes a claim (`## Prices doubled in
  2025`). They are listed in `nonClaims`; pass `markdown: false` if your
  headings carry claims that must be cited.
- **Unspaced scripts are compared by character pairs.** That catches
  unrelated evidence and accepts close paraphrases, but a changed number
  written in characters (`二十` vs `十四`) can still pass, as it can in
  English.
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

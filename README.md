# grounding-kit

**[Try it in your browser →](https://lkopietz3-byte.github.io/honesty-kits/#grounding-kit)** · Part of [honesty kits](https://github.com/lkopietz3-byte/honesty-kits), a family of small checks for the claims an AI product makes.

A structural citation gate for AI answers that carry inline citation ids.
Give it the answer text and the evidence you gave the model (a map from id to
text), and it reports, sentence by sentence, which claims are uncited, which
cite an id you never provided, and which cite evidence that does not line up
with the sentence. No model calls, no network access, zero runtime
dependencies; same input, same output.

**Who it is for:** teams whose generator already writes inline markers such
as `[[cite:e1]]` (RAG answer engines, report drafters, summarizers) and want a
free, fast check in CI or before an answer ships.

**The job it does well:** the structural checks. In a field trial on real
source-and-summary pairs, every planted uncited sentence, unknown id and
wrong-chunk citation was caught, and an uncited sentence cannot ride a
neighbor's citation (after a period, a closing quote, an abbreviation, a dash
or a semicolon).

**What it does not do:** decide whether a sentence is true to its source. The
built-in `supports()` check is lexical word overlap. In the same trial it
flagged about 4 in 10 honest paraphrases and passed about 4 in 10 one-word
content edits (a changed number, an inserted "not"). Plug in your own
`supports()` (an embedding, NLI or number-aware check) for the semantic step,
and treat the default `not-supported` verdict as a review flag for
paraphrase-heavy output; see "Recipes" below.

## How it works

The generator writes a marker after each claim it can back, or a placeholder
such as `[citation needed]` where it cannot. grounding-kit splits the answer
into sentence-level units, keeps each marker on the unit it belongs to, and
classifies every unit:

1. **`ungrounded`**: no citation at all.
2. **`placeholder`**: an honest "no source" gap.
3. **`invalid`**: a citation to an id that is not in your evidence map (a
   hard failure), or to evidence that the `supports()` check does not accept
   for that sentence (with the default matcher, a lead for review).
4. **`grounded`**: every citation exists and was accepted.

An LLM judge can weigh meaning but costs a model call per check. This library
does the narrower, mechanical part for free and runs first; run a semantic
check after it if your stakes justify both. It never decides whether the
evidence itself is true, and it does not look anything up (see
[CiteCheck, arXiv 2605.27700](https://arxiv.org/abs/2605.27700) for checking
that cited works exist).

For best results, prompt the generator to put one claim per sentence and a
marker after every claim (each clause after a `;` or a dash needs its own),
and pass evidence as tight, chunk-level spans: whole-document evidence lets
more wrong citations through.

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

## Recipes

### A number-aware `supports()`

The default matcher ignores short words and numbers, so `300 metres` reads
as supported by evidence that says `330 metres`. A few lines fix numbers on
top of it:

```ts
import { classifyDocument, defaultSupports, type SupportsFn } from "grounding-kit";

const numbersIn = (text: string) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

// Every number in the claim must appear in the evidence, and the default
// word-overlap check must still pass.
const numberAware: SupportsFn = (claim, evidence) => {
  const available = new Set(numbersIn(evidence));
  return numbersIn(claim).every((n) => available.has(n)) && defaultSupports(claim, evidence);
};

classifyDocument(answer, evidence, { supports: numberAware });
```

An embedding or NLI check plugs in the same way. `supports()` must be
synchronous; if your judge is async, run it first and look the answers up.

### Default verdicts as review flags, not hard blocks

For paraphrase-heavy output, block only on the structural failures and send
lexical misses to a person:

```ts
import { classifyDocument } from "grounding-kit";

const result = classifyDocument(answer, evidence);
const hard = (s: (typeof result.sentences)[number]) =>
  s.status === "ungrounded" ||
  Object.values(s.reasons).some((r) => r === "unknown-id" || r === "invalid-evidence");

const blocked = result.sentences.filter(hard);
const toReview = result.sentences.filter((s) => s.status === "invalid" && !hard(s));

if (blocked.length > 0) {
  // uncited claim or a citation to nothing: regenerate or strip it
} else if (toReview.length > 0) {
  // only "not-supported" or "no-content-words": queue for a reviewer
} else {
  // clean (check result.counts.placeholder for open gaps)
}
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
  sentence with no space after them, including after closing brackets or
  quotes such as `。」次の文`), and `…` `‼` `⁇` `⁈` `⁉` `।` `॥` `؟` `۔`
  (which need a space after them, like `.`). Any terminator followed by a
  closing quote or bracket also ends the sentence directly before a capital
  letter, with no space (`..."Prices doubled.`).
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
  hide behind a citation elsewhere in the same sentence, including inside
  parentheses (`claim (waterproof; doctor approved) [[cite:e1]]` splits at
  the `;`). Commas are deliberately *not* split: one citation legitimately
  covers a comma-joined sentence. A separator inside matched square brackets
  (such as a marker or placeholder), the `;` of an HTML entity (`&amp;`, read
  as the `&` it stands for), a URL's `://`, a time (`9:30`) and a numeric
  range (`2020–2025`) are never clause breaks.
- **Fail-closed bracket matching.** An unbalanced `[` never suppresses a
  later clause split. Erring toward more (smaller) units is always safe: it
  can only ask for more grounding, never launder a claim past the checker.
- **Invisible characters.** A zero-width space, bidi control, soft hyphen or
  other default-ignorable character placed right after a terminator, or in
  front of a marker, cannot hide a sentence boundary. A unit made only of
  whitespace and invisible characters is dropped instead of being returned as
  an "uncited claim".
- **Lines.** A line ends at `\n` (`\r\n` works too). A lone `\r`, U+2028
  and U+2029 end a line only with `markdown: true`; by default they do not,
  as in 0.2.1, because splitting there can turn an honest document 0.2.1
  passed into a failing one.

Lines that hold no claim are set aside instead of becoming phantom "uncited
claims": a horizontal rule (`---`, `***`, `___`), a table separator row
(`|---|:---:|`), a bare fence line (` ``` `) and a lone list numeral
(`1.`, `2)`, `IV.`). A list numeral or label that starts a sentence
(`1. The battery...`, `Step 3. Plug it in.`) stays with that sentence. The
opt-in `markdown: true` mode sets more aside; see "Markdown and layout".

Text with no letter or digit left after a marker (the `.` in
`...Insurance Co. [[cite:e1]].`) stays with the sentence the marker belongs
to instead of becoming a unit of its own.

Besides whitespace, `splitSentences` drops only: blank units, the clause
separator itself at an accepted boundary, a marker with nothing before it
anywhere in the document (and punctuation right after it), and the
scaffolding lines above (see ENGINEERING.md).

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

Every rule here that keeps two fragments together can also join an uncited
sentence to a cited one, so the defaults only join where 0.2.1 did, or in a
narrow context with clear evidence of one sentence.

A period after a word in `abbreviations.alwaysFuse` never ends a sentence
(titles such as `Dr.`, `Mr.`), except when a citation marker or placeholder
follows it and the text after that does not continue in lower case
(`...by Dr. [[cite:e1]] Prices doubled.` is two sentences). A period after a
word in `abbreviations.contextFuse` ends the sentence when the next text
starts with a capital letter, and not otherwise (`Corp. filed the report` is
one sentence, `Corp. The filing...` is two). A camel-case word (`iPhone`)
counts as a capital. The words added to the defaults after 0.2.1 join only
in a narrow context:

| Words | Join only when the next text is | Example |
| --- | --- | --- |
| `Gov.`, `Sen.`, `Mt.`, `Lt.`, `Sgt.`, `Capt.`, `Messrs.` | a capitalized word that is not a sentence opener, with the title written capitalized | `Gov. Rivera signed it.` |
| `Ph.D.`, `M.D.`, `U.K.`, `E.U.`, `plc`, `cf.`, `viz.` | lower case | `a Ph.D. in chemistry` |
| `est.`, `ca.` | lower case, or a number of 3 or more digits | `ca. 1900` |
| `Jan.` ... `Dec.`, `Sept.` | a day (1 to 31) followed by a year (with or without a comma), a terminator, `;`, `)` or the end; a comma without a year, `5,000`, `5.5`, `5%` and `5th` end the sentence | `Jan. 5, 2024` |
| `a.m.`, `p.m.` (also the 0.2.1 rule) | a time-zone code (`ET`, `PT`, `UTC`, ...) | `9 a.m. ET` |
| any word except `no` | anything not marker-led, when the abbreviation is the whole fragment | `Sr. García reviewed it.` |

`am`, `pm`, `us`, `uk` and `eu` count as abbreviations only when written with
inner periods (`a.m.`, `U.S.`, `U.K.`), so `I am. Then...`, `Ask us. 24 hours
later...` and `...in the UK. Acme...` end where they should.

A single letter before a period joins the next fragment, as in 0.2.1 (a name
initial: `Dana M. Whitfield`, `according to J. Smith`), unless there is
evidence of a sentence end: a marker follows (`room B. [[cite:e1]] Prices
doubled.`), the next text is lower case (`plan B. independent...`), the word
before is a label noun (`plan B.`, `Section A.`, `vitamin D.`), or the next
word is a sentence opener (`Plan B. The vendor agreed.`).

The defaults are small and English-oriented:

```ts
import { DEFAULT_ABBREVIATIONS } from "grounding-kit";
// alwaysFuse: mr mrs ms dr prof hon st v vs
// contextFuse: no inc co corp ltd llc dept vol ed al etc eg ie approx fig p pp jr sr am pm us
//              plc est ca cf viz phd md uk eu gov sen mt lt sgt capt messrs
//              jan feb mar apr jun jul aug sep sept oct nov dec
```

Your own lists replace the defaults entirely (they don't merge), so you
always know exactly what's active. The narrow-context rules in the table
above apply to those words whichever list they appear in. Entries are
compared without case and without dots, so `"Dr."`, `"dr"` and `"D.R."` are
the same entry. An entry must be letters of a cased script (Latin, Greek,
Cyrillic, ...); anything else (a digit, a space) could never match a word and
throws a `TypeError`.

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

By default every line is checked as text, except the claim-free scaffolding
lines listed above. Headings, bold labels and table header rows are claims:
a document with `## Battery` as a heading fails, as it did in 0.2.1, because
a heading can just as well say `## Battery lasts 40 hours`.

`markdown: true` is an **opt-in, more lenient** mode for honest markdown
reports. It also sets aside, and lists in `nonClaims`:

- a heading (`#` to `######`);
- a line that is one emphasized phrase of up to six words (`**Summary**`,
  `**Battery:**`, `*Note*`); a line like `**Battery:** lasts **40 hours**`
  is not one phrase and stays a claim;
- a lead-in line of up to ten words that ends in a colon right before a
  list, table or code block (`Here is what the policy says:`);
- a table's header row (its first row, right above the separator row);
- a fenced code block, from an opening fence to a closing fence of the same
  character and at least the same length (an unclosed fence hides nothing,
  inline code such as ` ```npm i``` ` at the start of a line is not a fence,
  and a block that carries a citation marker or placeholder is read as
  ordinary lines, so its citations are still judged).

Any of those is **still a claim** when it carries a citation marker or a
placeholder, or holds a statement: any sentence terminator inside it other
than one final question mark (`## The X3 is waterproof. Our verdict` and
`| Prices doubled last spring. |` are checked). It also joins a hard-wrapped
line to the line before it when it starts in lower case, or when the line
before ends with a comma or a word such as `the`, `of`, `and` or `is`.

The trade-off, measured on a 55-document laundering corpus and 25 honest
documents from the 2026-10-10 review: the default catches 52 of 55
laundering documents and passes 14 of 25 honest ones; `markdown: true`
passes 21 of 25 honest ones but catches only 34 of 55, because a claim
written as a heading, a short bold line, a table header, a lead-in or a
wrapped line (`## Acme X3 battery lasts 40 hours`, `**Price: $99**`) is not
checked. Use it only when your generator's headings and labels carry no
claims, and review `nonClaims`. `isClean` does not look at `nonClaims`.

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
  | "no-content-words"  // default matcher only: nothing to compare ("Yes [[cite:e1]]."); still invalid
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

Every citation is judged against the whole sentence, as in 0.2.1. In a
sentence with several groups of citations (a group is one marker, or markers
side by side with only spaces or punctuation between them), a citation is
also accepted when it fully backs its own **span**: the text since the
previous group (or the start of the sentence), plus, for the last group, any
text after it. With the default matcher, "fully" means the span has at least
one content word and every content word appears in that id's evidence, and
every number appears there as the same written value (sign, currency,
decimal and grouping separators, percent: `$99.18` is not `$18.99`, `15%` is
not `15`; digits of other scripts are compared as written), as must every
word holding a numeric character (`x1` is not `y1`, `m²` is not `m³`).
Numbers inside URLs and link targets are ignored on both sides. With a custom `supports`, it means the span has at least
three content words and `supports(span, evidence)` is true.

So the span rule can only add passes, never take one away from 0.2.1:

- `<evidence A, near verbatim> [[cite:a]], and <evidence B, near verbatim>
  [[cite:b]].` now passes, where 0.2.1 failed both ids. A short span counts
  too (`...330 metres tall [[cite:a]] and was completed in 1889
  [[cite:b]].`), but not with a number its evidence lacks (`1999`).
- `<claim A> [[cite:a]] and <claim B plus an uncited clause> [[cite:b]].`
  fails: the second span has words its evidence lacks, and the whole
  sentence is not supported either.
- A paraphrased span is judged on the whole sentence, as in 0.2.1, so two
  paraphrased claims with their own citations can still fail together.

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
  nonClaims: string[];        // scaffolding lines that were set aside, unjudged
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
marker, or only scaffolding). It does not look at `nonClaims`. Check
`counts.placeholder`, `sentences.length` and `nonClaims` before you treat it
as "done".

**Cost.** `supports` is called at most once per distinct (id, text) pair in a
sentence, so repeating an id next to the same text costs one call. With the
default `supports`, each judged text is normalized once per sentence and
each evidence value once per call, so a sentence costs about its own length
plus, per distinct cited id, the length of that id's evidence (and of its
span, when it has one). A custom `supports` is called with the whole
sentence for every distinct id, so its cost is up to (distinct ids) x (its
own cost on the sentence).

Measured with the default `supports` on a developer laptop under heavy load
(numbers vary with the machine):

- a 154,000-character sentence with 1,000 different ids spread through it:
  about 0.2 s (0.2.1: 7 to 20 s);
- a 168,000-character sentence ending in 1,000 different ids side by side:
  about 0.25 s (0.2.1: about 19 s);
- 16,000 different ids, each after one word, in one 437,000-character
  sentence: about 0.1 s (0.2.1: about 180 s);
- a 340,000-character sentence that repeats one id 20,000 times: about 0.2 s;
- about 1 MB of short cited sentences (15,600 sentences): about 0.3 s.

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
text the citation is judged against, with every marker and placeholder
removed (so a note such as `[citation needed: late fee amount]` is never read
as claim words): the whole sentence, or first its span (see "Sentences with
several citations").

The **default** (`defaultSupports`) is intentionally naive lexical matching,
not semantic entailment. Both sides are normalized (Unicode NFC, lower case,
markdown link targets and bare URLs removed, punctuation turned into spaces;
letters keep their combining marks, so Hindi vowel signs and Arabic
diacritics stay part of the word). Then it returns `true` when:

- the claim appears in the evidence as whole words, or
- the evidence appears in the claim as whole words, is at least 12
  characters with three content words, and covers 60% of the claim's content
  words (when classifying, other evidence cited side by side that the claim
  also contains counts toward that 60%). A short evidence string such as
  `"Acme"` or `"cat"` no longer supports a sentence that mentions it, and
  `<evidence> and <made-up claim>` no longer passes on containment alone, or
- at least 60% of the claim's content words also appear in the evidence.
  Content words are words longer than three characters. Text in a script
  written without spaces (Chinese, Japanese, Thai, Lao, Khmer, Burmese) is
  compared by overlapping two-character pieces, and every piece, plus any
  number written inside that text, must appear in the evidence, so an
  inserted negation (`不`) or a changed number fails. Close paraphrases in
  those scripts usually fail too, as they did in 0.2.1.

A claim with no content words at all (`Yes.`, `It's 99%.`) returns `false`.
When classifying with the default, such a citation is `invalid` with the
reason `no-content-words`, so you can tell it apart from a mismatch. It's
good enough to catch an obviously wrong or missing citation and to run in CI
with zero cost or latency; see **Limits** below for what it can't do.

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
must match at least one character. A marker or placeholder match may not
start or end with whitespace, because sentence edges are trimmed and that
would change what the match is: a pattern whose source visibly begins or ends
with whitespace (`/\{\{(\w+)\}\}\. /`, `/\s\[(\d+)\]/`, `/\[tbd\] ?/`) is
refused before any text is read, and any other match that turns out to start
or end with whitespace throws `GroundingConfigError` when it is found. A
negated class such as `[^\s]` at an edge is fine. A
marker pattern must also match the same text inside a sentence as in the
whole document (a lookbehind such as `/(?<= )\[(\d+)\]/` does not, because a
marker can start a sentence); if a marker would be lost or changed by
splitting, classification throws instead of judging the sentence without it. The kit does not count the groups: with no
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
matched `[ ... ]` span as unsplittable (so a `;` inside a marker or
placeholder is never mistaken for a clause boundary), and
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
configuration is wrong (a zero-length marker match, a marker or placeholder
pattern that can match with whitespace at an edge, a marker pattern that
matches differently once the text is split, or a `supports` that returned a
non-boolean), never that the text has a problem. Plain `TypeError`
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
  entailment in spaced scripts: `"revenue grew 40%"` and `"revenue grew 4%"`
  share every content word and read as supporting each other, and so do `are`
  and `are not` (short words are not compared). A claim of only short words
  and numbers (`It's 129 g`) cannot be checked and is `invalid`. Its
  `not-supported` result is a lead for review, not proof of a forged
  citation. For anything higher-stakes than a fast first pass or a CI smoke
  test, replace it with an embedding-similarity or NLI-based `supports`
  function tuned on your domain.
- **This is a mechanical parser, not a truth checker.** It verifies that a
  citation marker points at evidence text that plausibly relates to the
  sentence, the same "does the shape hold together" contract a linter
  enforces on code. It cannot verify that the evidence itself is true, that
  the evidence was retrieved correctly, or that a "grounded" sentence hasn't
  subtly distorted what the evidence actually says (e.g. dropping a
  qualifier, reversing a comparison). Treat a `grounded` result as "passed
  the structural check," not "verified true."
- **Every sentence is treated as a claim.** A heading, a bold label, a
  question, an instruction or conversational filler (`Great question!`, `Hope
  this helps!`) counts as an uncited sentence by default. Strip those before
  checking, review them, or use `markdown: true` (see its trade-off above).
- **A whole sentence can carry a 40% tail.** A citation judged against the
  whole sentence passes at 60% word overlap, so an uncited clause joined by a
  comma or `and` (`<supported claim> and doctors recommend it [[cite:e1]]`)
  can pass, as in 0.2.1. A citation next to a claim it does not support can
  also pass when it supports the whole sentence. Prefer one claim per
  sentence.
- **The sentence splitter is a heuristic, not a full NLP pipeline.** The
  default abbreviation list is small and English-oriented, and 0.2.1's joins
  are kept: a single capital letter before a period joins the next
  capitalized word (`We hired Agent K. Prices doubled.` is one sentence),
  and `no.` before a number is read as "number" (`The answer is no. 3 people
  disagreed.` is one sentence). Common abbreviations before a capital split
  mid-sentence (`the U.S. Department of Energy`, `e.g. Apple`), and so does a
  month before an ordinal day (`It shipped on Jan. 5th to stores.` is two
  units; write `Jan. 5, 2024` or `January 5th`), which fails safe. When in
  doubt it fails toward *more* (smaller) units.
- **`markdown: true` does not check scaffolding.** A heading, short bold
  line, table header, lead-in or wrapped line that holds no statement and
  carries no marker is set aside even if it makes a claim (`## Prices doubled
  in 2025`), and `isClean` ignores it. Review `nonClaims` when you use it.
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

import { GroundingConfigError } from "./errors.js";
import {
  markerSitesOf,
  readSplitterOptions,
  resolveSplitter,
  splitResolved,
  stripCitationsOf,
  type ResolvedSplitter,
  type SplitterConfig,
} from "./sentenceSplitter.js";
import { assertKnownKeys, assertPlainObject, assertString, describe } from "./validate.js";

/**
 * A sentence's grounding outcome, in precedence order (checked in this
 * order by `classifySentence`; the first match wins):
 * - `"invalid"` — cites a marker id that's missing from the evidence map, or
 *   whose evidence doesn't pass `supports()` for the text it is attached to.
 *   A citation to nothing is a hard failure; a `supports()` miss with the
 *   default lexical matcher is a lead for review, not proof of forgery. See
 *   `SentenceClassification.reasons` for which one it was.
 * - `"placeholder"` — no invalid citation, and the sentence matches the
 *   placeholder pattern (an honest "no source for this" gap).
 * - `"grounded"` — no invalid citation, no placeholder, and at least one
 *   citation, all valid.
 * - `"ungrounded"` — a bare, uncited claim: none of the above.
 */
export type SentenceStatus = "grounded" | "placeholder" | "ungrounded" | "invalid";

/**
 * Why one cited id was or was not accepted, worst occurrence first:
 * - `"unknown-id"` — the id is not an own key of `evidenceMap`. A citation to
 *   nothing: a hard failure.
 * - `"invalid-evidence"` — the id maps to something that is not a string.
 *   Treated like an unknown id; it is a bug in the evidence map.
 * - `"not-supported"` — `supports()` returned false for the text the id is
 *   attached to. With the default lexical matcher this means "not enough
 *   word overlap", a lead for review rather than proof of a forged citation.
 * - `"no-content-words"` — the default matcher had nothing to compare: the
 *   text has no word longer than three characters ("Yes [[cite:e1]].", "It's
 *   99% [[cite:e1]]."). Nothing shows the citation backs the text, so the id
 *   is not accepted, but this is a different finding from a mismatch. Only
 *   produced with the default `supports`.
 * - `"supported"` — accepted by `supports()`.
 */
export type CitationReason =
  | "supported"
  | "no-content-words"
  | "not-supported"
  | "invalid-evidence"
  | "unknown-id";

const REASON_RANK: Record<CitationReason, number> = {
  supported: 0,
  "no-content-words": 1,
  "not-supported": 2,
  "invalid-evidence": 3,
  "unknown-id": 4,
};

/**
 * Maps a citation marker id to the evidence text/span it claims to support.
 * This is the closed world: a marker whose id isn't a key here is a citation
 * to nothing, and one whose evidence doesn't pass `supports()` is flagged for
 * review.
 *
 * Lookups are by *own* property only: a marker id that happens to name an
 * inherited `Object.prototype` member (`"__proto__"`, `"constructor"`,
 * `"toString"`, `"hasOwnProperty"`, ...) is treated the same as a genuinely
 * missing id — reported as `invalid` — never resolved through the prototype
 * chain.
 */
export type EvidenceMap = Readonly<Record<string, string>>;

/**
 * Decides whether `evidenceText` plausibly supports `sentenceText`'s claim.
 * Injectable so callers can plug in something semantic (embedding
 * similarity, an NLI entailment model, a second LLM call) instead of the
 * naive default. See the README's "Limits" section before relying on the
 * default in anything higher-stakes than a demo.
 *
 * `sentenceText` is the marker-free text the citation is attached to: the
 * whole sentence when it has one group of citations, or the span before each
 * group when it has several (see the README section "Sentences with several
 * citations"). Within one sentence each distinct (id, text) pair is asked
 * once; a later sentence asks again. Don't rely on the number of calls.
 *
 * It must return a real boolean, synchronously. Any other return value (a
 * Promise from an `async` function, a truthy string, `undefined`, a number)
 * makes classification throw `GroundingConfigError`: the kit never awaits the
 * result and never guesses what a non-boolean was meant to say.
 */
export type SupportsFn = (sentenceText: string, evidenceText: string) => boolean;

// Scripts written without spaces between words. Their text is compared by
// overlapping character pairs instead of by words.
const UNSPACED_CHAR =
  "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}\\u30FC]";
const UNSPACED_RUN = new RegExp(`(?:${UNSPACED_CHAR}\\p{M}*)+`, "gu");
const HAS_UNSPACED = new RegExp(UNSPACED_CHAR, "u");
const HAS_DIGIT = /\p{N}/u;

// Drop markdown link targets ("[text](https://...)" keeps "text"), in one
// forward pass: a regex here retried the rest of the text from every "](" on
// input like "](](](...".
function dropLinkTargets(s: string): string {
  let out = "";
  let last = 0;
  let i = s.indexOf("](");
  while (i >= 0) {
    let j = i + 2;
    while (j < s.length && s[j] !== ")" && !/\s/u.test(s[j])) j++;
    if (s[j] === ")") {
      out += `${s.slice(last, i + 1)} `;
      last = j + 1;
      i = s.indexOf("](", last);
    } else {
      i = s.indexOf("](", j);
    }
  }
  return out + s.slice(last);
}

function normalizeForOverlap(s: string): string {
  return (
    dropLinkTargets(s.normalize("NFC").toLowerCase())
      // A bare URL is dropped: it is not a claim word.
      .replace(/\b(?:https?|ftp):\/\/\S+/g, " ")
      // Letters keep their combining marks (\p{M}): a Hindi vowel sign or an
      // Arabic diacritic is part of the word, not punctuation.
      .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

interface Token {
  text: string;
  significant: boolean;
  // Must appear in the evidence: every piece of an unspaced-script run, and
  // any number written inside such a run.
  required: boolean;
}

// Words, with any run of an unspaced script turned into overlapping
// two-character pieces ("電池持続" -> 電池, 池持, 持続). A word is
// significant when it is longer than three characters. Unspaced pieces, and
// numbers written inside unspaced text, are significant and required: every
// one must appear in the evidence, so a changed number or an inserted
// negation ("不") fails.
function tokenize(normalized: string): Token[] {
  const out: Token[] = [];
  if (normalized === "") return out;
  for (const word of normalized.split(" ")) {
    if (!HAS_UNSPACED.test(word)) {
      out.push({ text: word, significant: word.length > 3, required: false });
      continue;
    }
    const other = (text: string) => {
      const numeric = HAS_DIGIT.test(text);
      out.push({ text, significant: numeric || text.length > 3, required: numeric });
    };
    let last = 0;
    for (const m of word.matchAll(UNSPACED_RUN)) {
      if (m.index > last) other(word.slice(last, m.index));
      const chars = Array.from(m[0]);
      if (chars.length === 1) out.push({ text: chars[0], significant: true, required: true });
      for (let i = 0; i + 1 < chars.length; i++) {
        out.push({ text: chars[i] + chars[i + 1], significant: true, required: true });
      }
      last = m.index + m[0].length;
    }
    if (last < word.length) other(word.slice(last));
  }
  return out;
}

/** A claim normalized once, so it can be compared with many evidence texts. */
interface PreparedClaim {
  padded: string;
  length: number;
  significant: Set<string>;
  required: Set<string>;
  // Every number as written (sign, currency, digits with their separators,
  // percent); the span rule requires each one, as a whole value.
  numbers: Set<string>;
}

// A complete number read from the raw text, before normalization drops its
// punctuation: optional sign, optional currency symbol, digits with decimal or
// grouping separators, optional percent. "$99.18" and "$18.99" stay distinct.
const NUMBER = /[-+\u2212]?[$€£¥]?\d+(?:[.,]\d+)*%?/gu;

function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize("NFC").matchAll(NUMBER)) out.add(m[0].replace("\u2212", "-"));
  return out;
}

function prepareClaim(text: string): PreparedClaim {
  const normalized = normalizeForOverlap(text);
  const significant = new Set<string>();
  const required = new Set<string>();
  for (const t of tokenize(normalized)) {
    if (t.significant) significant.add(t.text);
    if (t.required) required.add(t.text);
  }
  return { padded: ` ${normalized} `, length: normalized.length, significant, required, numbers: numbersIn(text) };
}

/** Evidence normalized once per classification call. */
interface PreparedEvidence {
  padded: string;
  length: number;
  tokens: Set<string>;
  significantCount: number;
  numbers: Set<string>;
}

function prepareEvidence(text: string): PreparedEvidence {
  const normalized = normalizeForOverlap(text);
  const all = tokenize(normalized);
  return {
    padded: ` ${normalized} `,
    length: normalized.length,
    tokens: new Set(all.map((t) => t.text)),
    significantCount: new Set(all.filter((t) => t.significant).map((t) => t.text)).size,
    numbers: numbersIn(text),
  };
}

/** How many distinct words in `text` the default matcher would compare. */
function contentWordCount(text: string): number {
  return prepareClaim(text).significant.size;
}

// A span needs at least this many content words to be judged on its own;
// otherwise ("and", ", which") its citation is judged against the whole
// sentence only, as in 0.2.1.
const MIN_SPAN_WORDS = 1;
// A custom `supports` is asked about a span only from this many content words.
const MIN_CUSTOM_SPAN_WORDS = 3;

// The "claim contains the evidence" shortcut needs the evidence to be a
// whole-word phrase of at least 12 characters and three significant words, so
// a short evidence string ("Acme", "cat") cannot support a long fabricated
// sentence that merely mentions it.
const MIN_CONTAINED_EVIDENCE = 12;
const MIN_CONTAINED_WORDS = 3;
const OVERLAP_SHARE = 0.6;

// Whether `evidence` is long enough to count as contained in the claim, and is.
function containedIn(claim: PreparedClaim, evidence: PreparedEvidence): boolean {
  return (
    evidence.length >= MIN_CONTAINED_EVIDENCE &&
    evidence.significantCount >= MIN_CONTAINED_WORDS &&
    claim.padded.includes(evidence.padded)
  );
}

// The share of the claim's significant words that the given evidence texts
// cover together.
function coverage(claim: PreparedClaim, evidence: readonly PreparedEvidence[]): number {
  if (claim.significant.size === 0) return 0;
  let covered = 0;
  for (const w of claim.significant) if (evidence.some((e) => e.tokens.has(w))) covered++;
  return covered / claim.significant.size;
}

// `group` is the evidence of every id cited side by side with this one. The
// "claim contains the evidence" shortcut holds only when the evidence texts
// the claim contains cover 60% of its words together, so "<evidence> and
// <fabricated claim>" does not pass, while "<evidence A> and <evidence B>
// [[cite:a]][[cite:b]]" does.
/**
 * The part of the default verdict that depends only on the claim and one
 * evidence text: whether it passes by itself (the claim appears in the
 * evidence, or 60% word overlap), and whether the evidence is contained in the
 * claim (which passes only with enough coverage, see `supportsPrepared`).
 */
interface WholeFacts {
  pass: boolean;
  contained: boolean;
}

function wholeFacts(claim: PreparedClaim, evidence: PreparedEvidence): WholeFacts {
  if (claim.length === 0 || evidence.length === 0) return { pass: false, contained: false };
  if (claim.length <= evidence.length && evidence.padded.includes(claim.padded)) {
    return { pass: true, contained: false };
  }
  const contained = containedIn(claim, evidence);
  if (claim.significant.size === 0) return { pass: false, contained };
  for (const w of claim.required) if (!evidence.tokens.has(w)) return { pass: false, contained };
  // Only the claim's significant words are looked up, so short evidence words never matter.
  let overlap = 0;
  for (const w of claim.significant) if (evidence.tokens.has(w)) overlap++;
  return { pass: overlap / claim.significant.size >= OVERLAP_SHARE, contained };
}

function supportsPrepared(
  claim: PreparedClaim,
  evidence: PreparedEvidence,
  containedShare: () => number = () => coverage(claim, [evidence]),
  facts: WholeFacts = wholeFacts(claim, evidence),
): boolean {
  if (facts.pass) return true;
  return facts.contained && containedShare() >= OVERLAP_SHARE;
}

/**
 * Default `supports()`: naive substring-or-word-overlap check, NOT semantic
 * entailment. Returns true if:
 * - the normalized claim appears in the normalized evidence as whole words, or
 * - the normalized evidence appears in the claim as whole words, is at least
 *   12 characters with three significant words, and covers 60% of the
 *   claim's significant words (when classifying, evidence cited side by side
 *   that the claim also contains counts toward that 60%), or
 * - at least 60% of the claim's significant words (longer than three
 *   characters) also appear in the evidence. Text in an unspaced script
 *   (Chinese, Japanese, Thai, ...) is compared by overlapping two-character
 *   pieces instead of words, and every piece (and any number written inside
 *   that text) must appear in the evidence.
 * A claim with no significant word returns false. This catches
 * paraphrase-free grounding and obvious mismatches; it will both miss real
 * paraphrases and pass some coincidental word overlap. Replace it for
 * anything that needs real semantic judgment.
 *
 * Normalization (both sides, before comparing): Unicode NFC, lowercased,
 * markdown link targets and bare URLs removed, punctuation collapsed to spaces
 * (any script's letters, combining marks and digits are kept), whitespace
 * collapsed. The NFC step means a claim and its evidence written with the
 * same accented text in different (both valid) Unicode forms still match.
 */
export const defaultSupports: SupportsFn = (sentenceText, evidenceText) =>
  supportsPrepared(prepareClaim(sentenceText), prepareEvidence(evidenceText));

/**
 * Options for `classifySentence`/`classifyDocument`: splitting config plus the
 * evidence-match function. Each option is read once per call, so a getter or
 * Proxy cannot answer differently for the second sentence of a document. An
 * unknown key throws a `TypeError`.
 */
export interface ClassifyConfig extends SplitterConfig {
  /** Replaces `defaultSupports`. Must return a real boolean; see `SupportsFn`. */
  supports?: SupportsFn;
}

/** Per-sentence result of `classifySentence`/`classifyDocument`. */
export interface SentenceClassification {
  /** The sentence (grounding unit) text, exactly as produced by `splitSentences`. */
  sentence: string;
  /** This sentence's grounding outcome; see `SentenceStatus` for the precedence rule. */
  status: SentenceStatus;
  /** Every marker id cited by this sentence, including unknown and unsupported ones. */
  citedIds: string[];
  /**
   * Cited ids that exist in the evidence map AND were accepted for the text
   * they are attached to, one entry per accepted citation.
   */
  validIds: string[];
  /**
   * Why each distinct cited id was accepted or not, keyed by id in
   * first-appearance order (worst occurrence wins). A null-prototype object,
   * so an id such as `"__proto__"` is an ordinary key. Empty for an uncited
   * sentence.
   */
  reasons: Record<string, CitationReason>;
}

interface ResolvedClassify {
  splitter: ResolvedSplitter;
  supports: SupportsFn;
}

const CLASSIFY_KEYS = ["abbreviations", "markerPattern", "placeholderPattern", "markdown", "supports"];

// Read every option once and validate it. `config` and `abbreviations` must be
// plain objects: a Map or class instance would read as "no options" and
// silently fall back to the defaults.
function resolveClassify(config: unknown): ResolvedClassify {
  assertPlainObject(config, "config");
  assertKnownKeys(config, CLASSIFY_KEYS, "config");
  const source = config;
  const supports = source.supports ?? defaultSupports;
  if (typeof supports !== "function") {
    throw new TypeError(`config.supports must be a function (got ${describe(supports)}).`);
  }
  return {
    splitter: resolveSplitter(readSplitterOptions(source)),
    supports: supports as SupportsFn,
  };
}

type Evidence = { kind: "text"; text: string } | { kind: "missing" } | { kind: "not-string" };

// Own-property lookup, read at most once per id per call. `evidenceMap` is a
// plain object, so a *prototype-chain* hit (marker id "__proto__",
// "constructor", "toString", ...) would otherwise resolve to Object.prototype's
// value for that name instead of `undefined` — handing `supports()` an object
// or function instead of a string and crashing it. `Object.hasOwn` plus a
// `typeof` guard treats any such id like a missing one: an invalid citation,
// never a thrown exception. A non-string value is also invalid, with its own
// reason. Caching means a getter on the map cannot return one value for the
// first citation of an id and another for the second.
function evidenceLookup(evidenceMap: EvidenceMap): (id: string) => Evidence {
  const cache = new Map<string, Evidence>();
  return (id) => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    let value: Evidence;
    if (!Object.hasOwn(evidenceMap, id)) value = { kind: "missing" };
    else {
      const raw: unknown = evidenceMap[id];
      value = typeof raw === "string" ? { kind: "text", text: raw } : { kind: "not-string" };
    }
    cache.set(id, value);
    return value;
  };
}

function callSupports(supports: SupportsFn, claimText: string, evidence: string): boolean {
  const result: unknown = supports(claimText, evidence);
  if (typeof result === "boolean") return result;
  // A rejected Promise that nobody awaits would crash the process with an
  // unhandled rejection on top of the error thrown here. Mark it handled; the
  // TypeError below is the report.
  if (result instanceof Promise) result.catch(() => undefined);
  throw new GroundingConfigError(
    `supports() must return a boolean (got ${result instanceof Promise ? "a Promise; supports() must be synchronous" : describe(result)}).`,
  );
}

/**
 * A run of citation markers with no letters or digits between them. `span`
 * is the text it is attached to, when the sentence has several groups and the
 * span has at least one content word; otherwise null.
 */
interface CitationGroup {
  ids: string[];
  span: string | null;
  // Content words in the span (0 when there is no span).
  spanWords: number;
}

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Group the sentence's markers and find the span each group is attached to:
// the text since the previous group (or the start), plus, for the last group,
// any text after it. A sentence with one group, or a span with no content
// word ("and", ", which"), has no span of its own: its citations are judged
// against the whole sentence only, as in 0.2.1.
function citationGroups(sentence: string, claimText: string, splitter: ResolvedSplitter): CitationGroup[] {
  const sites = markerSitesOf(sentence, splitter.marker);
  const groups: Array<{ ids: string[]; start: number; end: number }> = [];
  let previousEnd = -1;
  for (const site of sites) {
    const joined =
      groups.length > 0 && !HAS_LETTER_OR_DIGIT.test(sentence.slice(previousEnd, site.start));
    if (joined) groups[groups.length - 1].end = site.end;
    else groups.push({ ids: [], start: site.start, end: site.end });
    if (site.id !== undefined) groups[groups.length - 1].ids.push(site.id);
    previousEnd = site.end;
  }
  const withIds = groups.filter((g) => g.ids.length > 0);
  if (withIds.length <= 1) return withIds.map((g) => ({ ids: g.ids, span: null, spanWords: 0 }));
  return withIds.map((g, k) => {
    const from = k === 0 ? 0 : withIds[k - 1].end;
    const head = sentence.slice(from, g.start).trimEnd();
    const tail = k === withIds.length - 1 ? sentence.slice(g.end) : "";
    const glue = HAS_LETTER_OR_DIGIT.test(head.slice(-1)) && HAS_LETTER_OR_DIGIT.test(tail.slice(0, 1)) ? " " : "";
    const span = stripCitationsOf(head + glue + tail, splitter).trim();
    const words = span === claimText ? 0 : contentWordCount(span);
    return { ids: g.ids, span: words >= MIN_SPAN_WORDS ? span : null, spanWords: words };
  });
}

// Whether `evidence` backs every content word of `span`: the span appears in
// it as whole words, or every significant word, every required piece and
// every number of the span is in it. Used for the per-span rule, which may
// only add passes, so it demands full coverage (numbers included) instead of
// the 60% the whole-sentence check allows.
function fullyCovers(span: PreparedClaim, evidence: PreparedEvidence): boolean {
  if (span.significant.size < MIN_SPAN_WORDS) return false;
  // Numbers are compared as whole values first: whole-word containment of the
  // normalized text would read "$99.18" and "99 18" alike.
  for (const n of span.numbers) if (!evidence.numbers.has(n)) return false;
  if (span.length <= evidence.length && evidence.padded.includes(span.padded)) return true;
  for (const w of span.required) if (!evidence.tokens.has(w)) return false;
  for (const w of span.significant) if (!evidence.tokens.has(w)) return false;
  return true;
}

function classifyResolved(
  sentence: string,
  lookup: (id: string) => Evidence,
  { splitter, supports }: ResolvedClassify,
  preparedEvidence: Map<string, PreparedEvidence>,
): SentenceClassification {
  // Markers and placeholders are removed before judging: a placeholder's note
  // ("[citation needed: late fee amount]") is not a claim word.
  const claimText = stripCitationsOf(sentence, splitter).trim();
  const groups = citationGroups(sentence, claimText, splitter);
  const citedIds: string[] = [];
  for (const g of groups) for (const id of g.ids) citedIds.push(id);
  const usingDefault = supports === defaultSupports;

  // With the default matcher, the sentence (and each span) is normalized once
  // and each evidence value once per call, so many ids on one long sentence
  // cost about the sentence length plus the evidence lengths.
  let claim: PreparedClaim | undefined;
  const claimPrepared = (): PreparedClaim => (claim ??= prepareClaim(claimText));
  // Whole-sentence facts and the single-id coverage do not depend on the
  // group, so one id cited many times in separate groups is checked once.
  // Built only for sentences with more than one group.
  const factsById = groups.length > 1 ? new Map<string, WholeFacts>() : null;
  const ownShareById = groups.length > 1 ? new Map<string, number>() : null;
  const evidenceFor = (id: string, text: string): PreparedEvidence => {
    let ev = preparedEvidence.get(id);
    if (ev === undefined) {
      ev = prepareEvidence(text);
      preparedEvidence.set(id, ev);
    }
    return ev;
  };
  // A custom `supports` is asked once per distinct (id, text) pair in the
  // sentence. Keyed by text first, so a long text is hashed once.
  let answers: Map<string, Map<string, boolean>> | undefined;
  const askCustom = (id: string, text: string, evidence: string): boolean => {
    answers ??= new Map();
    let byId = answers.get(text);
    if (byId === undefined) {
      byId = new Map();
      answers.set(text, byId);
    }
    let answer = byId.get(id);
    if (answer === undefined) {
      answer = callSupports(supports, text, evidence);
      byId.set(id, answer);
    }
    return answer;
  };

  const reasons: Record<string, CitationReason> = Object.create(null) as Record<string, CitationReason>;
  const validIds: string[] = [];
  let hasInvalid = false;
  for (const group of groups) {
    // The default verdict depends on the evidence cited side by side, so it
    // is cached per group, not per sentence.
    const verdicts = group.ids.length > 1 ? new Map<string, CitationReason>() : null;
    let containedShare: number | undefined;
    let spanClaim: PreparedClaim | undefined;
    const groupContainedShare = (): number => {
      if (containedShare === undefined && new Set(group.ids).size === 1) {
        const only = group.ids[0];
        let share = ownShareById?.get(only);
        if (share === undefined) {
          const ev = lookup(only);
          share = ev.kind === "text" ? coverage(claimPrepared(), [evidenceFor(only, ev.text)]) : 0;
          ownShareById?.set(only, share);
        }
        containedShare = share;
      }
      if (containedShare === undefined) {
        const c = claimPrepared();
        const contained: PreparedEvidence[] = [];
        for (const gid of new Set(group.ids)) {
          const ev = lookup(gid);
          if (ev.kind === "text") {
            const prepared = evidenceFor(gid, ev.text);
            if (containedIn(c, prepared)) contained.push(prepared);
          }
        }
        containedShare = coverage(c, contained);
      }
      return containedShare;
    };
    const judge = (id: string): CitationReason => {
      const ev = lookup(id);
      if (ev.kind === "missing") return "unknown-id";
      if (ev.kind === "not-string") return "invalid-evidence";
      if (usingDefault) {
        const prepared = evidenceFor(id, ev.text);
        // A citation is accepted when it supports the whole sentence (the
        // 0.2.1 rule), or when it fully backs its own span, so the span rule
        // can only add passes.
        if (group.span !== null && fullyCovers((spanClaim ??= prepareClaim(group.span)), prepared)) {
          return "supported";
        }
        let facts = factsById?.get(id);
        if (facts === undefined) {
          facts = wholeFacts(claimPrepared(), prepared);
          factsById?.set(id, facts);
        }
        if (supportsPrepared(claimPrepared(), prepared, groupContainedShare, facts)) return "supported";
        // Text with nothing to compare cannot be checked. That is still a
        // failure, reported apart from a mismatch.
        return claimPrepared().significant.size === 0 ? "no-content-words" : "not-supported";
      }
      // A custom judge sees a span only when it has at least three content
      // words; shorter spans are too thin to judge on their own.
      if (group.span !== null && group.spanWords >= MIN_CUSTOM_SPAN_WORDS && askCustom(id, group.span, ev.text)) {
        return "supported";
      }
      return askCustom(id, claimText, ev.text) ? "supported" : "not-supported";
    };
    for (const id of group.ids) {
      let reason = verdicts?.get(id);
      if (reason === undefined) {
        reason = judge(id);
        verdicts?.set(id, reason);
      }
      if (reason === "supported") validIds.push(id);
      else hasInvalid = true;
      const prior = reasons[id];
      if (prior === undefined || REASON_RANK[reason] > REASON_RANK[prior]) reasons[id] = reason;
    }
  }

  const base = { sentence, citedIds, validIds, reasons };
  if (hasInvalid) return { ...base, status: "invalid" as const };

  splitter.placeholderTest.lastIndex = 0;
  if (splitter.placeholderTest.test(sentence)) return { ...base, status: "placeholder" as const };

  if (citedIds.length > 0) return { ...base, status: "grounded" as const };
  return { ...base, status: "ungrounded" as const };
}

/**
 * Classify a single sentence against `evidenceMap`. An unknown or
 * unsupported citation ("invalid") outranks a placeholder: a sentence that
 * cites a missing or non-supporting marker id surfaces as invalid even if it
 * also contains a placeholder gap, so a bad cite can never hide behind an
 * honest "I don't have a source."
 *
 * Status precedence: invalid > placeholder > grounded > ungrounded.
 *
 * Each citation is judged against the text it is attached to: the whole
 * sentence when the sentence has one group of adjacent markers, or the span
 * before each group when it has several. Every citation must be accepted for
 * the sentence to be grounded.
 *
 * Cost: `supports` runs once per distinct (id, span) pair. With the default
 * `supports` that is about (distinct ids) x (sentence length) for a sentence
 * whose citations sit together, and about the sentence length when they are
 * spread out.
 *
 * @throws {TypeError} if `sentence` is not a string, `evidenceMap` is not a
 *   plain (or null-prototype) object, or `config` has an unknown key or an
 *   option of the wrong type. Checked up front rather than left to fail
 *   inside the citation loop, where a bad `evidenceMap` would only crash for a
 *   sentence that actually cited something.
 * @throws {GroundingConfigError} if `markerPattern` matches zero characters,
 *   or `supports` returns anything but a boolean.
 */
export function classifySentence(
  sentence: string,
  evidenceMap: EvidenceMap,
  config: ClassifyConfig = {},
): SentenceClassification {
  assertString(sentence, "sentence");
  assertPlainObject(evidenceMap, "evidenceMap");
  return classifyResolved(sentence, evidenceLookup(evidenceMap), resolveClassify(config), new Map());
}

/** Whole-document result of `classifyDocument`. */
export interface DocumentClassification {
  /** Every sentence's classification, in document order. */
  sentences: SentenceClassification[];
  /** How many sentences landed in each status. */
  counts: Record<SentenceStatus, number>;
  /** Distinct evidence ids that were genuinely (validly) cited anywhere in the document. */
  citedEvidenceIds: string[];
  /**
   * Markdown scaffolding that was set aside without being judged (headings
   * that don't end like a sentence, rules, table header and separator rows,
   * short bold labels, fenced code blocks, lone list numerals), in document
   * order. Empty when `config.markdown` is `false`. Review it if a claim
   * could hide in a heading.
   */
  nonClaims: string[];
  /**
   * True only when there are zero ungrounded and zero invalid sentences. This
   * is a structural result, not a verdict: placeholders (unresolved gaps) do
   * not block it, and a document with no checkable sentences at all is also
   * `true`. Look at `counts` and `sentences.length` before publishing.
   */
  isClean: boolean;
}

/**
 * Split `text` into grounding units and classify each one against
 * `evidenceMap`. Returns a document-level summary (counts per status) plus
 * the full per-sentence breakdown, so a caller can both gate on `isClean`
 * and surface exactly which sentences need a human look.
 *
 * `config` and `evidenceMap` are read once for the whole document: the same
 * patterns, `supports` function and evidence values apply to every sentence.
 *
 * Cost: see `classifySentence`; the sum over a document of short sentences
 * grows with the text length, but one very long sentence that cites many
 * different ids together does not (see the README).
 *
 * @throws {TypeError} if `text` is not a string, `evidenceMap` is not a plain
 *   (or null-prototype) object, or `config` has an unknown key or an option of
 *   the wrong type — checked up front, including for an empty `text`.
 * @throws {GroundingConfigError} if `markerPattern` matches zero characters,
 *   or `supports` returns anything but a boolean.
 */
export function classifyDocument(
  text: string,
  evidenceMap: EvidenceMap,
  config: ClassifyConfig = {},
): DocumentClassification {
  assertString(text, "text");
  assertPlainObject(evidenceMap, "evidenceMap");
  const resolved = resolveClassify(config);
  const lookup = evidenceLookup(evidenceMap);
  const { units, nonClaims } = splitResolved(text, resolved.splitter);
  const preparedEvidence = new Map<string, PreparedEvidence>();
  const sentences = units.map((sentence) => classifyResolved(sentence, lookup, resolved, preparedEvidence));

  const counts: Record<SentenceStatus, number> = {
    grounded: 0,
    placeholder: 0,
    ungrounded: 0,
    invalid: 0,
  };
  const citedEvidenceIds = new Set<string>();
  for (const s of sentences) {
    counts[s.status]++;
    s.validIds.forEach((id) => citedEvidenceIds.add(id));
  }

  return {
    sentences,
    counts,
    citedEvidenceIds: [...citedEvidenceIds],
    nonClaims,
    isClean: counts.ungrounded === 0 && counts.invalid === 0,
  };
}

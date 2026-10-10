import { GroundingConfigError } from "./errors.js";
import {
  markerSitesOf,
  readSplitterOptions,
  resolveSplitter,
  splitResolved,
  stripMarkersOf,
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
 * - `"no-content-words"` — the default matcher had nothing to compare (the
 *   text has no word longer than three characters and no number, such as
 *   "Yes [[cite:e1]]."). The id exists, so it is accepted, unchecked. Only
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

function normalizeForOverlap(s: string): string {
  return (
    s
      .normalize("NFC")
      .toLowerCase()
      // A markdown link keeps its text and drops its target; a bare URL is
      // dropped. Neither is a claim word.
      .replace(/\]\([^)\s]*\)/g, "] ")
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
}

// Words, with any run of an unspaced script turned into overlapping
// two-character pieces ("電池持続" -> 電池, 池持, 持続). A word is
// significant when it is longer than three characters; every unspaced piece
// is significant.
function tokenize(normalized: string): Token[] {
  const out: Token[] = [];
  if (normalized === "") return out;
  for (const word of normalized.split(" ")) {
    if (!HAS_UNSPACED.test(word)) {
      out.push({ text: word, significant: word.length > 3 });
      continue;
    }
    let last = 0;
    for (const m of word.matchAll(UNSPACED_RUN)) {
      const other = word.slice(last, m.index);
      if (other) out.push({ text: other, significant: other.length > 3 });
      const chars = Array.from(m[0]);
      if (chars.length === 1) out.push({ text: chars[0], significant: true });
      for (let i = 0; i + 1 < chars.length; i++) {
        out.push({ text: chars[i] + chars[i + 1], significant: true });
      }
      last = m.index + m[0].length;
    }
    const tail = word.slice(last);
    if (tail) out.push({ text: tail, significant: tail.length > 3 });
  }
  return out;
}

// The words that count toward the overlap ratio: words longer than three
// characters and every unspaced-script piece. When there is none, words with a
// digit count instead, so a short numeric claim ("Tax is 5%") is still
// compared rather than passed unchecked.
function significantSet(normalized: string): Set<string> {
  const set = new Set<string>();
  const numeric = new Set<string>();
  for (const t of tokenize(normalized)) {
    if (t.significant) set.add(t.text);
    else if (HAS_DIGIT.test(t.text)) numeric.add(t.text);
  }
  return set.size > 0 ? set : numeric;
}

function tokenSet(normalized: string): Set<string> {
  return new Set(tokenize(normalized).map((t) => t.text));
}

/** How many distinct words in `text` the default matcher would compare. */
function contentWordCount(text: string): number {
  return significantSet(normalizeForOverlap(text)).size;
}

/** Whether `text` has anything the default matcher can compare. */
function hasContentWords(text: string): boolean {
  return contentWordCount(text) > 0;
}

// A span with fewer content words than this is too short to judge on its own
// ("According to the lab [[cite:a]], ..."): its citation is also accepted if
// it supports the whole sentence, as in 0.2.1.
const MIN_SPAN_WORDS = 3;

// The "claim contains the evidence" shortcut needs the evidence to be a
// whole-word phrase of at least this many characters and at least
// CONTAINED_SHARE of the claim, so a short evidence string ("Acme") cannot
// support a long fabricated sentence that merely mentions it.
const MIN_CONTAINED_EVIDENCE = 12;
const CONTAINED_SHARE = 0.6;
const OVERLAP_SHARE = 0.6;

/**
 * Default `supports()`: naive substring-or-word-overlap check, NOT semantic
 * entailment. Returns true if:
 * - the normalized claim appears in the normalized evidence as whole words, or
 * - the normalized evidence appears in the claim as whole words, is at least
 *   12 characters, and is at least 60% of the claim's length, or
 * - at least 60% of the claim's significant words (longer than three
 *   characters; numbers only when there is no such word) also appear in the
 *   evidence. Text in an unspaced script (Chinese, Japanese, Thai, ...) is
 *   compared by overlapping two-character pieces instead of words.
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
export const defaultSupports: SupportsFn = (sentenceText, evidenceText) => {
  const claim = normalizeForOverlap(sentenceText);
  const evidence = normalizeForOverlap(evidenceText);
  if (!claim || !evidence) return false;
  if (` ${evidence} `.includes(` ${claim} `)) return true;
  if (
    evidence.length >= MIN_CONTAINED_EVIDENCE &&
    evidence.length >= CONTAINED_SHARE * claim.length &&
    ` ${claim} `.includes(` ${evidence} `)
  ) {
    return true;
  }
  const claimWords = significantSet(claim);
  if (claimWords.size === 0) return false;
  // Only the claim's significant words are looked up, so short evidence words never matter.
  const evidenceWords = tokenSet(evidence);
  let overlap = 0;
  for (const w of claimWords) if (evidenceWords.has(w)) overlap++;
  return overlap / claimWords.size >= OVERLAP_SHARE;
};

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
 * A run of citation markers with no letters or digits between them, and the
 * texts each of its citations may be accepted for, in the order they are
 * tried.
 */
interface CitationGroup {
  ids: string[];
  texts: string[];
}

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Group the sentence's markers and give each group the text it is attached
// to. With one group, that is the whole marker-free sentence (the 0.2.1
// rule). With several, a group covers its span: the text since the previous
// group (or the start), plus, for the last group, any text after it. A span
// with three or more content words is judged on its own. A shorter one
// ("According to the lab", "and costs $1,299") is accepted if the whole
// sentence or the span passes, and a span with no content words ("and")
// uses the whole sentence.
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
  if (withIds.length <= 1) return withIds.map((g) => ({ ids: g.ids, texts: [claimText] }));
  return withIds.map((g, k) => {
    const from = k === 0 ? 0 : withIds[k - 1].end;
    const head = sentence.slice(from, g.start).trimEnd();
    const tail = k === withIds.length - 1 ? sentence.slice(g.end) : "";
    const glue = HAS_LETTER_OR_DIGIT.test(head.slice(-1)) && HAS_LETTER_OR_DIGIT.test(tail.slice(0, 1)) ? " " : "";
    const span = stripMarkersOf(head + glue + tail, splitter.marker).trim();
    const words = contentWordCount(span);
    const texts = words === 0 ? [claimText] : words < MIN_SPAN_WORDS ? [claimText, span] : [span];
    return { ids: g.ids, texts };
  });
}

// With the default matcher, ids cited together in one group may share the
// work of supporting the group's text: an id the matcher rejects on its own
// is accepted when the group's evidence together covers 60% of the text's
// significant words and this id's evidence covers at least two of them (or
// all of them, when the text has fewer than two). Word sets are built once
// per group, so a large group stays linear in its size.
interface SharedGroup {
  union: Set<string>;
  own: Map<string, Set<string>>;
  words: Map<string, Set<string>>;
}

function sharedGroup(evidenceById: Map<string, string>): SharedGroup {
  const union = new Set<string>();
  const own = new Map<string, Set<string>>();
  for (const [id, text] of evidenceById) {
    const tokens = tokenSet(normalizeForOverlap(text));
    own.set(id, tokens);
    for (const t of tokens) union.add(t);
  }
  return { union, own, words: new Map() };
}

function sharedSupport(text: string, id: string, group: SharedGroup): boolean {
  let words = group.words.get(text);
  if (words === undefined) {
    words = significantSet(normalizeForOverlap(text));
    group.words.set(text, words);
  }
  const own = group.own.get(id);
  if (words.size === 0 || own === undefined) return false;
  let ownHits = 0;
  let covered = 0;
  for (const w of words) {
    if (own.has(w)) ownHits++;
    if (group.union.has(w)) covered++;
  }
  return ownHits >= Math.min(2, words.size) && covered / words.size >= OVERLAP_SHARE;
}

function classifyResolved(
  sentence: string,
  lookup: (id: string) => Evidence,
  { splitter, supports }: ResolvedClassify,
): SentenceClassification {
  const claimText = stripMarkersOf(sentence, splitter.marker).trim();
  const groups = citationGroups(sentence, claimText, splitter);
  const citedIds = groups.flatMap((g) => g.ids);
  const usingDefault = supports === defaultSupports;

  // Each distinct (id, text) pair is asked once: a sentence that repeats one
  // id N times next to the same text costs one callback call, not N.
  // Keyed by text first: the same text object is reused for every id, so its
  // hash is computed once instead of building a long key per id.
  const answers = new Map<string, Map<string, boolean>>();
  const ask = (id: string, text: string, evidence: string): boolean => {
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
  const contentMemo = new Map<string, boolean>();
  const hasContent = (text: string): boolean => {
    let value = contentMemo.get(text);
    if (value === undefined) {
      value = hasContentWords(text);
      contentMemo.set(text, value);
    }
    return value;
  };
  const reasons: Record<string, CitationReason> = Object.create(null) as Record<string, CitationReason>;
  const validIds: string[] = [];
  let hasInvalid = false;
  for (const group of groups) {
    // Built only when an id in a multi-id group fails on its own.
    let shared: SharedGroup | null | undefined;
    const getShared = (): SharedGroup | null => {
      if (shared !== undefined) return shared;
      const evidenceById = new Map<string, string>();
      for (const id of group.ids) {
        const ev = lookup(id);
        if (ev.kind === "text") evidenceById.set(id, ev.text);
      }
      shared = evidenceById.size > 1 ? sharedGroup(evidenceById) : null;
      return shared;
    };
    for (const id of group.ids) {
      const ev = lookup(id);
      let reason: CitationReason;
      if (ev.kind === "missing") reason = "unknown-id";
      else if (ev.kind === "not-string") reason = "invalid-evidence";
      else if (group.texts.some((text) => ask(id, text, ev.text))) reason = "supported";
      // The default matcher says no to text with nothing to compare; that is
      // reported separately and accepted, unchecked.
      else if (usingDefault && !hasContent(group.texts[0])) reason = "no-content-words";
      else if (
        usingDefault &&
        group.ids.length > 1 &&
        group.texts.some((text) => {
          const g = getShared();
          return g !== null && sharedSupport(text, id, g);
        })
      ) {
        reason = "supported";
      } else reason = "not-supported";
      const valid = reason === "supported" || reason === "no-content-words";
      if (valid) validIds.push(id);
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
  return classifyResolved(sentence, evidenceLookup(evidenceMap), resolveClassify(config));
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
  const sentences = units.map((sentence) => classifyResolved(sentence, lookup, resolved));

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

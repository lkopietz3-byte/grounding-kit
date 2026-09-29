import { GroundingConfigError } from "./errors.js";
import {
  citedIdsOf,
  resolveSplitter,
  splitResolved,
  stripMarkersOf,
  type ResolvedSplitter,
  type SplitterConfig,
} from "./sentenceSplitter.js";
import { assertPlainObject, assertString, describe } from "./validate.js";

/**
 * A sentence's grounding outcome, in precedence order (checked in this
 * order by `classifySentence`; the first match wins):
 * - `"invalid"` — cites a marker id that's missing from the evidence map, or
 *   whose evidence doesn't pass `supports()`. A forged/unattributable
 *   citation, outranking everything else.
 * - `"placeholder"` — no invalid citation, and the sentence matches the
 *   placeholder pattern (an honest "no source for this" gap).
 * - `"grounded"` — no invalid citation, no placeholder, and at least one
 *   citation, all valid.
 * - `"ungrounded"` — a bare, uncited claim: none of the above.
 */
export type SentenceStatus = "grounded" | "placeholder" | "ungrounded" | "invalid";

/**
 * Maps a citation marker id to the evidence text/span it claims to support.
 * This is the closed world: a marker whose id isn't a key here (or whose
 * evidence doesn't plausibly support the sentence) is a forged citation, not
 * an honest gap.
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
 * It must return a real boolean, synchronously. Any other return value (a
 * Promise from an `async` function, a truthy string, `undefined`, a number)
 * makes classification throw `GroundingConfigError`: the kit never awaits the
 * result and never guesses what a non-boolean was meant to say.
 */
export type SupportsFn = (sentenceText: string, evidenceText: string) => boolean;

function normalizeForOverlap(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Default `supports()`: naive substring-or-word-overlap check, NOT semantic
 * entailment. Returns true if one normalized string contains the other, or
 * if at least 60% of the claim's significant words (length > 3) also appear
 * in the evidence text. This catches paraphrase-free grounding and obvious
 * mismatches; it will both miss real paraphrases and pass some coincidental
 * word overlap. Replace it for anything that needs real semantic judgment.
 *
 * Normalization (both sides, before comparing): Unicode NFC, lowercased,
 * punctuation collapsed to spaces (any script's letters/digits are kept via
 * `\p{L}`/`\p{N}`), whitespace collapsed. The NFC step means a claim and its
 * evidence written with the same accented text in different (both valid)
 * Unicode forms — e.g. composed "café" vs. decomposed "e" + combining accent
 * — still match; without it, a combining mark isn't `\p{L}`/`\p{N}` and gets
 * stripped, silently changing the word.
 */
export const defaultSupports: SupportsFn = (sentenceText, evidenceText) => {
  const claim = normalizeForOverlap(sentenceText);
  const evidence = normalizeForOverlap(evidenceText);
  if (!claim || !evidence) return false;
  if (evidence.includes(claim) || claim.includes(evidence)) return true;

  const claimWords = new Set(claim.split(" ").filter((w) => w.length > 3));
  if (claimWords.size === 0) return false;
  const evidenceWords = new Set(evidence.split(" ").filter((w) => w.length > 3));

  let overlap = 0;
  for (const w of claimWords) if (evidenceWords.has(w)) overlap++;
  return overlap / claimWords.size >= 0.6;
};

/**
 * Options for `classifySentence`/`classifyDocument`: splitting config plus the
 * evidence-match function. Each option is read once per call, so a getter or
 * Proxy cannot answer differently for the second sentence of a document.
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
  /** Every marker id cited by this sentence, including invalid/forged ones. */
  citedIds: string[];
  /** Cited ids that exist in the evidence map AND pass `supports()`. */
  validIds: string[];
}

interface ResolvedClassify {
  splitter: ResolvedSplitter;
  supports: SupportsFn;
}

// Read every option once and validate it. `config` and `abbreviations` must be
// plain objects: a Map or class instance would read as "no options" and
// silently fall back to the defaults.
function resolveClassify(config: unknown): ResolvedClassify {
  const source = config === undefined ? {} : config;
  assertPlainObject(source, "config");
  const supports = source.supports ?? defaultSupports;
  if (typeof supports !== "function") {
    throw new TypeError(`config.supports must be a function (got ${describe(supports)}).`);
  }
  return {
    splitter: resolveSplitter({
      abbreviations: source.abbreviations,
      markerPattern: source.markerPattern,
      placeholderPattern: source.placeholderPattern,
    }),
    supports: supports as SupportsFn,
  };
}

// Own-property lookup, read at most once per id per call. `evidenceMap` is a
// plain object, so a *prototype-chain* hit (marker id "__proto__",
// "constructor", "toString", ...) would otherwise resolve to Object.prototype's
// value for that name instead of `undefined` — handing `supports()` an object
// or function instead of a string and crashing it. `Object.hasOwn` plus a
// `typeof` guard treats any such id exactly like a genuinely-missing one: an
// invalid (forged/unknown) citation, never a thrown exception. Caching means a
// getter on the map cannot return one value for the first citation of an id
// and another for the second.
function evidenceLookup(evidenceMap: EvidenceMap): (id: string) => string | undefined {
  const cache = new Map<string, string | undefined>();
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const raw: unknown = Object.hasOwn(evidenceMap, id) ? evidenceMap[id] : undefined;
    const value = typeof raw === "string" ? raw : undefined;
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

function classifyResolved(
  sentence: string,
  lookup: (id: string) => string | undefined,
  { splitter, supports }: ResolvedClassify,
): SentenceClassification {
  const citedIds = citedIdsOf(sentence, splitter.marker);
  const claimText = stripMarkersOf(sentence, splitter.marker);

  const validIds: string[] = [];
  let hasInvalid = false;
  for (const id of citedIds) {
    const evidence = lookup(id);
    if (evidence === undefined) {
      hasInvalid = true; // marker id doesn't exist in the evidence map (or maps to a non-string)
      continue;
    }
    if (!callSupports(supports, claimText, evidence)) {
      hasInvalid = true; // marker exists but doesn't support the claim
      continue;
    }
    validIds.push(id);
  }

  if (hasInvalid) return { sentence, status: "invalid", citedIds, validIds };

  splitter.placeholderTest.lastIndex = 0;
  if (splitter.placeholderTest.test(sentence)) {
    return { sentence, status: "placeholder", citedIds, validIds };
  }

  if (citedIds.length > 0) return { sentence, status: "grounded", citedIds, validIds };
  return { sentence, status: "ungrounded", citedIds, validIds };
}

/**
 * Classify a single sentence against `evidenceMap`. A hallucinated or forged
 * citation ("invalid") outranks a placeholder: a sentence that cites a
 * missing or non-supporting marker id surfaces as invalid even if it also
 * contains a placeholder gap, so a bad cite can never hide behind an honest
 * "I don't have a source."
 *
 * Status precedence: invalid > placeholder > grounded > ungrounded.
 *
 * @throws {TypeError} if `sentence` is not a string, `evidenceMap` is not a
 *   plain (or null-prototype) object, or an option in `config` has the wrong
 *   type. Checked up front rather than left to fail inside the citation loop,
 *   where — before this check existed — a bad `evidenceMap` only crashed for
 *   a sentence that actually cited something, so the same call could throw or
 *   silently "succeed" depending on the text.
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
 * @throws {TypeError} if `text` is not a string, `evidenceMap` is not a plain
 *   (or null-prototype) object, or an option in `config` has the wrong type —
 *   checked up front, including for an empty `text` (zero sentences), which
 *   would otherwise never reach the per-sentence check and so never validate
 *   `evidenceMap` at all.
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
  const sentences = splitResolved(text, resolved.splitter).map((sentence) =>
    classifyResolved(sentence, lookup, resolved),
  );

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
    isClean: counts.ungrounded === 0 && counts.invalid === 0,
  };
}

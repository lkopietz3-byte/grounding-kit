import {
  DEFAULT_MARKER_PATTERN,
  DEFAULT_PLACEHOLDER_PATTERN,
  extractCitedIds,
  splitSentences,
  stripCitationMarkers,
  type SplitterConfig,
} from "./sentenceSplitter.js";

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

export interface ClassifyConfig extends SplitterConfig {
  supports?: SupportsFn;
}

export interface SentenceClassification {
  sentence: string;
  status: SentenceStatus;
  /** Every marker id cited by this sentence, including invalid/forged ones. */
  citedIds: string[];
  /** Cited ids that exist in the evidence map AND pass `supports()`. */
  validIds: string[];
}

/**
 * Classify a single sentence against `evidenceMap`. A hallucinated or forged
 * citation ("invalid") outranks a placeholder: a sentence that cites a
 * missing or non-supporting marker id surfaces as invalid even if it also
 * contains a placeholder gap, so a bad cite can never hide behind an honest
 * "I don't know."
 *
 * Status precedence: invalid > placeholder > grounded > ungrounded.
 */
export function classifySentence(
  sentence: string,
  evidenceMap: EvidenceMap,
  config: ClassifyConfig = {},
): SentenceClassification {
  const markerPattern = config.markerPattern ?? DEFAULT_MARKER_PATTERN;
  const placeholderPattern = config.placeholderPattern ?? DEFAULT_PLACEHOLDER_PATTERN;
  const supports = config.supports ?? defaultSupports;

  const citedIds = extractCitedIds(sentence, markerPattern);
  const claimText = stripCitationMarkers(sentence, markerPattern);

  const validIds: string[] = [];
  let hasInvalid = false;
  for (const id of citedIds) {
    // Own-property lookup only. `evidenceMap` is a plain object, so a
    // *prototype-chain* hit (marker id "__proto__", "constructor",
    // "toString", ...) would otherwise resolve to Object.prototype's value
    // for that name instead of `undefined` — handing `supports()` an object
    // or function instead of a string and crashing it. `Object.hasOwn` plus
    // a `typeof` guard treats any such id exactly like a genuinely-missing
    // one: an invalid (forged/unknown) citation, never a thrown exception.
    const evidence = Object.hasOwn(evidenceMap, id) ? evidenceMap[id] : undefined;
    if (typeof evidence !== "string") {
      hasInvalid = true; // marker id doesn't exist in the evidence map (or maps to a non-string)
      continue;
    }
    if (!supports(claimText, evidence)) {
      hasInvalid = true; // marker exists but doesn't support the claim
      continue;
    }
    validIds.push(id);
  }

  if (hasInvalid) return { sentence, status: "invalid", citedIds, validIds };

  const flags = placeholderPattern.flags.replace(/[gy]/g, "");
  const freshPlaceholder = new RegExp(placeholderPattern.source, flags);
  if (freshPlaceholder.test(sentence)) {
    return { sentence, status: "placeholder", citedIds, validIds };
  }

  if (citedIds.length > 0) return { sentence, status: "grounded", citedIds, validIds };
  return { sentence, status: "ungrounded", citedIds, validIds };
}

export interface DocumentClassification {
  sentences: SentenceClassification[];
  counts: Record<SentenceStatus, number>;
  /** Distinct evidence ids that were genuinely (validly) cited anywhere in the document. */
  citedEvidenceIds: string[];
  /** True only when there are zero ungrounded and zero invalid sentences. */
  isClean: boolean;
}

/**
 * Split `text` into grounding units and classify each one against
 * `evidenceMap`. Returns a document-level summary (counts per status) plus
 * the full per-sentence breakdown, so a caller can both gate on `isClean`
 * and surface exactly which sentences need a human look.
 */
export function classifyDocument(
  text: string,
  evidenceMap: EvidenceMap,
  config: ClassifyConfig = {},
): DocumentClassification {
  const sentences = splitSentences(text, config).map((sentence) =>
    classifySentence(sentence, evidenceMap, config),
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

// Deterministic, dependency-free sentence splitter hardened against the ways a
// citation marker can get laundered onto the wrong sentence: abbreviation
// periods that don't end a sentence, a marker sitting right after a period
// (so it looks like it grounds the NEXT sentence instead of the one it
// actually terminates), clause-internal fabrications hiding behind a real
// citation elsewhere in the same sentence, non-ASCII sentence terminators, and
// malformed brackets that a naive matcher would silently accept.
//
// Nothing here is specific to any one product's citation convention beyond
// the two configurable regexes below (`markerPattern`, `placeholderPattern`)
// and the abbreviation-fusion list. Ship your own of each for your domain;
// the defaults are deliberately generic.

import { GroundingConfigError } from "./errors.js";
import {
  assertKnownKeys,
  assertPlainObject,
  assertString,
  describe,
  readStringList,
} from "./validate.js";

/** Controls which trailing periods do NOT end a sentence. */
export interface AbbreviationConfig {
  /**
   * Abbreviations that attach to the token that follows them, so a period
   * after one of these does not end a sentence (e.g. honorifics: "Dr. Vance"
   * must not split into "Dr." + "Vance"). One exception: when a citation
   * marker or placeholder follows the period, the period ends the sentence
   * unless the text after the marker continues in lower case.
   */
  alwaysFuse: readonly string[];
  /**
   * Abbreviations that CAN legitimately end a sentence (list-enders, unit
   * suffixes). They fuse with what follows when the next fragment does not
   * start with a capital letter ("Corp. filed the report" ends the sentence;
   * "Corp. reserves the right" does not, and "no. 2 on the list" does not end
   * at "no."). A few known words also fuse before a capital in a narrow
   * context; see the README section "Abbreviations".
   */
  contextFuse: readonly string[];
}

/**
 * Small, generic English defaults. These are NOT tuned for any one domain —
 * override `alwaysFuse`/`contextFuse` entirely for other languages, other
 * abbreviation conventions, or to add domain-specific ones (they replace,
 * not merge, so you always know exactly what's active).
 */
export const DEFAULT_ABBREVIATIONS: AbbreviationConfig = Object.freeze({
  alwaysFuse: Object.freeze([
    "mr", "mrs", "ms", "dr", "prof", "hon", "st", "v", "vs",
  ]),
  contextFuse: Object.freeze([
    "no", "inc", "co", "corp", "ltd", "llc", "dept", "vol", "ed",
    "al", "etc", "eg", "ie", "approx", "fig", "p", "pp", "jr", "sr",
    // "am"/"pm"/"us" belong here, never in alwaysFuse: they are common
    // English WORDS ("I am.", "They told us.") as often as they are
    // abbreviations ("9 a.m.", "the U.S."). They only count as abbreviations
    // when written with an inner period ("a.m.", "U.S."), and only
    // contextFuse's next-fragment check then decides whether they end the
    // sentence.
    "am", "pm", "us",
    // Added 2026-10-10. Each fuses only in a narrow context (see the README
    // section "Abbreviations"), because every fusion can join an uncited
    // sentence to a cited one.
    "plc", "est", "ca", "cf", "viz", "phd", "md", "uk", "eu",
    "gov", "sen", "mt", "lt", "sgt", "capt", "messrs",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  ]),
});

/**
 * Regex matching one citation marker. Must contain exactly one capture group
 * holding the marker id, and must match at least one character.
 *
 * The kit never uses your object directly: every call scans with its own
 * copy that always has the global flag on and the sticky flag (`y`) off. So
 * `g`, `y`, `gy` and no flag at all find the same markers, and your object's
 * `lastIndex` and flags are never touched. A match of zero characters (for
 * example `/()/g` or `/(?=(a))/g`) throws `GroundingConfigError` as soon as
 * one is found, because a marker that occupies no text cannot be attached to
 * or removed from anything and would stall the scan.
 *
 * Default convention: `[[cite:id]]`, where the id is one or more of
 * `a-z A-Z 0-9 _ -`. Anything else between the brackets (a space inside the
 * id, a dot, a comma-separated list) is not a marker: the text stays as
 * prose and grounds nothing. Bring your own pattern for e.g. `[1]`,
 * `{{ref:id}}`, or whatever your generator already emits.
 */
export const DEFAULT_MARKER_PATTERN = /\[\[cite:\s*([a-zA-Z0-9_-]+)\s*\]\]/g;

/**
 * Regex matching an explicit "I don't have a source for this" placeholder —
 * the honest alternative to inventing a citation. Default recognizes a few
 * common bracketed conventions ("[citation needed]", "[TK]"), with up to 200
 * characters of note before the closing bracket. Each keyword must end at a
 * word boundary, so "[Tkachenko 2019]" or "[TKO Group]" are not placeholders.
 * The 200-character cap keeps a long run of unclosed "[TK" from making the
 * scan quadratic; a longer note is not recognized as a placeholder, so that
 * sentence is classified by its citations instead (fail closed). Bring your
 * own to match whatever gap-marker your prompt asks the model to emit.
 */
export const DEFAULT_PLACEHOLDER_PATTERN =
  /\[(?:citation needed|more research needed|TK)\b[^\]]{0,200}\]/i;

/**
 * Options for `splitSentences` (and, via `ClassifyConfig`, for
 * `classifySentence`/`classifyDocument`). Every field is optional; an
 * omitted field falls back to its `DEFAULT_*` export. An unknown key throws
 * a `TypeError`, so a typo cannot silently fall back to a default.
 */
export interface SplitterConfig {
  /** Replaces `DEFAULT_ABBREVIATIONS` entirely (does not merge with it). */
  abbreviations?: AbbreviationConfig;
  /** Replaces `DEFAULT_MARKER_PATTERN`. Must have exactly one capture group. */
  markerPattern?: RegExp;
  /** Replaces `DEFAULT_PLACEHOLDER_PATTERN`. */
  placeholderPattern?: RegExp;
  /**
   * `false` (default): every line is checked as text, except lines that hold
   * no claim at all (a horizontal rule, a table separator row, a bare fence
   * line, a lone list numeral such as "1."), which are set aside.
   *
   * `true` (opt-in, more lenient): headings, short emphasized labels, short
   * lead-in lines ending in a colon, table header rows and fenced code blocks
   * are also set aside unless they carry a marker or placeholder or hold a
   * statement, and a hard-wrapped line that continues a sentence is joined to
   * it. This passes honest markdown reports but can hide a claim written as a
   * heading or label; see the README section "Markdown and layout".
   */
  markdown?: boolean;
}

// Sentence terminators. ASCII-style ones need whitespace after them to end a
// sentence; the CJK full stops below also end one with no space after them.
const TERMINATORS = ".!?…‼⁇⁈⁉।॥؟۔。．！？";
// Characters that can close a sentence after its terminator: quotes,
// brackets (ASCII, full-width and CJK), markdown emphasis, footnote
// superscripts.
const CLOSERS = "\"'”’»)\\]}*_」』）〕】》〉＂＇］｝¹²³⁰⁴⁵⁶⁷⁸⁹†‡";
const TERMINATOR_CLASS = new RegExp(`[${TERMINATORS}]`, "u");
const CLOSER_CLASS = new RegExp(`[${CLOSERS}]`, "u");
// A sentence ends after a terminator (plus up to three closers):
// - followed by whitespace;
// - for a CJK full stop, followed directly by text, also after its closers
//   ("。」次の文");
// - for any other terminator, after at least one closer and directly before
//   a capital letter ('."Prices doubled').
// The closer run is bounded so each lookbehind stays O(1) per position.
const SENTENCE_BOUNDARY = new RegExp(
  `(?<=[${TERMINATORS}][${CLOSERS}]{0,3})\\s+` +
    `|(?<=[。．！？][${CLOSERS}]{0,3})(?=[^\\s${CLOSERS}])` +
    `|(?<=[.!?…‼⁇⁈⁉।॥؟۔][${CLOSERS}]{1,3})(?=\\p{Lu})`,
  "u",
);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// Whitespace plus characters a renderer draws as nothing (zero-width space and
// joiners, word joiner, soft hyphen, every bidi control, variation selectors,
// Hangul fillers, ...). `\s` alone misses them, so text that LOOKS like
// "period, space, marker" could hide its boundary behind one.
const INVISIBLE_RUN = /[\s\p{Default_Ignorable_Code_Point}]*/uy;
const BLANK = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]*$/u;
const TERMINATOR_THEN_INVISIBLE = new RegExp(
  `([${TERMINATORS}][${CLOSERS}]{0,3})(?=\\p{Default_Ignorable_Code_Point})`,
  "gu",
);
const LINE_BREAKS = /\r\n?|[\u2028\u2029]/g;

// A fragment that is only a list label: "1.", "2)", "IV.", "B.", "Step 1.".
// It carries no claim, so it joins the text after it instead of becoming a
// phantom "uncited claim" of its own.
const LABEL_ONLY =
  /^(?:(?:step|part|chapter|section|phase|stage|option|item|tip|rule|question|appendix|q)\s+)?(?:\d{1,3}|(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})|\p{L})[.)]$/iu;

// Words that start sentences. A capitalized next word from this list means a
// new sentence, not the rest of a name or title after an abbreviation.
const OPENERS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "we", "they",
  "he", "she", "i", "you", "our", "their", "his", "her", "my", "your", "there",
  "here", "in", "on", "at", "for", "but", "and", "or", "so", "however", "also",
  "as", "if", "when", "after", "before", "while", "with", "by", "to", "from",
  "of", "then", "now", "today", "meanwhile", "overall", "finally", "first",
  "next", "still", "yet", "although", "because", "since", "each", "every",
  "all", "some", "many", "most", "both", "such", "what", "which", "who", "how",
  "why", "where", "no", "not", "one", "two", "three",
]);
// Narrow contexts for a few known contextFuse words. Everything else ends the
// sentence before a capital, as in 0.2.1.
const TIME_WORDS = new Set(["am", "pm"]);
// Time-zone codes written in capitals ("9 a.m. ET"). Words such as "Eastern"
// or "Pacific" are left out: they also start sentences.
const TIME_ZONES = new Set([
  "ET", "EST", "EDT", "CT", "CST", "CDT", "MT", "MST", "MDT", "PT", "PST", "PDT",
  "UTC", "GMT", "BST", "CET", "CEST", "JST", "AEST",
]);
// Titles before a name: they fuse before a capitalized word that is not a
// sentence opener, and only when written with a capital ("Gov. Rivera", not
// "the gov. Rivera").
const TITLE_WORDS = new Set(["gov", "sen", "mt", "lt", "sgt", "capt", "messrs"]);
// Words added after 0.2.1 that fuse only before lower case ("a Ph.D. in
// chemistry", "the U.K. government", "Acme plc. announced"), never before a
// number ("Jane Roe, MD. 9 in 10 patients...") or a capital.
const LOWER_ONLY_WORDS = new Set(["phd", "md", "uk", "eu", "plc", "cf", "viz"]);
// "est." and "ca." also fuse before a year or a larger number ("est. 2010",
// "ca. 1900", "ca. 1.299 Euro").
const YEAR_WORDS = new Set(["est", "ca"]);
// Months fuse before a day number from 1 to 31 followed by a comma, a year or
// the end ("Jan. 5, 2024"), not before other numbers.
const MONTH_WORDS = new Set([
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);
// Common English words, or country codes written without dots, that only
// count as abbreviations in dotted form ("U.S.", "U.K.", "a.m.").
const DOTTED_ONLY = new Set(["am", "pm", "us", "uk", "eu"]);
// A capitalized word before a single letter that names a thing, not a person:
// "Plan B." and "Section A." can end a sentence; "Dana M." cannot.
const LABEL_NOUNS = new Set([
  "plan", "option", "section", "part", "appendix", "exhibit", "schedule",
  "table", "figure", "group", "type", "class", "grade", "level", "tier",
  "phase", "stage", "step", "item", "unit", "building", "block", "row",
  "column", "vitamin", "model", "version", "category", "zone", "area", "team",
  "round", "box", "hall", "wing", "gate", "terminal", "track", "room", "lab",
  "site", "wave", "series", "size", "chapter", "lot", "batch", "case", "test",
]);
// Words that, ending a hard-wrapped line, show the sentence continues on the
// next line even if that line starts with a capital.
const CONNECTORS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "from", "with",
  "and", "or", "but", "nor", "as", "that", "which", "who", "whose", "whom",
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "than", "into", "onto", "over", "under", "about", "per", "via", "its",
  "their", "our", "his", "her", "this", "these", "those", "between", "among",
  "during", "because", "if", "when", "where", "whether",
]);

// --- regex hygiene -----------------------------------------------------
// Every scan below runs on a private copy of the caller's regex, built ONCE
// per public call. Global regexes carry mutable lastIndex state, and a sticky
// one only matches at lastIndex, so sharing the caller's object (or keeping
// its `y` flag) is a source of "works on the first document, silently breaks
// on the second" bugs, and of a sticky marker that never sees a citation past
// the start of the text. The scanning copy is always global and never sticky;
// a second, sticky copy is used only to ask "is there a marker exactly here?".
// The kit reads `source` and `flags` through the RegExp.prototype getters,
// which throw for anything that is not a real RegExp (from any realm).

// The getters are always invoked with an explicit receiver through `.call`.
const readSource = (
  Object.getOwnPropertyDescriptor(RegExp.prototype, "source") as { get: (this: RegExp) => string }
).get;
const readFlags = (
  Object.getOwnPropertyDescriptor(RegExp.prototype, "flags") as { get: (this: RegExp) => string }
).get;

function copyPattern(value: unknown, label: string): { source: string; flags: string } {
  let source: string;
  let flags: string;
  try {
    source = readSource.call(value as RegExp);
    flags = readFlags.call(value as RegExp);
  } catch {
    throw new TypeError(`${label} must be a RegExp (got ${describe(value)}).`);
  }
  return { source, flags };
}

// A private global, non-sticky copy of a pattern. Any other flag is kept.
function globalCopy(value: unknown, label: string): RegExp {
  const { source, flags } = copyPattern(value, label);
  return new RegExp(source, `${flags.replace(/[gy]/g, "")}g`);
}

function zeroLengthMarker(index: number): GroundingConfigError {
  return new GroundingConfigError(
    `markerPattern matched zero characters at index ${String(index)}; a marker must match at least one character.`,
  );
}

/**
 * Every match of `re` (a private global copy) in `text`, in order. Throws
 * `GroundingConfigError` on the first zero-length match, so a marker pattern
 * that can match nothing never yields a match that consumes no text.
 */
function scanMarkers(text: string, re: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(text);
    if (m === null) return matches;
    if (m[0].length === 0) {
      re.lastIndex = 0;
      throw zeroLengthMarker(m.index);
    }
    matches.push(m);
  }
}

// Every non-empty placeholder match, in order. A placeholder pattern that can
// match nothing is not an error (it is only ever tested, never removed); its
// empty matches are skipped.
function scanPlaceholders(text: string, re: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(text);
    if (m === null) return matches;
    if (m[0].length === 0) {
      // Step past a whole code point under the u or v flag, so the scan
      // never stops inside a surrogate pair and repeats the same match.
      const cp = text.codePointAt(m.index);
      const unicode = re.unicode || re.flags.includes("v");
      re.lastIndex = m.index + (unicode && cp !== undefined && cp > 0xffff ? 2 : 1);
      if (re.lastIndex > text.length) return matches;
      continue;
    }
    matches.push(m);
  }
}

/** A splitter configuration read once and validated: private regex copies and dense, lower-cased word sets. */
export interface ResolvedSplitter {
  alwaysFuse: Set<string>;
  contextFuse: Set<string>;
  marker: RegExp;
  markerSticky: RegExp;
  placeholderGlobal: RegExp;
  placeholderSticky: RegExp;
  placeholderTest: RegExp;
  markdown: boolean;
}

// An abbreviation entry is compared with the letters of the word before a
// period, lower-cased, dots removed: "Dr.", "dr" and "D.R." are all "dr".
function normalizeAbbreviations(list: string[], label: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const word = list[i].replace(/\./g, "").toLowerCase();
    if (word !== "" && !/^[\p{Lu}\p{Ll}\p{Lt}\p{M}]+$/u.test(word)) {
      throw new TypeError(
        `${label}[${String(i)}] must be letters of a cased script (Latin, Greek, Cyrillic, ...), optionally with dots (got ${JSON.stringify(list[i])}); it could never match a word before a period.`,
      );
    }
    out.add(word);
  }
  return out;
}

/**
 * Validate and snapshot the splitter options. Each option is read from the
 * caller's object exactly once, so a getter or Proxy cannot return one value
 * to the validation and another to the scan.
 */
export function resolveSplitter(options: {
  abbreviations: unknown;
  markerPattern: unknown;
  placeholderPattern: unknown;
  markdown: unknown;
}): ResolvedSplitter {
  const abbreviations = options.abbreviations ?? DEFAULT_ABBREVIATIONS;
  assertPlainObject(abbreviations, "abbreviations");
  assertKnownKeys(abbreviations, ["alwaysFuse", "contextFuse"], "abbreviations");
  const alwaysFuse = readStringList(abbreviations.alwaysFuse, "abbreviations.alwaysFuse");
  const contextFuse = readStringList(abbreviations.contextFuse, "abbreviations.contextFuse");
  const markerPattern = options.markerPattern ?? DEFAULT_MARKER_PATTERN;
  const placeholderPattern = options.placeholderPattern ?? DEFAULT_PLACEHOLDER_PATTERN;
  const markdown = options.markdown ?? false;
  if (typeof markdown !== "boolean") {
    throw new TypeError(`config.markdown must be a boolean (got ${describe(markdown)}).`);
  }
  const marker = copyPattern(markerPattern, "markerPattern");
  const placeholder = copyPattern(placeholderPattern, "placeholderPattern");
  const markerFlags = marker.flags.replace(/[gy]/g, "");
  const placeholderFlags = placeholder.flags.replace(/[gy]/g, "");
  return {
    alwaysFuse: normalizeAbbreviations(alwaysFuse, "abbreviations.alwaysFuse"),
    contextFuse: normalizeAbbreviations(contextFuse, "abbreviations.contextFuse"),
    marker: new RegExp(marker.source, `${markerFlags}g`),
    markerSticky: new RegExp(marker.source, `${markerFlags}y`),
    placeholderGlobal: new RegExp(placeholder.source, `${placeholderFlags}g`),
    placeholderSticky: new RegExp(placeholder.source, `${placeholderFlags}y`),
    placeholderTest: new RegExp(placeholder.source, placeholderFlags),
    markdown,
  };
}

const SPLITTER_KEYS = ["abbreviations", "markerPattern", "placeholderPattern", "markdown"] as const;

/**
 * @internal Read the splitter options from a validated plain `config`. The
 * three original options are read unconditionally (once each); `markdown` is
 * read only when it is an own property.
 */
export function readSplitterOptions(config: Record<string, unknown>): {
  abbreviations: unknown;
  markerPattern: unknown;
  placeholderPattern: unknown;
  markdown: unknown;
} {
  return {
    abbreviations: config.abbreviations,
    markerPattern: config.markerPattern,
    placeholderPattern: config.placeholderPattern,
    markdown: Object.hasOwn(config, "markdown") ? config.markdown : undefined,
  };
}

function resolveSplitterConfig(config: unknown): ResolvedSplitter {
  assertPlainObject(config, "config");
  // `supports` is accepted (and ignored) so one config object can be shared
  // by splitSentences and classifyDocument.
  assertKnownKeys(config, [...SPLITTER_KEYS, "supports"], "config");
  return resolveSplitter(readSplitterOptions(config));
}

// --- per-position helpers ------------------------------------------------

// Length of the match of a sticky regex at `pos`, or 0 when there is none.
function stickyLength(re: RegExp, text: string, pos: number): number {
  re.lastIndex = pos;
  const m = re.exec(text);
  re.lastIndex = 0;
  return m === null ? 0 : m[0].length;
}

function invisibleRunEnd(text: string, pos: number): number {
  return pos + stickyLength(INVISIBLE_RUN, text, pos);
}

// Length of a citation marker starting exactly at `pos`, or 0.
function markerAt(text: string, pos: number, resolved: ResolvedSplitter): number {
  resolved.markerSticky.lastIndex = pos;
  const m = resolved.markerSticky.exec(text);
  resolved.markerSticky.lastIndex = 0;
  if (m === null) return 0;
  if (m[0].length === 0) throw zeroLengthMarker(pos);
  return m[0].length;
}

// Length of a placeholder starting exactly at `pos`, or 0.
function placeholderAt(text: string, pos: number, resolved: ResolvedSplitter): number {
  return stickyLength(resolved.placeholderSticky, text, pos);
}

function hasMarker(text: string, resolved: ResolvedSplitter): boolean {
  return scanMarkers(text, resolved.marker).length > 0;
}

function hasPlaceholder(text: string, resolved: ResolvedSplitter): boolean {
  resolved.placeholderTest.lastIndex = 0;
  return resolved.placeholderTest.test(text);
}

// Whether `s` starts with a lower-case letter that is not the start of a
// camel-case brand ("iPhone", "eBay" read as capitalized words).
function startsLower(s: string): boolean {
  return /^\p{Ll}/u.test(s) && !/^\p{Ll}+\p{Lu}/u.test(s);
}

function firstWord(s: string): string {
  const m = /^[\p{L}\p{M}]+/u.exec(s);
  return m === null ? "" : m[0].toLowerCase();
}

/**
 * What the next fragment starts with: whether it opens with citation markers
 * or placeholders (which belong to the sentence before them), and the text
 * after them.
 */
interface Lead {
  markerLed: boolean;
  text: string;
}

function leadOf(next: string, resolved: ResolvedSplitter): Lead {
  let pos = invisibleRunEnd(next, 0);
  let markerLed = false;
  for (;;) {
    const len = markerAt(next, pos, resolved) || placeholderAt(next, pos, resolved);
    if (len === 0) break;
    markerLed = true;
    pos = invisibleRunEnd(next, pos + len);
  }
  return { markerLed, text: next.slice(pos) };
}

// `trimmed` with up to four trailing closers removed, and whether any were.
function stripClosers(trimmed: string): { core: string; hadClosers: boolean } {
  let end = trimmed.length;
  while (end > 0 && trimmed.length - end < 4 && CLOSER_CLASS.test(trimmed[end - 1])) end--;
  return { core: trimmed.slice(0, end), hadClosers: end < trimmed.length };
}

// Letters an abbreviation can be written in: ASCII, plus any other cased
// letter (Latin with accents, Greek, Cyrillic, ...) and combining marks.
// Uncased scripts (CJK, Arabic, ...) are not, so "日本語p.m." still ends in
// the word "p.m".
const CASED_LETTER = /[\p{Lu}\p{Ll}\p{Lt}\p{M}]/u;

function isLetterCode(c: number, ch: string): boolean {
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return true;
  return c > 127 && CASED_LETTER.test(ch);
}

// The trailing word of a fragment that ends in ".": the run of letters and
// dots immediately before the final period, starting at its first letter.
// Found in one backward scan (a regex with an unbounded `*` here was
// quadratic on input like "aaaa...a1.").
function trailingWord(trimmed: string): string | null {
  let first = -1;
  for (let i = trimmed.length - 2; i >= 0; i--) {
    const c = trimmed.charCodeAt(i);
    if (isLetterCode(c, trimmed[i])) first = i;
    else if (c !== 46) break;
  }
  return first < 0 ? null : trimmed.slice(first, trimmed.length - 1);
}

// The contextFuse decision for a known abbreviation followed by `lead`.
// `written` is the abbreviation as it appears in the text.
function contextFuses(word: string, written: string, standalone: boolean, lead: Lead): boolean {
  if (lead.markerLed) return startsLower(lead.text);
  const t = lead.text;
  if (t === "") return false;
  const capital = /^\p{Lu}/u.test(t) || /^\p{Ll}+\p{Lu}/u.test(t);
  if (standalone && word !== "no" && (capital || startsLower(t))) {
    // An abbreviation with nothing before it in its fragment ("Sr. García")
    // carries no claim of its own, so joining it to what follows is safe.
    return true;
  }
  if (MONTH_WORDS.has(word)) {
    // "Jan. 5, 2024" or "Jan. 5 2024": a day number from 1 to 31, then a
    // comma that does not start a digit group, a year or the end. "Sept. 9
    // of 10 users", "Jan. 5,000 devices", "Jan. 5.5", "Jan. 5%" and "Jan.
    // 5th" all start a new sentence (an ordinal fails safe).
    const day = /^(\d{1,2})(?:\s*,(?!\d)|\s*\)|\s+\d{4}(?![\d.,])|\s*$)/.exec(t);
    return day !== null && Number(day[1]) >= 1 && Number(day[1]) <= 31;
  }
  if (LOWER_ONLY_WORDS.has(word)) return startsLower(t);
  if (YEAR_WORDS.has(word)) return startsLower(t) || /^(?:\d{3,4}(?![\d.,])|\d{1,3}(?:[.,]\d{3})+(?!\d))/.test(t);
  if (TITLE_WORDS.has(word)) return capital && /^\p{Lu}/u.test(written) && !OPENERS.has(firstWord(t));
  if (!capital) return true;
  // A capital after the abbreviation starts a new sentence, except a time
  // zone after a.m./p.m. ("9 a.m. ET").
  if (TIME_WORDS.has(word)) return TIME_ZONES.has(/^[\p{L}]+/u.exec(t)?.[0] ?? "");
  return false;
}

// The word just before index `end` in `text` (letters and marks), found by a
// backward scan so a long run of letters is read once.
function wordBefore(text: string, end: number): string {
  let i = end;
  while (i > 0 && /\s/u.test(text[i - 1])) i--;
  const stop = i;
  while (i > 0 && /[\p{L}\p{M}]/u.test(text[i - 1])) i--;
  return text.slice(i, stop);
}

// A single letter before the period. 0.2.1 always joined it to the next
// fragment (a name initial: "Dana M. Whitfield", "according to J. Smith").
// It now ends the sentence only on positive evidence: a marker follows (and
// the text after it is not lower case), lower case follows ("plan B.
// independent..."), the word before is a label noun ("plan B.", "Section
// A."), or the next word is a sentence opener ("Plan B. The vendor...").
function singleLetterFuses(core: string, letterIndex: number, lead: Lead): boolean {
  if (lead.markerLed) return startsLower(lead.text);
  const t = lead.text;
  if (/^\p{Lu}\.(?:\s|$)/u.test(t)) return true; // another initial follows: "J. R. R."
  // A lower-case letter before a number is a reference: "p. 4", "n. 12", "c. 1900".
  if (/^\p{N}/u.test(t)) return /^\p{Ll}$/u.test(core[letterIndex]);
  if (/^\p{Ll}/u.test(t) && !/^\p{Ll}+\p{Lu}/u.test(t)) return false;
  if (!/^[\p{Lu}\p{Ll}]/u.test(t)) return true; // punctuation or another script: as in 0.2.1
  if (LABEL_NOUNS.has(wordBefore(core, letterIndex).toLowerCase())) return false;
  return !OPENERS.has(firstWord(t));
}

// Whether a fragment ending in a period does NOT end the sentence. `core` is
// the trimmed fragment without trailing closers.
function endsOnFalseBoundary(core: string, lead: Lead, resolved: ResolvedSplitter): boolean {
  // Abbreviation fusion is a period-only concept and never applies to "!",
  // "?", or a non-ASCII terminator. Bailing out here is also a required
  // performance guard.
  if (!core.endsWith(".")) return false;
  const trailing = trailingWord(core);
  if (trailing !== null) {
    const word = trailing.replace(/\./g, "").toLowerCase();
    const dotted = trailing.includes(".");
    if (!(DOTTED_ONLY.has(word) && !dotted)) {
      if (resolved.alwaysFuse.has(word)) return lead.markerLed ? startsLower(lead.text) : true;
      if (resolved.contextFuse.has(word)) {
        const standalone = core.trimStart().length === trailing.length + 1;
        return contextFuses(word, trailing, standalone, lead);
      }
    }
  }
  const single = /(?:^|[\s(["'“‘])(\p{L})\.$/u.exec(core);
  if (single !== null) return singleLetterFuses(core, core.length - 2, lead);
  return false;
}

// Whether the boundary between `fragment` and `next` is false (the two
// belong to one sentence).
function fusesWithNext(fragment: string, next: string, resolved: ResolvedSplitter): boolean {
  const trimmed = fragment.trim();
  const lead = leadOf(next, resolved);
  // A lone list label joins the text it labels.
  if (LABEL_ONLY.test(trimmed)) return !lead.markerLed || startsLower(lead.text);
  const { core, hadClosers } = stripClosers(trimmed);
  // A quote or bracket closing after a terminator, followed by lower-case
  // text, is dialogue or an aside that continues: `"Is it ready?" she asked.`
  if (
    hadClosers &&
    !lead.markerLed &&
    TERMINATOR_CLASS.test(core[core.length - 1] ?? "") &&
    startsLower(lead.text)
  ) {
    return true;
  }
  return endsOnFalseBoundary(core, lead, resolved);
}

// Insert a space wherever a citation marker is glued directly to adjacent
// prose with no whitespace — glued to a following word ("]]The"), glued to a
// following word via a terminator ("]].The"), or glued to a PRECEDING
// terminator ("occasionally.[[cite:e1]]", also through closing quotes or
// brackets: `occasionally."[[cite:e1]]`). Left alone, any of these fuses two
// sentences into one and lets the second ride the first's citation — the core
// laundering vector this library exists to close. A placeholder glued to a
// preceding terminator gets the same space. Normal spacing ("sentence.
// [[cite:e1]] Next sentence.") is left untouched.
function normalizeMarkerAdjacency(text: string, resolved: ResolvedSplitter): string {
  type Site = { index: number; text: string; marker: boolean };
  const sites: Site[] = scanMarkers(text, resolved.marker).map((m) => ({
    index: m.index,
    text: m[0],
    marker: true,
  }));
  const placeholders = scanPlaceholders(text, resolved.placeholderGlobal);
  if (placeholders.length > 0) {
    for (const p of placeholders) sites.push({ index: p.index, text: p[0], marker: false });
    sites.sort((a, b) => a.index - b.index || Number(b.marker) - Number(a.marker));
  }
  let result = "";
  // The last character appended to `result`. Tracked separately because
  // indexing into a string built with `+=` flattens it every time, which made
  // this loop quadratic in the number of markers.
  let tail = "";
  let last = 0;
  for (const site of sites) {
    const start = site.index;
    if (start < last) continue; // overlaps a site already handled
    const end = start + site.text.length;
    const before = text.slice(last, start);
    result += before;
    if (before.length > 0) tail = before[before.length - 1];
    // Walk back over up to three closers inside `before` to find the
    // terminator they close.
    let k = start - 1;
    let closers = 0;
    while (k >= last && closers < 3 && CLOSER_CLASS.test(text[k])) {
      k--;
      closers++;
    }
    const terminatorBefore =
      closers === 0 ? TERMINATOR_CLASS.test(tail) : k >= last && TERMINATOR_CLASS.test(text[k]);
    if (terminatorBefore) result += " ";
    result += site.text;
    tail = site.text[site.text.length - 1];
    let cursor = end;
    if (site.marker) {
      const afterMarker = text[cursor] ?? "";
      if (TERMINATOR_CLASS.test(afterMarker)) {
        // A terminator immediately follows the marker (e.g. "]]."): keep it
        // attached, then check whether THAT is glued to the next word.
        result += afterMarker;
        tail = afterMarker;
        cursor += 1;
      }
      // Any script's letters/digits, tested by CODE POINT: a letter outside
      // the BMP is two UTF-16 units, and a lone surrogate is not a letter.
      const next = text.codePointAt(cursor);
      if (next !== undefined && LETTER_OR_DIGIT.test(String.fromCodePoint(next))) {
        result += " ";
        tail = " ";
      }
    }
    last = cursor;
  }
  return result + text.slice(last);
}

// --- markdown scaffolding ------------------------------------------------

type LineKind =
  | "blank"
  | "fence"
  | "rule"
  | "tableSeparator"
  | "tableRow"
  | "heading"
  | "listStart"
  | "quote"
  | "paragraph";

// A fence line: three or more backticks or tildes, then an info string. A
// backtick fence's info string cannot contain a backtick, so inline code at
// the start of a line ("```npm i``` installs it") is not a fence.
const FENCE = /^[ \t]{0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;
const HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const LIST_START =
  /^[ \t]*(?:[-*+•]|\d{1,3}[.)]|[A-Za-z][.)]|[IVXLCDM]{1,6}\.|\([A-Za-z0-9]{1,3}\))[ \t]+\S/;
const QUOTE = /^[ \t]*>/;

function lineKind(line: string): LineKind {
  if (BLANK.test(line)) return "blank";
  if (FENCE.test(line)) return "fence";
  if (RULE.test(line)) return "rule";
  if (line.includes("|") && line.includes("-") && /^[ \t|:-]+$/.test(line)) return "tableSeparator";
  if (TABLE_ROW.test(line)) return "tableRow";
  if (HEADING.test(line)) return "heading";
  if (LIST_START.test(line)) return "listStart";
  if (QUOTE.test(line)) return "quote";
  return "paragraph";
}

// A fence line's character, run length and whether it is bare (nothing after
// the run but spaces), or null when it is not a fence line.
function fenceInfo(line: string): { char: string; length: number; bare: boolean } | null {
  const m = FENCE.exec(line);
  if (m === null) return null;
  const run = m[1] ?? m[3];
  const info = m[2] ?? m[4];
  return { char: run[0], length: run.length, bare: info.trim() === "" };
}

// Whether a line (trimmed) is only a list label: "1.", "2)", "IV.", "Step 3.".
function isLoneLabel(line: string): boolean {
  return LABEL_ONLY.test(line.trim());
}

// Whether `text` contains a sentence terminator other than one final question
// mark. Used to decide that a heading, label or lead-in holds a statement.
function holdsStatement(text: string): boolean {
  const { core } = stripClosers(text.trimEnd());
  for (let i = 0; i < core.length; i++) {
    if (!TERMINATOR_CLASS.test(core[i])) continue;
    const isFinalQuestion = i === core.length - 1 && "?？؟⁇".includes(core[i]);
    if (!isFinalQuestion) return true;
  }
  return false;
}

function carriesCitation(text: string, resolved: ResolvedSplitter): boolean {
  return hasMarker(text, resolved) || hasPlaceholder(text, resolved);
}

// A heading's text without its opening hashes and optional closing hashes,
// found by scanning (an unanchored suffix regex was quadratic on long runs of
// spaces).
function headingText(line: string): string {
  let start = 0;
  while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
  while (start < line.length && line[start] === "#") start++;
  let end = line.length;
  while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  let hashes = end;
  while (hashes > start && line[hashes - 1] === "#") hashes--;
  if (hashes < end && (hashes === start || line[hashes - 1] === " " || line[hashes - 1] === "\t")) end = hashes;
  return line.slice(start, end);
}

// markdown: true only. A heading is a label unless it carries a marker or
// placeholder or holds a statement ("## Prices doubled in 2025.", "## Yes. It
// works").
function headingIsClaim(line: string, resolved: ResolvedSplitter): boolean {
  const text = headingText(line);
  return carriesCitation(text, resolved) || holdsStatement(text);
}

// markdown: true only. A line that is one emphasized phrase ("**Summary**",
// "**Battery:**", "*Note*") of six words or fewer, holding no statement,
// marker or placeholder. The phrase may not contain its own delimiter, so
// "**Battery:** lasts **40 hours**" is not a label.
function isEmphasisLabel(line: string, resolved: ResolvedSplitter): boolean {
  let text = line.trim();
  if (text.endsWith(":")) text = text.slice(0, -1).trimEnd();
  for (const delim of ["**", "__", "*", "_"]) {
    if (text.length <= delim.length * 2 || !text.startsWith(delim) || !text.endsWith(delim)) continue;
    const inner = text.slice(delim.length, text.length - delim.length);
    if (inner.includes(delim[0]) || /^\s/u.test(inner) || /\s$/u.test(inner)) return false;
    if (carriesCitation(inner, resolved) || holdsStatement(inner)) return false;
    return inner.trim().split(/\s+/).length <= 6;
  }
  return false;
}

// markdown: true only. A short line ending in a colon, holding no other
// terminator, that introduces a list, table or code block ("Here is what the
// policy says:").
function isLeadIn(line: string, nextKind: LineKind | undefined, resolved: ResolvedSplitter): boolean {
  if (nextKind !== "listStart" && nextKind !== "tableRow" && nextKind !== "fence") return false;
  const text = line.trim();
  if (!/[:：]$/u.test(text) || carriesCitation(text, resolved)) return false;
  if (holdsStatement(text.slice(0, -1))) return false;
  return text.split(/\s+/).length <= 10;
}

// markdown: true only. Whether `next` continues the sentence that `prevLine`
// (one wrapped line, not the whole block) left open: it starts in lower case,
// or the line before ends with a comma or a word such as "the", "of" or "and".
function continuesLine(prevLine: string, next: string): boolean {
  const text = next.trimStart();
  if (/^\p{Ll}/u.test(text)) return true;
  if (!/^[\p{L}\p{N}]/u.test(text)) return false;
  let end = prevLine.length;
  while (end > 0 && /\s/u.test(prevLine[end - 1])) end--;
  if (prevLine[end - 1] === ",") return true;
  let start = end;
  while (start > 0 && /\p{L}/u.test(prevLine[start - 1])) start--;
  return start < end && CONNECTORS.has(prevLine.slice(start, end).toLowerCase());
}

// Lines that are always scaffolding, whatever `markdown` says: they hold no
// letters or digits that could be a claim (a rule, a table separator row, a
// bare fence line) or only a list numeral ("1.").
function isAlwaysScaffolding(line: string, kind: LineKind): boolean {
  if (kind === "rule" || kind === "tableSeparator") return true;
  if (kind === "fence") return fenceInfo(line)?.bare === true;
  return isLoneLabel(line);
}

/**
 * Turn lines into text blocks for the sentence splitter. Lines that hold no
 * claim are always set aside. With `markdown: true`, headings, labels,
 * lead-ins, table header rows and fenced code are set aside too, and
 * hard-wrapped lines are joined.
 */
function prepareBlocks(text: string, resolved: ResolvedSplitter, nonClaims: string[]): string[] {
  // Default: lines end at "\n" only (a "\r\n" ending works too), as in 0.2.1.
  // A lone "\r" or U+2028/U+2029 also ends a line only with markdown: true,
  // because splitting there by default could turn an honest document that
  // 0.2.1 passed into a failing one.
  const lines = (resolved.markdown ? text.replace(LINE_BREAKS, "\n") : text).split("\n");
  const kinds = lines.map(lineKind);
  if (!resolved.markdown) {
    const blocks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (kinds[i] !== "blank" && isAlwaysScaffolding(lines[i], kinds[i])) nonClaims.push(lines[i].trim());
      else blocks.push(lines[i]);
    }
    return blocks;
  }

  // Fenced code: an opener needs a later bare closer of the same character
  // and at least the same length; otherwise it fences nothing. The longest
  // bare closer after each line is precomputed so pairing stays linear.
  const fences = lines.map(fenceInfo);
  const longestAfter = { "`": new Int32Array(lines.length + 1), "~": new Int32Array(lines.length + 1) };
  for (let i = lines.length - 1; i >= 0; i--) {
    longestAfter["`"][i] = longestAfter["`"][i + 1];
    longestAfter["~"][i] = longestAfter["~"][i + 1];
    const f = fences[i];
    if (f !== null && f.bare) {
      const table = longestAfter[f.char as "`" | "~"];
      table[i] = Math.max(table[i], f.length);
    }
  }
  const inFence = new Uint8Array(lines.length);
  const fenceBlocks = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const f = fences[i];
    if (f === null || longestAfter[f.char as "`" | "~"][i + 1] < f.length) continue;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const c = fences[j];
      if (c !== null && c.bare && c.char === f.char && c.length >= f.length) break;
    }
    // A block that carries a citation marker or placeholder is not set
    // aside: its citations must still be judged (an unknown id inside it has
    // to make the document unclean). Its lines are read as ordinary lines.
    let cited = false;
    for (let k = i + 1; k < j && !cited; k++) cited = carriesCitation(lines[k], resolved);
    if (!cited) {
      inFence.fill(1, i, j + 1);
      fenceBlocks.set(i, lines.slice(i, j + 1).join("\n"));
    }
    i = j;
  }

  const blocks: string[] = [];
  let current: string | null = null;
  let currentLastLine = "";
  let currentKind: LineKind | null = null;
  const flush = () => {
    if (current !== null) blocks.push(current);
    current = null;
    currentKind = null;
  };
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i] === 1) {
      flush();
      const block = fenceBlocks.get(i);
      if (block !== undefined) nonClaims.push(block);
      continue;
    }
    const line = lines[i];
    const kind = kinds[i];
    if (kind === "blank") {
      flush();
      continue;
    }
    if (isAlwaysScaffolding(line, kind)) {
      flush();
      nonClaims.push(line.trim());
      continue;
    }
    if (kind === "fence" || kind === "tableRow") {
      // An unpaired fence line with an info string, or a table row: a claim
      // of its own. A table's header (its first row, right above a
      // separator) is set aside unless it carries a citation or a statement.
      flush();
      const header =
        kind === "tableRow" &&
        kinds[i + 1] === "tableSeparator" &&
        inFence[i + 1] === 0 &&
        (i === 0 || kinds[i - 1] !== "tableRow");
      if (header && !carriesCitation(line, resolved) && !holdsStatement(line.replace(/\|/g, " "))) {
        nonClaims.push(line.trim());
      } else blocks.push(line);
      continue;
    }
    if (kind === "heading") {
      flush();
      if (headingIsClaim(line, resolved)) blocks.push(line);
      else nonClaims.push(line.trim());
      continue;
    }
    let nextKind: LineKind | undefined;
    if (/[:：]\s*$/u.test(line)) {
      for (let k = i + 1; k < lines.length; k++) {
        if (kinds[k] !== "blank") {
          nextKind = kinds[k];
          break;
        }
      }
    }
    if (
      isEmphasisLabel(line, resolved) ||
      (kind === "paragraph" && current === null && isLeadIn(line, nextKind, resolved))
    ) {
      flush();
      nonClaims.push(line.trim());
      continue;
    }
    const joinable =
      current !== null &&
      (kind === "paragraph" || (kind === "quote" && currentKind === "quote")) &&
      continuesLine(currentLastLine, kind === "quote" ? line.replace(QUOTE, "") : line);
    if (joinable) {
      current = `${current as string} ${line.trim()}`;
    } else {
      flush();
      current = line;
      currentKind = kind;
    }
    currentLastLine = line;
  }
  flush();
  return blocks;
}

// --- clause splitting ----------------------------------------------------

// Whether a fragment is "citation only": stripping its markers leaves no
// prose — the model (or an editor) emitted the marker AFTER the terminal
// period on its own. Such a fragment must reattach to the preceding sentence,
// or that sentence reads as ungrounded even though it was cited.
function isCitationOnly(fragment: string, marker: RegExp): boolean {
  const matches = scanMarkers(fragment, marker);
  if (matches.length === 0) return false;
  let rest = "";
  let last = 0;
  for (const m of matches) {
    rest += fragment.slice(last, m.index);
    last = m.index + m[0].length;
  }
  rest += fragment.slice(last);
  // Any script's letters/digits count as real content.
  return !LETTER_OR_DIGIT.test(rest);
}

// A fragment can BEGIN with citation markers or placeholders that actually
// terminate the PREVIOUS sentence ("...occasionally. [[cite:e1]] The
// claimant lost $500,000."). The split orphans them onto the FOLLOWING
// fragment, where a marker would falsely ground it (the laundering vector
// that lets a fabricated, uncited claim ride an earlier citation) and a
// placeholder would mislabel it as the honest gap. Peel them off so the
// caller can reattach them to the sentence they terminate. Invisible
// characters in front of a marker count as leading space: the reader sees the
// marker at the start, so it is peeled, and the invisible characters travel
// with it.
function peelLeading(
  fragment: string,
  resolved: ResolvedSplitter,
): { peeled: Array<{ text: string; placeholder: boolean }>; rest: string } {
  let rest = fragment.trimStart();
  const peeled: Array<{ text: string; placeholder: boolean }> = [];
  for (;;) {
    const lead = invisibleRunEnd(rest, 0);
    let len = markerAt(rest, lead, resolved);
    let placeholder = false;
    if (len === 0) {
      len = placeholderAt(rest, lead, resolved);
      if (len === 0) break;
      placeholder = true;
    }
    peeled.push({ text: rest.slice(0, lead + len), placeholder });
    rest = rest.slice(lead + len).trimStart();
  }
  return { peeled, rest };
}

// Whether a unit shows nothing to a reader: empty, or only whitespace,
// invisible and control characters. Such a unit is not a claim, so it is never
// emitted.
function isBlank(unit: string): boolean {
  return BLANK.test(unit);
}

const HTML_ENTITY_BEFORE = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6})$/;

// Split ONE sentence into clause-level grounding units on ';', an em-dash, or
// (only when the clause before it already carries a citation) a colon or a
// dash separator ("–", "--", " - "). Bracket-aware via MATCHED-pair
// tracking: a separator inside a real `[ ... ]` span
// (or inside whatever the marker/placeholder patterns match, even if they
// don't use brackets) is never a split point — but an UNbalanced bracket
// cannot suppress later splits, so bracket handling fails CLOSED rather than
// silently swallowing the rest of the sentence.
function splitGroundingUnits(sentence: string, resolved: ResolvedSplitter): string[] {
  const n = sentence.length;
  // Shielded ranges go into a difference array: +1 where a range starts, -1
  // just past where it ends. A running sum over it (below) says how many
  // ranges cover each position, so a position is shielded exactly when the sum
  // is above zero. Marking a range is O(1) however long or deeply nested it
  // is; repainting every position of every matched pair was quadratic on
  // "[[[...x...]]]".
  const cover = new Int32Array(n + 1);
  const openStack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (sentence[i] === "[") {
      openStack.push(i);
    } else if (sentence[i] === "]" && openStack.length > 0) {
      const open = openStack.pop()!;
      cover[open] += 1;
      cover[i + 1] -= 1;
    }
  }
  // Also shield whatever the marker/placeholder regexes match directly, in
  // case a caller's marker syntax doesn't use brackets at all (e.g.
  // "{{ref:id}}"). While scanning marker matches, record each match's END
  // offset into a prefix-count array: the cited-separator check below needs
  // to know "does the pending clause contain a marker?" in O(1).
  const markerEndCounts = new Uint32Array(n + 1);
  for (const m of scanMarkers(sentence, resolved.marker)) {
    const start = m.index;
    const end = start + m[0].length;
    cover[start] += 1;
    cover[end] -= 1;
    markerEndCounts[end] += 1;
  }
  for (const m of scanPlaceholders(sentence, resolved.placeholderGlobal)) {
    cover[m.index] += 1;
    cover[m.index + m[0].length] -= 1;
  }
  for (let i = 1; i <= n; i++) markerEndCounts[i] += markerEndCounts[i - 1];

  const isDigit = (c: string | undefined) => c != null && c >= "0" && c <= "9";
  const isSpace = (c: string | undefined) => c == null || /\s/u.test(c);
  const units: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < n; i++) {
    depth += cover[i];
    if (depth > 0) continue;
    const ch = sentence[i];
    // markerEndCounts[i] - markerEndCounts[start] counts marker matches that
    // end inside the pending clause. Markers can't straddle an accepted split
    // point (a split point is never inside a marker match), so this is
    // exactly "the pending clause contains a marker".
    const cited = markerEndCounts[i] - markerEndCounts[start] > 0;
    let width = 0;
    if (ch === ";" || ch === "；") {
      // "&amp;" and "&#39;" end in a semicolon that is not a clause break.
      if (!HTML_ENTITY_BEFORE.test(sentence.slice(Math.max(0, i - 33), i))) width = 1;
    } else if (ch === "—") {
      width = 1;
    } else if (cited) {
      if (ch === ":" || ch === "：") {
        // A colon splits ONLY when the clause BEFORE it already carries a
        // citation: the laundering vector is a cite reaching FORWARD across
        // it. A leading uncited label ("Results: ... [[cite:e1]]") stays
        // intact, like an accepted comma-join. Numeric colons (time "9:30",
        // ratio "3:1") and a URL scheme ("https://") are never boundaries.
        const numeric = isDigit(sentence[i - 1]) && isDigit(sentence[i + 1]);
        const url = sentence[i + 1] === "/" && sentence[i + 2] === "/";
        if (!numeric && !url) width = 1;
      } else if (ch === "–" || ch === "―") {
        // An en dash between digits is a range ("2020–2025"), never a break.
        if (!(isDigit(sentence[i - 1]) && isDigit(sentence[i + 1]))) width = 1;
      } else if (ch === "-") {
        let run = 1;
        while (sentence[i + run] === "-") run++;
        if (run >= 2) width = run;
        else if (isSpace(sentence[i - 1]) && isSpace(sentence[i + 1])) width = 1;
      }
    }
    if (width > 0) {
      const unit = sentence.slice(start, i).trim();
      if (!isBlank(unit)) units.push(unit);
      for (let k = 1; k < width; k++) depth += cover[i + k];
      i += width - 1;
      start = i + 1;
    }
  }
  const last = sentence.slice(start).trim();
  if (!isBlank(last)) units.push(last);
  return units;
}

/** @internal The units of a document, plus the markdown scaffolding set aside as non-claims. */
export interface SplitResult {
  units: string[];
  nonClaims: string[];
}

/** @internal split with an already-resolved configuration. */
export function splitResolved(text: string, resolved: ResolvedSplitter): SplitResult {
  // One scan of the whole text up front, so a marker pattern that matches
  // zero characters throws even where the text is set aside as markdown
  // scaffolding or is empty.
  scanMarkers(text, resolved.marker);
  const nonClaims: string[] = [];
  const sentences: string[] = [];
  // Sentences that open a line block. A placeholder at the start of one
  // belongs to the text after it, not to the previous line.
  const blockStarts = new Set<number>();
  let atBlockStart = true;
  const pushSentence = (raw: string) => {
    const trimmed = raw.trim();
    if (isBlank(trimmed)) return;
    if (atBlockStart) blockStarts.add(sentences.length);
    atBlockStart = false;
    sentences.push(trimmed);
  };
  for (const block of prepareBlocks(text, resolved, nonClaims)) {
    atBlockStart = true;
    // A default-ignorable character right after a terminator (and its
    // closers) would keep the boundary regex from seeing "terminator,
    // whitespace" and fuse two sentences without a visible trace. A real
    // space in front of it restores the boundary.
    const separated = block.replace(TERMINATOR_THEN_INVISIBLE, "$1 ");
    const normalized = normalizeMarkerAdjacency(separated, resolved);
    const parts = normalized.split(SENTENCE_BOUNDARY);
    let buffer = "";
    for (let i = 0; i < parts.length; i++) {
      buffer = buffer ? `${buffer} ${parts[i]}` : parts[i];
      // fusesWithNext only inspects the end of `parts[i]` and the start of
      // `parts[i + 1]`, never the whole (possibly long) buffer, so the loop
      // stays linear over a long run of fused fragments.
      if (i + 1 >= parts.length || !fusesWithNext(parts[i], parts[i + 1], resolved)) {
        pushSentence(buffer);
        buffer = "";
      }
    }
  }

  // Clause-level split so an uncited clause can't ride a cited one inside the
  // same sentence. Erring toward more units is safe: it fails closed (flags
  // for a citation), it never launders.
  const units: string[] = [];
  const unitStartsBlock: boolean[] = [];
  sentences.forEach((sentence, index) => {
    splitGroundingUnits(sentence, resolved).forEach((unit, k) => {
      units.push(unit);
      unitStartsBlock.push(k === 0 && blockStarts.has(index));
    });
  });

  // Reattach orphaned citation markers and placeholders to the unit they
  // belong to.
  const merged: string[] = [];
  for (let u = 0; u < units.length; u++) {
    const unit = units[u];
    const { peeled, rest } = peelLeading(unit, resolved);
    if (peeled.length > 0) {
      const firstPlaceholder = peeled.findIndex((item) => item.placeholder);
      if (merged.length > 0 && unitStartsBlock[u] && firstPlaceholder >= 0) {
        // A placeholder that opens a line covers that line: markers before
        // it still go back to the previous unit, the rest stays together.
        const markers = peeled.slice(0, firstPlaceholder).map((item) => item.text);
        if (markers.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]} ${markers.join(" ")}`;
        const kept = [...peeled.slice(firstPlaceholder).map((item) => item.text), rest].join(" ").trim();
        if (!isBlank(kept)) merged.push(kept);
        continue;
      }
      if (merged.length > 0) {
        // They sat after the PREVIOUS unit's terminal period.
        const group = peeled.map((item) => item.text).join(" ");
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${group}`;
        // Only a remainder that shows nothing is dropped; non-Latin text and
        // bare punctuation are kept as their own unit.
        if (!isBlank(rest)) merged.push(rest);
      } else {
        // Nothing before them. A marker grounds nothing and is dropped; from
        // the first placeholder on, the unit is kept whole, so a gap marker
        // written in front of its sentence still covers it.
        const first = peeled.findIndex((item) => item.placeholder);
        const kept =
          first < 0 ? rest : [...peeled.slice(first).map((item) => item.text), rest].join(" ");
        if (!isBlank(kept)) merged.push(kept.trim());
      }
      continue;
    }
    // Trailing citation-only fragment (marker after the period, on its own).
    if (merged.length > 0 && isCitationOnly(unit, resolved.marker)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${unit}`;
      continue;
    }
    merged.push(unit);
  }
  return { units: merged, nonClaims };
}

/**
 * Split `text` into sentence-ish grounding units, keeping citation markers
 * attached to the unit they actually ground (never a following clause or
 * sentence). Hardened against:
 *  - abbreviation periods that don't end a sentence (configurable list)
 *  - a citation marker glued to punctuation/prose with no whitespace
 *  - non-ASCII sentence terminators (。．！？…‼।॥؟۔)
 *  - a marker or placeholder sitting right after a period, even behind
 *    closing quotes, brackets or bold, which would otherwise be read as
 *    belonging to the sentence that follows it (leading-marker peeling)
 *  - clause-internal fabrications riding a citation elsewhere in the sentence
 *    (semicolon/em-dash splitting, and colon/dash splitting after a cited
 *    clause)
 *  - malformed/unbalanced brackets (fails closed: never suppresses a split)
 *  - invisible (default-ignorable) characters placed between a terminator and
 *    the text or marker after it, which would hide a sentence boundary
 *
 * Markdown scaffolding (see `SplitterConfig.markdown`) is not returned. A unit
 * made only of whitespace and invisible characters is dropped, never
 * returned. Work is linear in the length of `text` for the default patterns.
 * A caller-supplied pattern can still be slow if its own regex backtracks
 * badly; that is the caller's configuration.
 *
 * @throws {TypeError} if `text` is not a string, `config` is not a plain
 *   object or has an unknown key, or an option has the wrong type
 *   (`abbreviations` lists must be dense arrays of strings made of letters
 *   and dots; the patterns must be `RegExp`s; `markdown` must be a boolean).
 * @throws {GroundingConfigError} if `markerPattern` matches zero characters
 *   anywhere it is scanned.
 */
export function splitSentences(text: string, config: SplitterConfig = {}): string[] {
  assertString(text, "text");
  return splitResolved(text, resolveSplitterConfig(config)).units;
}

/**
 * Every citation marker id referenced in `sentence`, in appearance order
 * (duplicates kept).
 *
 * @throws {TypeError} if `sentence` is not a string or `markerPattern` is not
 *   a `RegExp`.
 * @throws {GroundingConfigError} if `markerPattern` matches zero characters.
 */
export function extractCitedIds(
  sentence: string,
  markerPattern: RegExp = DEFAULT_MARKER_PATTERN,
): string[] {
  assertString(sentence, "sentence");
  return citedIdsOf(sentence, globalCopy(markerPattern, "markerPattern"));
}

/** @internal ids from a private, already-normalized marker regex. */
export function citedIdsOf(sentence: string, marker: RegExp): string[] {
  const ids: string[] = [];
  for (const m of scanMarkers(sentence, marker)) {
    if (m[1] !== undefined) ids.push(m[1]);
  }
  return ids;
}

/** @internal one marker match: its id (if the pattern captured one) and where it sits. */
export interface MarkerSite {
  id: string | undefined;
  start: number;
  end: number;
}

/** @internal every marker in `sentence` with its position. */
export function markerSitesOf(sentence: string, marker: RegExp): MarkerSite[] {
  return scanMarkers(sentence, marker).map((m) => ({
    id: m[1],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Every distinct citation marker id referenced anywhere in `text`,
 * first-appearance order.
 *
 * @throws {TypeError} if `text` is not a string or `markerPattern` is not a
 *   `RegExp`.
 * @throws {GroundingConfigError} if `markerPattern` matches zero characters.
 */
export function extractAllCitedIds(
  text: string,
  markerPattern: RegExp = DEFAULT_MARKER_PATTERN,
): string[] {
  assertString(text, "text");
  return [...new Set(citedIdsOf(text, globalCopy(markerPattern, "markerPattern")))];
}

/**
 * Remove citation markers for display/export. Only the text at each marker
 * site changes: a marker (or a run of markers separated by spaces or tabs) is
 * removed together with the spaces and tabs around it, and replaced by one
 * space when there was space on either side or when it sat between two
 * letters or digits ("word[[cite:e1]]word" -> "word word"), or by nothing
 * when it sat before punctuation, a line break or the end of the text
 * ("reach [[cite:e1]]." -> "reach."). Everything else, including spacing
 * elsewhere in the text, is returned exactly as given.
 *
 * @throws {TypeError} if `text` is not a string or `markerPattern` is not a
 *   `RegExp`.
 * @throws {GroundingConfigError} if `markerPattern` matches zero characters.
 */
export function stripCitationMarkers(
  text: string,
  markerPattern: RegExp = DEFAULT_MARKER_PATTERN,
): string {
  assertString(text, "text");
  return stripMarkersOf(text, globalCopy(markerPattern, "markerPattern"));
}

const SPACE_OR_TAB = (c: string | undefined) => c === " " || c === "\t";
const TIGHT_BEFORE = /[.,;:!?)\]}”’"'»。．！？、，；：）]/u;

/** @internal marker removal with a private, already-normalized marker regex. */
export function stripMarkersOf(text: string, marker: RegExp): string {
  const matches = scanMarkers(text, marker);
  if (matches.length === 0) return text;
  let out = "";
  let last = 0;
  let i = 0;
  while (i < matches.length) {
    const start = matches[i].index;
    let end = start + matches[i][0].length;
    let j = i + 1;
    // Group markers separated only by spaces or tabs into one site.
    while (j < matches.length) {
      let k = end;
      while (k < matches[j].index && SPACE_OR_TAB(text[k])) k++;
      if (k !== matches[j].index) break;
      end = matches[j].index + matches[j][0].length;
      j++;
    }
    let left = start;
    while (left > last && SPACE_OR_TAB(text[left - 1])) left--;
    let right = end;
    while (right < text.length && SPACE_OR_TAB(text[right])) right++;
    const before = left > 0 ? text[left - 1] : "";
    const after = right < text.length ? text[right] : "";
    let joiner = "";
    if (after === "" || after === "\n" || after === "\r" || TIGHT_BEFORE.test(after)) joiner = "";
    else if (before === "" || before === "\n" || before === "\r") joiner = "";
    else if (left < start || right > end) joiner = " ";
    else if (LETTER_OR_DIGIT.test(before) && LETTER_OR_DIGIT.test(after)) joiner = " ";
    out += text.slice(last, left) + joiner;
    last = right;
    i = j;
  }
  return out + text.slice(last);
}

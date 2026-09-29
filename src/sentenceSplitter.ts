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
  assertPlainObject,
  assertString,
  describe,
  readStringList,
} from "./validate.js";

/** Controls which trailing periods do NOT end a sentence. */
export interface AbbreviationConfig {
  /**
   * Abbreviations that ALWAYS attach to the token that follows them, so a
   * period after one of these can never end a sentence (e.g. honorifics:
   * "Dr. Vance" must not split into "Dr." + "Vance").
   */
  alwaysFuse: readonly string[];
  /**
   * Abbreviations that CAN legitimately end a sentence (list-enders, unit
   * suffixes). They only fuse with what follows when the next fragment
   * continues in lower-case or a digit ("Corp. filed the report" ends the
   * sentence; "Corp. reserves the right" does not, but "no. 2 on the list"
   * does not end at "no.").
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
    // abbreviations ("9 a.m.", "the U.S."), and only contextFuse's
    // next-fragment check (capitalized = real sentence end, lower-case/digit
    // = continues) tells the two apart. alwaysFuse has no such check, so it
    // would unconditionally fuse "I am." into whatever follows it, silently
    // swallowing a real sentence end.
    "am", "pm", "us",
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
 * Default convention: `[[cite:id]]`. Bring your own for e.g. `[1]`,
 * `{{ref:id}}`, or whatever your generator already emits.
 */
export const DEFAULT_MARKER_PATTERN = /\[\[cite:\s*([a-zA-Z0-9_-]+)\s*\]\]/g;

/**
 * Regex matching an explicit "I don't have a source for this" placeholder —
 * the honest alternative to inventing a citation. Default recognizes a few
 * common bracketed conventions ("[citation needed]", "[TK]"), with up to 200
 * characters of note before the closing bracket. The 200-character cap keeps
 * a long run of unclosed "[TK" from making the scan quadratic; a longer note
 * is not recognized as a placeholder, so that sentence is classified by its
 * citations instead (fail closed). Bring your own to match whatever
 * gap-marker your prompt asks the model to emit.
 */
export const DEFAULT_PLACEHOLDER_PATTERN =
  /\[(?:citation needed|more research needed|TK)[^\]]{0,200}\]/i;

/**
 * Options for `splitSentences` (and, via `ClassifyConfig`, for
 * `classifySentence`/`classifyDocument`). Every field is optional; an
 * omitted field falls back to its `DEFAULT_*` export.
 */
export interface SplitterConfig {
  /** Replaces `DEFAULT_ABBREVIATIONS` entirely (does not merge with it). */
  abbreviations?: AbbreviationConfig;
  /** Replaces `DEFAULT_MARKER_PATTERN`. Must have exactly one capture group. */
  markerPattern?: RegExp;
  /** Replaces `DEFAULT_PLACEHOLDER_PATTERN`. */
  placeholderPattern?: RegExp;
}

const TERMINATOR_CLASS = /[.!?。．！？]/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// Whitespace plus characters a renderer draws as nothing (zero-width space and
// joiners, word joiner, soft hyphen, every bidi control, variation selectors,
// Hangul fillers, ...). `\s` alone misses them, so text that LOOKS like
// "period, space, marker" could hide its boundary behind one.
const INVISIBLE_LEAD = /^[\s\p{Default_Ignorable_Code_Point}]*/u;
const BLANK = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]*$/u;
const TERMINATOR_THEN_INVISIBLE = /([.!?。．！？])(?=\p{Default_Ignorable_Code_Point})/gu;

// --- regex hygiene -----------------------------------------------------
// Every scan below runs on a private copy of the caller's regex, built ONCE
// per public call. Global regexes carry mutable lastIndex state, and a sticky
// one only matches at lastIndex, so sharing the caller's object (or keeping
// its `y` flag) is a source of "works on the first document, silently breaks
// on the second" bugs, and of a sticky marker that never sees a citation past
// the start of the text. The copy is always global and never sticky.
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
      throw new GroundingConfigError(
        `markerPattern matched zero characters at index ${String(m.index)}; a marker must match at least one character.`,
      );
    }
    matches.push(m);
  }
}

// `text` with the given (ordered, non-overlapping) matches cut out.
function removeMatches(text: string, matches: readonly RegExpExecArray[]): string {
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

// The placeholder pattern is used two ways: a global copy to find every
// placeholder while splitting, and a non-global, non-sticky copy for the
// per-sentence `.test` (a global or sticky regex would carry `lastIndex`
// from one sentence to the next).
function placeholderCopies(value: unknown): { global: RegExp; plain: RegExp } {
  const { source, flags } = copyPattern(value, "placeholderPattern");
  const kept = flags.replace(/[gy]/g, "");
  return { global: new RegExp(source, `${kept}g`), plain: new RegExp(source, kept) };
}

/** A splitter configuration read once and validated: private regex copies and dense, lower-cased word sets. */
export interface ResolvedSplitter {
  alwaysFuse: Set<string>;
  contextFuse: Set<string>;
  marker: RegExp;
  placeholderGlobal: RegExp;
  placeholderTest: RegExp;
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
}): ResolvedSplitter {
  const abbreviations = options.abbreviations ?? DEFAULT_ABBREVIATIONS;
  assertPlainObject(abbreviations, "abbreviations");
  const alwaysFuse = readStringList(abbreviations.alwaysFuse, "abbreviations.alwaysFuse");
  const contextFuse = readStringList(abbreviations.contextFuse, "abbreviations.contextFuse");
  const markerPattern = options.markerPattern ?? DEFAULT_MARKER_PATTERN;
  const placeholderPattern = options.placeholderPattern ?? DEFAULT_PLACEHOLDER_PATTERN;
  const placeholder = placeholderCopies(placeholderPattern);
  return {
    alwaysFuse: new Set(alwaysFuse.map((w) => w.toLowerCase())),
    contextFuse: new Set(contextFuse.map((w) => w.toLowerCase())),
    marker: globalCopy(markerPattern, "markerPattern"),
    placeholderGlobal: placeholder.global,
    placeholderTest: placeholder.plain,
  };
}

function resolveSplitterConfig(config: unknown): ResolvedSplitter {
  assertPlainObject(config, "config");
  const source = config;
  return resolveSplitter({
    abbreviations: source.abbreviations,
    markerPattern: source.markerPattern,
    placeholderPattern: source.placeholderPattern,
  });
}

// Insert a space wherever a citation marker is glued directly to adjacent
// prose with no whitespace — glued to a following word ("]]The"), glued to a
// following word via a terminator ("]].The"), or glued to a PRECEDING
// terminator ("occasionally.[[cite:e1]]"). Left alone, any of these fuses two
// sentences into one and lets the second ride the first's citation — the core
// laundering vector this library exists to close. Normal spacing
// ("sentence. [[cite:e1]] Next sentence.") is left untouched.
function normalizeMarkerAdjacency(text: string, marker: RegExp): string {
  let result = "";
  // The last character appended to `result`. Tracked separately because
  // indexing into a string built with `+=` flattens it every time, which made
  // this loop quadratic in the number of markers.
  let tail = "";
  let last = 0;
  for (const m of scanMarkers(text, marker)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = text.slice(last, start);
    result += before;
    if (before.length > 0) tail = before[before.length - 1];
    if (TERMINATOR_CLASS.test(tail)) {
      result += " ";
    }
    result += m[0];
    tail = m[0][m[0].length - 1];
    let cursor = end;
    const afterMarker = text[cursor] ?? "";
    if (TERMINATOR_CLASS.test(afterMarker)) {
      // A terminator immediately follows the marker (e.g. "]]."): keep it
      // attached, then check whether THAT is glued to the next word.
      result += afterMarker;
      tail = afterMarker;
      cursor += 1;
    }
    // \p{L}\p{N} (any script's letters/digits), not the ASCII-only
    // [A-Za-z0-9]: a marker glued directly to non-Latin prose ("[[cite:e1]]
    // こんにちは") needs the same normalizing space as one glued to English.
    // The next CODE POINT is tested, not the next UTF-16 unit: a letter
    // outside the BMP (for example a CJK Extension B ideograph) is two units,
    // and a lone surrogate is not a letter.
    const next = text.codePointAt(cursor);
    if (next !== undefined && LETTER_OR_DIGIT.test(String.fromCodePoint(next))) {
      result += " ";
      tail = " ";
    }
    last = cursor;
  }
  return result + text.slice(last);
}

// The trailing word of a fragment that ends in ".": the run of letters and
// dots immediately before the final period, starting at its first letter. It
// is the same text as /([A-Za-z][A-Za-z.]*)\.$/ captures, found in one
// backward scan. The regex retried its unbounded `*` from every start
// position when the run was followed by a character outside the class, which
// was quadratic on input like "aaaa...a1.".
function trailingWord(trimmed: string): string | null {
  let first = -1;
  for (let i = trimmed.length - 2; i >= 0; i--) {
    const c = trimmed.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) first = i;
    else if (c !== 46) break;
  }
  return first < 0 ? null : trimmed.slice(first, trimmed.length - 1);
}

// Whether a fragment's trailing period is a FALSE boundary (does not end the
// sentence). `next` is the fragment that would follow; it decides the
// context-sensitive abbreviations.
function endsOnFalseBoundary(
  fragment: string,
  next: string | undefined,
  alwaysFuse: Set<string>,
  contextFuse: Set<string>,
): boolean {
  const trimmed = fragment.trimEnd();
  // Both checks below require a trailing literal ".": abbreviation fusion is
  // a period-only concept (see AbbreviationConfig's doc comment) and never
  // applies to "!", "?", or a non-ASCII terminator. Bailing out here when
  // there isn't one is also a required *performance* guard, not just a
  // shortcut.
  if (!trimmed.endsWith(".")) return false;
  // A single letter is a name initial ("Dana M. Whitfield") only when it
  // stands alone. A letter glued to a number/currency ("$9M.") is a unit that
  // really ends the sentence.
  if (/(?:^|\s)[A-Za-z]\.$/.test(trimmed)) return true;
  const trailing = trailingWord(trimmed);
  if (trailing === null) return false;
  const word = trailing.replace(/\./g, "").toLowerCase();
  if (alwaysFuse.has(word)) return true;
  if (contextFuse.has(word)) {
    // No following fragment -> a real sentence end. A capitalized next
    // fragment starts a new sentence; lower-case or a digit continues this one.
    return next != null && !/^[A-Z]/.test(next.trimStart());
  }
  return false;
}

// A fragment is "citation only" when stripping its markers leaves no prose —
// the model (or an editor) emitted the marker AFTER the terminal period on
// its own. Such a fragment must reattach to the preceding sentence, or that
// sentence reads as ungrounded even though it was cited.
function isCitationOnly(fragment: string, marker: RegExp): boolean {
  const matches = scanMarkers(fragment, marker);
  if (matches.length === 0) return false;
  // \p{L}\p{N} (any script), not [A-Za-z0-9]: prose in Japanese, Arabic,
  // Cyrillic, etc. must count as "real content" here too, or a non-Latin
  // sentence sitting next to a citation marker gets misread as pure
  // leftover punctuation and silently absorbed into the previous sentence.
  return !LETTER_OR_DIGIT.test(removeMatches(fragment, matches));
}

// A fragment can BEGIN with citation markers that actually terminate the
// PREVIOUS sentence ("...occasionally. [[cite:e1]] The claimant lost
// $500,000."). The split orphans those markers onto the FOLLOWING fragment,
// where they would falsely ground it — the laundering vector that lets a
// fabricated, uncited claim ride an earlier citation. Peel any leading
// markers off so the caller can reattach them to the sentence they actually
// terminate. A citation can only ground prose that precedes or surrounds it
// within the SAME sentence. Invisible characters (zero-width space, bidi
// controls, ...) in front of a marker count as leading space: the reader sees
// the marker at the start, so it is peeled, and the invisible characters
// travel with it.
function peelLeadingMarkers(
  fragment: string,
  marker: RegExp,
): { markers: string; rest: string } {
  let rest = fragment.trimStart();
  const collected: string[] = [];
  for (;;) {
    const lead = (INVISIBLE_LEAD.exec(rest) as RegExpExecArray)[0].length;
    marker.lastIndex = 0;
    const m = marker.exec(rest);
    if (m === null) break;
    if (m[0].length === 0) {
      marker.lastIndex = 0;
      throw new GroundingConfigError(
        `markerPattern matched zero characters at index ${String(m.index)}; a marker must match at least one character.`,
      );
    }
    if (m.index !== lead) break;
    const end = lead + m[0].length;
    collected.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  marker.lastIndex = 0;
  return { markers: collected.join(" "), rest };
}

// Whether a unit shows nothing to a reader: empty, or only whitespace,
// invisible and control characters. Such a unit is not a claim, so it is never
// emitted.
function isBlank(unit: string): boolean {
  return BLANK.test(unit);
}

// Split ONE sentence into clause-level grounding units on ';', an em-dash, or
// a colon that introduces a new clause. Bracket-aware via MATCHED-pair
// tracking: a separator inside a real `[ ... ]` span (or inside whatever the
// marker/placeholder patterns match, even if they don't use square brackets)
// is never a split point — but an UNbalanced '[' cannot suppress later
// splits, so bracket handling fails CLOSED rather than silently swallowing
// the rest of the sentence.
function splitGroundingUnits(sentence: string, resolved: ResolvedSplitter): string[] {
  const n = sentence.length;
  // Shielded ranges go into a difference array: +1 where a range starts, -1
  // just past where it ends. A running sum over it (below) says how many
  // ranges cover each position, so a position is shielded exactly when the sum
  // is above zero. Marking a range is O(1) however long or deeply nested it
  // is; repainting every position of every matched pair, as the code did
  // before, was quadratic on "[[[...x...]]]".
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
  // Belt-and-suspenders: also shield whatever the marker/placeholder regexes
  // match directly, in case a caller's marker syntax doesn't use brackets at
  // all (e.g. "{{ref:id}}"). While scanning marker matches, also record each
  // match's END offset into a prefix-count array: the colon-boundary check
  // below needs to know "does the pending clause contain a marker?" at every
  // ':', and re-slicing + re-testing the (growing) pending clause from
  // scratch each time is O(n) per query — O(n^2) overall on a long,
  // marker-free, colon-heavy input. A prefix count answers the same question
  // in O(1) per query.
  const markerEndCounts = new Uint32Array(n + 1);
  for (const m of scanMarkers(sentence, resolved.marker)) {
    const start = m.index;
    const end = start + m[0].length;
    cover[start] += 1;
    cover[end] -= 1;
    markerEndCounts[end] += 1;
  }
  for (const m of sentence.matchAll(resolved.placeholderGlobal)) {
    const start = m.index;
    const end = start + m[0].length;
    cover[start] += 1;
    cover[end] -= 1;
  }
  for (let i = 1; i <= n; i++) markerEndCounts[i] += markerEndCounts[i - 1];

  const isDigit = (c: string | undefined) => c != null && c >= "0" && c <= "9";
  const units: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < n; i++) {
    depth += cover[i];
    if (depth > 0) continue;
    const ch = sentence[i];
    // Split a colon ONLY when the clause BEFORE it already carries a
    // citation. The laundering vector is a cite reaching FORWARD across the
    // colon to ground an uncited clause; requiring a marker in the pending
    // clause catches exactly that. A leading uncited label ("Results: ...
    // [[cite:e1]]") is left intact, behaving like an accepted comma-join.
    // Numeric colons (time "9:30", ratio "3:1") are never boundaries.
    // markerEndCounts[i] - markerEndCounts[start] is the number of marker
    // matches whose end offset falls in (start, i] — i.e. a marker fully
    // inside the pending clause. Markers can't straddle an accepted split
    // point (a split point is never `inside` a marker match), so this is
    // exactly equivalent to "the pending clause contains a marker."
    const isColonBoundary =
      ch === ":" &&
      !(isDigit(sentence[i - 1]) && isDigit(sentence[i + 1])) &&
      markerEndCounts[i] - markerEndCounts[start] > 0;
    if (ch === ";" || ch === "—" || isColonBoundary) {
      const unit = sentence.slice(start, i).trim();
      if (!isBlank(unit)) units.push(unit);
      start = i + 1;
    }
  }
  const last = sentence.slice(start).trim();
  if (!isBlank(last)) units.push(last);
  return units;
}

/** @internal split with an already-resolved configuration. */
export function splitResolved(text: string, resolved: ResolvedSplitter): string[] {
  const { alwaysFuse, contextFuse } = resolved;
  // A default-ignorable character right after a terminator would keep the
  // boundary regex below from seeing "terminator, whitespace" and fuse two
  // sentences (or a marker's sentence and the next) without a visible trace.
  // A real space in front of it restores the boundary.
  const separated = text.replace(TERMINATOR_THEN_INVISIBLE, "$1 ");
  const normalized = normalizeMarkerAdjacency(separated, resolved.marker);

  const sentences: string[] = [];
  for (const line of normalized.split("\n")) {
    // Split on ASCII terminators followed by whitespace, AND on non-ASCII
    // full stops (they may carry no trailing space, e.g. in CJK text).
    const parts = line.split(/(?<=[.!?。．！？])\s+|(?<=[。．！？])(?=\S)/);
    let buffer = "";
    for (let i = 0; i < parts.length; i++) {
      buffer = buffer ? `${buffer} ${parts[i]}` : parts[i];
      // endsOnFalseBoundary only inspects the trailing word of its `fragment`
      // argument ($-anchored regexes), which is fully contained in `parts[i]`
      // itself regardless of how much has already accumulated in `buffer`.
      // Passing the whole (potentially long-growing) `buffer` here instead of
      // just the newly-appended part is O(current buffer length) per
      // iteration purely from re-flattening and re-scanning it — O(n^2) over
      // a long run of fused fragments (e.g. many single-letter initials in a
      // row, which never hit a real sentence boundary). Passing `parts[i]`
      // keeps each check O(that part's length) and the whole loop O(n).
      if (!endsOnFalseBoundary(parts[i], parts[i + 1], alwaysFuse, contextFuse)) {
        const trimmed = buffer.trim();
        if (!isBlank(trimmed)) sentences.push(trimmed);
        buffer = "";
      }
    }
    const trimmed = buffer.trim();
    if (!isBlank(trimmed)) sentences.push(trimmed);
  }

  // Clause-level split so an uncited clause can't ride a cited one inside the
  // same sentence. Erring toward more units is safe: it fails closed (flags
  // for a citation), it never launders.
  const units = sentences.flatMap((s) => splitGroundingUnits(s, resolved));

  // Reattach orphaned citation markers to the unit they belong to.
  const merged: string[] = [];
  for (const unit of units) {
    const { markers, rest } = peelLeadingMarkers(unit, resolved.marker);
    if (markers) {
      // Leading markers sat after the PREVIOUS unit's terminal period.
      // Attach them there so they can't ground the prose that follows. If
      // this is the FIRST unit, there is no prior unit for them to
      // terminate, so they ground nothing and are dropped.
      if (merged.length > 0) {
        merged[merged.length - 1] = `${merged[merged.length - 1]} ${markers}`;
      }
      // `rest` already went through peelLeadingMarkers' trimStart(), so if
      // it's non-empty it necessarily starts with (and therefore contains) a
      // non-whitespace character — no need to additionally require that
      // character be ASCII alnum. The old `[A-Za-z0-9]` guard here silently
      // discarded any surviving remainder written in a non-Latin script
      // (e.g. a whole CJK sentence right after a peeled marker) or made of
      // bare punctuation (e.g. a lone "!"), deleting real content from the
      // output instead of just an empty string. Only a remainder that shows
      // nothing (invisible characters alone) is dropped.
      if (!isBlank(rest)) merged.push(rest);
      continue;
    }
    // Trailing citation-only fragment (marker after the period, on its own).
    if (merged.length > 0 && isCitationOnly(unit, resolved.marker)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${unit}`;
      continue;
    }
    merged.push(unit);
  }
  return merged;
}

/**
 * Split `text` into sentence-ish grounding units, keeping citation markers
 * attached to the unit they actually ground (never a following clause or
 * sentence). Hardened against:
 *  - abbreviation periods that don't end a sentence (configurable list)
 *  - a citation marker glued to punctuation/prose with no whitespace
 *  - non-ASCII sentence terminators (。．！？)
 *  - a marker sitting right after a period, which would otherwise be read as
 *    grounding the sentence that follows it (leading-marker peeling)
 *  - clause-internal fabrications riding a citation elsewhere in the sentence
 *    (semicolon/em-dash/cited-colon clause splitting)
 *  - malformed/unbalanced brackets (fails closed: never suppresses a split)
 *  - invisible (default-ignorable) characters placed between a terminator and
 *    the text or marker after it, which would hide a sentence boundary
 *
 * A unit made only of whitespace and invisible characters is dropped, never
 * returned. Work is linear in the length of `text` for the default patterns.
 * A caller-supplied pattern can still be slow if its own regex backtracks
 * badly; that is the caller's configuration.
 *
 * @throws {TypeError} if `text` is not a string, `config` is not a plain
 *   object, or an option has the wrong type (`abbreviations` lists must be
 *   dense arrays of strings; the patterns must be `RegExp`s).
 * @throws {GroundingConfigError} if `markerPattern` matches zero characters
 *   anywhere it is scanned.
 */
export function splitSentences(text: string, config: SplitterConfig = {}): string[] {
  assertString(text, "text");
  return splitResolved(text, resolveSplitterConfig(config));
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
 * Remove citation markers for display/export while leaving prose intact.
 * Collapses any double space or space-before-punctuation left behind by the
 * removal (e.g. "reach [[cite:e1]]." -> "reach.", not "reach .").
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

/** @internal marker removal with a private, already-normalized marker regex. */
export function stripMarkersOf(text: string, marker: RegExp): string {
  return removeMatches(text, scanMarkers(text, marker))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .trimEnd();
}

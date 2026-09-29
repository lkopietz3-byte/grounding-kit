// Internal runtime guards for top-level arguments. TypeScript callers
// already get these from the types; the guards exist for JavaScript callers
// and for values that arrived over JSON (an API request body, a stored
// document) with no static type at all.

/**
 * A short, safe description of a value's kind for an error message. It never
 * calls the value's own `toString`, `toJSON` or getters, so a hostile value
 * cannot make the error path throw.
 */
export function describe(value: unknown): string {
  if (value === null) return "null";
  try {
    if (Array.isArray(value)) return "an array";
    if (typeof value === "object" && !isPlainObject(value)) return "a non-plain object";
  } catch {
    return "an object"; // a revoked Proxy makes both checks throw
  }
  return typeof value;
}

/** A plain object or a null-prototype object: not an array, Map, Set, Date, RegExp or class instance. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    // `Object.getPrototypeOf(proto) === null` also accepts Object.prototype
    // from another realm, whose identity differs from ours.
    return proto === null || Object.getPrototypeOf(proto) === null;
  } catch {
    return false; // a revoked Proxy throws here
  }
}

/** Throws a TypeError naming `label` unless `value` is a string. */
export function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string (got ${describe(value)}).`);
  }
}

/**
 * Throws a TypeError naming `label` unless `value` is a plain or
 * null-prototype object. Checked up front so a caller passing `null`,
 * `undefined`, a primitive, or a `Map`/`Set`/`Date`/class instance (which
 * would read as an empty record) gets this kit's own clear TypeError instead
 * of a raw "Cannot convert undefined or null to object" from deep inside
 * classification, or a silent read of nothing.
 */
export function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must be an object (got ${describe(value)}).`);
  }
}

/**
 * Copy a list of strings in ONE indexed pass, refusing a non-array, a hole and
 * any non-string entry. Later code uses only the returned dense copy, so a
 * sparse array (skipped by `map`, visited by `for...of`) cannot be validated
 * one way and processed another.
 */
export function readStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array of strings (got ${describe(value)}).`);
  }
  const length = (value as unknown[]).length;
  const copy: string[] = [];
  for (let i = 0; i < length; i++) {
    const entry = (value as unknown[])[i];
    if (typeof entry !== "string") {
      throw new TypeError(`${label}[${String(i)}] must be a string (got ${describe(entry)}).`);
    }
    copy.push(entry);
  }
  return copy;
}

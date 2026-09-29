/**
 * Thrown when a value the caller configured cannot work: a marker pattern
 * that matches zero characters, or a `supports` callback that returns
 * something other than a boolean. It extends `TypeError`, so existing
 * `catch (e) { if (e instanceof TypeError) ... }` handlers still match, and
 * its `name` is `"GroundingConfigError"`.
 *
 * It signals a bug in the calling code or its configuration, never a finding
 * about the text being checked. The kit throws it instead of guessing (or,
 * for a zero-length marker, looping forever).
 */
export class GroundingConfigError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "GroundingConfigError";
  }
}

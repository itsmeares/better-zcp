import { escapeRegExp } from "./regex.js";

/**
 * Anchored, single-key read/write helpers for a raw INI file's text content.
 *
 * 2026-08-31: server.js had four independent call sites (ensureRconConfigured,
 * POST /configure-rcon, applyUpnpToIni, POST /configure-network -- two of
 * them literal duplicates of each other) that each hand-rolled their own
 * `content.includes("Key=")` existence guard and a global, UNANCHORED
 * `content.replace()` on a "Key=" wildcard-value pattern. Both are unanchored:
 * `.includes("RCONPassword=")` matches that substring ANYWHERE in the file,
 * and the unanchored replace rewrites every line containing it -- including
 * inside an operator's own free-text field (ServerWelcomeMessage,
 * PublicDescription) if it happens to contain the literal text
 * "RCONPassword=". The result was config corruption plus a credential
 * written somewhere it was never meant to go, not just a missed update.
 * mods.js already carries the fix for the identical shape (18 ini-write
 * sites, fixed 2026-08-27): anchor with `^[ \t]*KEY[ \t]*=` and the `m` flag,
 * so a match can only be a real assignment line, never a substring inside
 * another field's value. This module is that same fix, pulled out into one
 * shared, tested implementation instead of a fifth (and now a
 * sixth-through-ninth) hand-rolled copy.
 *
 * `[ \t]*` around the key tolerates "Key = value" (spaces around `=`), the
 * same whitespace serverFiles.js's parseIni()/toIni() and
 * findDuplicateIniKeys() already tolerate -- see mods.js:2117-2132 for why an
 * anchored pattern with no whitespace tolerance is its own, subtler version
 * of this bug against a hand-edited or PZ-regenerated file.
 */

/** True if `key` appears as a real assignment line (not inside a comment or another field's free text). */
export function hasIniKeyLine(content, key) {
  return new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=`, "m").test(content);
}

/** True if `key`'s assignment line's value is exactly `value` (used for "is this already configured correctly" fast paths -- an unanchored .includes() here can false-positive off a free-text field that happens to contain the same KEY=VALUE substring). */
export function hasIniKeyValue(content, key, value) {
  return new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*${escapeRegExp(String(value))}[ \\t]*$`,
    "m",
  ).test(content);
}

/** Sets `key`'s assignment line to `value`, replacing the first (and only expected) real assignment line if one exists, else appending a new one. Never touches `key`'s substring anywhere else in the file. */
export function setIniKeyLine(content, key, value) {
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, `${key}=${value}`)
    : `${content}\n${key}=${value}`;
}

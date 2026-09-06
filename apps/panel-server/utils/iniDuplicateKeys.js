/**
 * Detects a key appearing more than once, as its own line, in an INI file.
 *
 * 2026-08-27: found while investigating an operator's corrupted
 * servertest.ini (two config blocks concatenated). A duplicated key isn't
 * cosmetic -- mods.js reads/writes ONLY the first occurrence (every
 * content.match()/content.replace() in that file is /m with no /g), while
 * serverFiles.js's parseIni() (a line-by-line `result[key] = value` loop)
 * lets the LAST occurrence win. Two screens the operator can both open at
 * once show different values for the same nominal setting, with nothing
 * telling either of them the file is like this. Neither file had ever
 * checked for it -- mods.js's own GET /validate-config, the closest thing
 * to a health check either file has, reads through the same non-global
 * regex as everything else in that file, so it validated against the
 * first block and could not see that a second block existed. Structurally
 * blind to the worst state its own file can be in.
 *
 * Deliberately not clever: a plain line scan, no INI value parsing, no
 * attempt to understand what a key MEANS -- just whether its name appears
 * as a real `Key=` assignment (not inside a comment or a free-text value)
 * more than once. Read-only, side-effect-free, safe to call on every read.
 */

/**
 * @param {string} content - Raw INI file text (CRLF or LF, doesn't matter --
 *   only the key name up to `=` is captured, never the value).
 * @returns {{ key: string, count: number }[]} One entry per key that
 *   appears more than once, in first-seen order. Empty array when the file
 *   has no duplicated keys (the common, healthy case).
 */
export function findDuplicateIniKeys(content) {
  if (typeof content !== "string" || !content) return [];

  const counts = new Map();
  // Anchored at the start of a line (optional leading whitespace, same
  // tolerance parseIni() already gives real assignment lines), so this
  // cannot fire on a key name mentioned inside a comment or inside another
  // field's free text (PublicDescription, ServerWelcomeMessage) -- the
  // exact class of false positive the includes()-vs-regex bug fixed
  // this check was built on. `g` + `m` together: every real
  // assignment line in the file, not just the first.
  const re = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm;
  let match;
  while ((match = re.exec(content)) !== null) {
    const key = match[1];
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const duplicates = [];
  for (const [key, count] of counts) {
    if (count > 1) duplicates.push({ key, count });
  }
  return duplicates;
}

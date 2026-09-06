/**
 * Escape a string for safe interpolation into a `new RegExp(...)` pattern.
 * Was duplicated identically in serverManager.js and serverFiles.js.
 */
export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

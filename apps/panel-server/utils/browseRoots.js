import path from "path";

/**
 * Check whether `target` is equal to or inside one of `allowedRoots`.
 * Returns the resolved target if allowed, or null if it escapes all roots.
 *
 * Shared by every filesystem browse endpoint (server-files file browser,
 * chunks save browser) so "confine this path to a known-safe root" is one
 * audited implementation instead of one per route file.
 */
export function confineToRoots(target, allowedRoots) {
  const resolved = path.resolve(target);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }
  }
  return null;
}

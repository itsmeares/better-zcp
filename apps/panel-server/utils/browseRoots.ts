import path from "node:path";

export function confineToRoots(
  target: string,
  allowedRoots: readonly string[],
): string | null {
  const resolved = path.resolve(target);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }
  }
  return null;
}

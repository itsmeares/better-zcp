import path from "path";

export function confineToRoots(target, allowedRoots) {
  const resolved = path.resolve(target);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return resolved;
    }
  }
  return null;
}

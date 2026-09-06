
export function findDuplicateIniKeys(content) {
  if (typeof content !== "string" || !content) return [];

  const counts = new Map();
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

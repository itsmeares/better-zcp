import { escapeRegExp } from "./regex.ts";

export function hasIniKeyLine(content: string, key: string): boolean {
  return new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=`, "m").test(content);
}

export function hasIniKeyValue(
  content: string,
  key: string,
  value: unknown,
): boolean {
  return new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*${escapeRegExp(String(value))}[ \\t]*$`,
    "m",
  ).test(content);
}

export function setIniKeyLine(
  content: string,
  key: string,
  value: unknown,
): string {
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, `${key}=${value}`)
    : `${content}\n${key}=${value}`;
}

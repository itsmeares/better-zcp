import { escapeRegExp } from "./regex.js";


export function hasIniKeyLine(content, key) {
  return new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=`, "m").test(content);
}

export function hasIniKeyValue(content, key, value) {
  return new RegExp(
    `^[ \\t]*${escapeRegExp(key)}[ \\t]*=[ \\t]*${escapeRegExp(String(value))}[ \\t]*$`,
    "m",
  ).test(content);
}

export function setIniKeyLine(content, key, value) {
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, "m");
  return pattern.test(content)
    ? content.replace(pattern, `${key}=${value}`)
    : `${content}\n${key}=${value}`;
}

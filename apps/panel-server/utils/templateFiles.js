import fs from "fs";
import path from "path";
import { escapeRegExp } from "./regex.js";
import { writeFileAtomic } from "./fileWriteQueue.js";

function escapeLuaString(str) {
  return String(str).replace(/[\\"'\n\r\t]/g, (c) => {
    const map = { "\\": "\\\\", '"': '\\"', "'": "\\'", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
    return map[c];
  });
}

function formatLuaValue(value) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `"${escapeLuaString(String(value))}"`;
}

function coerceSandboxValue(raw) {
  const trimmed = raw.trim().replace(/,\s*$/, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  const quoted = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : trimmed;
}


export function readIniValues(content, keys) {
  const values = {};
  for (const key of keys) {
    const match = content.match(new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=(.*)$`, "m"));
    if (match) values[key] = match[1].trim();
  }
  return values;
}

export function mergeIniValues(content, updates) {
  let result = content || "";
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    const regex = new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=.*$`, "m");
    const safeValue = String(value).replace(/[\r\n]/g, "");
    if (regex.test(result)) {
      result = result.replace(regex, `${key}=${safeValue}`);
    } else {
      result += `${result && !result.endsWith("\n") ? "\n" : ""}${key}=${safeValue}\n`;
    }
  }
  return result;
}


function findBlockRange(content, blockName) {
  const start = content.match(new RegExp(`${escapeRegExp(blockName)}\\s*=\\s*\\{`));
  if (!start) return null;
  const openAt = start.index + start[0].length;
  const closeAt = content.indexOf("}", openAt);
  if (closeAt === -1) return null;
  return { start: start.index, openAt, closeAt };
}

export function readSandboxValue(content, section, key) {
  if (section !== "settings") {
    const range = findBlockRange(content, section);
    if (!range) return undefined;
    return readFirstMatch(content.slice(range.openAt, range.closeAt), key);
  }

  const nestedRanges = getKnownSectionRanges(content);
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)`, "gm");
  let match;
  while ((match = pattern.exec(content)) !== null) {
    if (nestedRanges.some((r) => match.index >= r.start && match.index < r.closeAt)) continue;
    return coerceSandboxValue(match[1]);
  }
  return undefined;
}

function readFirstMatch(scope, key) {
  const match = scope.match(
    new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)`, "m"),
  );
  return match ? coerceSandboxValue(match[1]) : undefined;
}

export function applySandboxValue(content, section, key, value) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return { content, applied: false };
  const valuePattern = '("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)';

  if (section === "settings") {
    const nestedRanges = getKnownSectionRanges(content);
    const pattern = new RegExp(`(^\\s*)(${escapeRegExp(key)})(\\s*=\\s*)${valuePattern}`, "gm");
    let applied = false;
    const next = content.replace(pattern, (full, indent, k, eq, oldVal, comma, offset) => {
      if (nestedRanges.some((r) => offset >= r.start && offset < r.closeAt)) return full;
      applied = true;
      return `${indent}${k}${eq}${formatLuaValue(value)}${comma}`;
    });
    return { content: next, applied };
  }

  const blockRange = findBlockRange(content, section);
  if (!blockRange) return { content, applied: false };
  const before = content.slice(0, blockRange.openAt);
  const block = content.slice(blockRange.openAt, blockRange.closeAt);
  const after = content.slice(blockRange.closeAt);
  let applied = false;
  const pattern = new RegExp(`(^(?!\\s*--)[^\\n]*?)(${escapeRegExp(key)})(\\s*=\\s*)${valuePattern}`, "m");
  const nextBlock = block.replace(pattern, (full, prefix, k, eq, oldVal, comma) => {
    applied = true;
    return `${prefix}${k}${eq}${formatLuaValue(value)}${comma}`;
  });
  return { content: before + nextBlock + after, applied };
}

function getKnownSectionRanges(content) {
  return ["ZombieLore", "ZombieConfig", "MultiplierConfig", "Map", "Basement"]
    .map((name) => findBlockRange(content, name))
    .filter(Boolean);
}

export function mergeSandboxSections(content, sectionUpdates) {
  let result = content;
  const applied = [];
  const skipped = [];
  for (const [section, values] of Object.entries(sectionUpdates || {})) {
    for (const [key, value] of Object.entries(values || {})) {
      const out = applySandboxValue(result, section, key, value);
      result = out.content;
      (out.applied ? applied : skipped).push({ section, key });
    }
  }
  return { content: result, applied, skipped };
}


export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.join(path.dirname(filePath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `${path.basename(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function writeFile(filePath, content) {
  writeFileAtomic(filePath, content, "utf-8");
}

export function writeFilesTransaction(changes) {
  const written = [];
  try {
    for (const change of changes) {
      writeFile(change.filePath, change.content);
      written.push(change);
    }
  } catch (error) {
    for (const change of written.reverse()) {
      try {
        if (change.existed) {
          writeFile(change.filePath, change.original);
        } else if (fs.existsSync(change.filePath)) {
          fs.unlinkSync(change.filePath);
        }
      } catch {
        // The pre-write backup remains available if rollback itself fails.
      }
    }
    throw error;
  }
}

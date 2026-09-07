import fs from "fs";
import path from "path";
import { escapeRegExp } from "./regex.ts";
import { writeFileAtomic } from "./fileWriteQueue.ts";

type BlockRange = { start: number; openAt: number; closeAt: number };
type TemplateFileChange = {
  filePath: string;
  content: string;
  existed?: boolean;
  original?: string;
};
type SandboxChange = { section: string; key: string };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function escapeLuaString(value: unknown): string {
  return String(value).replace(/[\\"'\n\r\t]/g, (character) => {
    const map: Record<string, string> = {
      "\\": "\\\\",
      '"': '\\"',
      "'": "\\'",
      "\n": "\\n",
      "\r": "\\r",
      "\t": "\\t",
    };
    return map[character];
  });
}

function formatLuaValue(value: unknown): string {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return `"${escapeLuaString(value)}"`;
}

function coerceSandboxValue(raw: string): string | boolean | number {
  const trimmed = raw.trim().replace(/,\s*$/, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  const quoted = trimmed.match(/^"((?:[^"\\]|\\.)*)"$/);
  return quoted ? quoted[1].replace(/\\(.)/g, "$1") : trimmed;
}

export function readIniValues(
  content: string,
  keys: string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const match = content.match(
      new RegExp(`^[ \\t]*${escapeRegExp(key)}[ \\t]*=(.*)$`, "m"),
    );
    if (match) values[key] = match[1].trim();
  }
  return values;
}

export function mergeIniValues(
  content: string,
  updates: Record<string, unknown>,
): string {
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

function findBlockRange(content: string, blockName: string): BlockRange | null {
  const start = content.match(new RegExp(`${escapeRegExp(blockName)}\\s*=\\s*\\{`));
  if (!start) return null;
  const startIndex = start.index ?? -1;
  const openAt = startIndex + start[0].length;
  const closeAt = content.indexOf("}", openAt);
  if (closeAt === -1) return null;
  return { start: startIndex, openAt, closeAt };
}

export function readSandboxValue(
  content: string,
  section: string,
  key: string,
): string | boolean | number | undefined {
  if (section !== "settings") {
    const range = findBlockRange(content, section);
    if (!range) return undefined;
    return readFirstMatch(content.slice(range.openAt, range.closeAt), key);
  }

  const nestedRanges = getKnownSectionRanges(content);
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)`,
    "gm",
  );
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (
      nestedRanges.some(
        (range) => match!.index >= range.start && match!.index < range.closeAt,
      )
    ) {
      continue;
    }
    return coerceSandboxValue(match[1]);
  }
  return undefined;
}

function readFirstMatch(
  scope: string,
  key: string,
): string | boolean | number | undefined {
  const match = scope.match(
    new RegExp(
      `^\\s*${escapeRegExp(key)}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)`,
      "m",
    ),
  );
  return match ? coerceSandboxValue(match[1]) : undefined;
}

export function applySandboxValue(
  content: string,
  section: string,
  key: string,
  value: unknown,
): { content: string; applied: boolean } {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    return { content, applied: false };
  }
  const valuePattern = '("(?:[^"\\\\]|\\\\.)*"|[^,\\n}]+)(,?)';

  if (section === "settings") {
    const nestedRanges = getKnownSectionRanges(content);
    const pattern = new RegExp(
      `(^\\s*)(${escapeRegExp(key)})(\\s*=\\s*)${valuePattern}`,
      "gm",
    );
    let applied = false;
    const next = content.replace(
      pattern,
      (
        full: string,
        indent: string,
        matchedKey: string,
        eq: string,
        oldValue: string,
        comma: string,
        offset: number,
      ) => {
        if (
          nestedRanges.some(
            (range) => offset >= range.start && offset < range.closeAt,
          )
        ) {
          return full;
        }
        applied = true;
        return `${indent}${matchedKey}${eq}${formatLuaValue(value)}${comma}`;
      },
    );
    return { content: next, applied };
  }

  const blockRange = findBlockRange(content, section);
  if (!blockRange) return { content, applied: false };
  const before = content.slice(0, blockRange.openAt);
  const block = content.slice(blockRange.openAt, blockRange.closeAt);
  const after = content.slice(blockRange.closeAt);
  let applied = false;
  const pattern = new RegExp(
    `(^(?!\\s*--)[^\\n]*?)(${escapeRegExp(key)})(\\s*=\\s*)${valuePattern}`,
    "m",
  );
  const nextBlock = block.replace(
    pattern,
    (
      _full: string,
      prefix: string,
      matchedKey: string,
      eq: string,
      _oldValue: string,
      comma: string,
    ) => {
      applied = true;
      return `${prefix}${matchedKey}${eq}${formatLuaValue(value)}${comma}`;
    },
  );
  return { content: before + nextBlock + after, applied };
}

function getKnownSectionRanges(content: string): BlockRange[] {
  return ["ZombieLore", "ZombieConfig", "MultiplierConfig", "Map", "Basement"]
    .map((name) => findBlockRange(content, name))
    .filter((range): range is BlockRange => range !== null);
}

export function mergeSandboxSections(
  content: string,
  sectionUpdates: unknown,
): {
  content: string;
  applied: SandboxChange[];
  skipped: SandboxChange[];
} {
  let result = content;
  const applied: SandboxChange[] = [];
  const skipped: SandboxChange[] = [];
  for (const [section, values] of Object.entries(asRecord(sectionUpdates))) {
    for (const [key, value] of Object.entries(asRecord(values))) {
      const out = applySandboxValue(result, section, key, value);
      result = out.content;
      (out.applied ? applied : skipped).push({ section, key });
    }
  }
  return { content: result, applied, skipped };
}

export function backupFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const dir = path.join(path.dirname(filePath), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `${path.basename(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

export function writeFile(filePath: string, content: string): void {
  writeFileAtomic(filePath, content, "utf-8");
}

export function writeFilesTransaction(changes: TemplateFileChange[]): void {
  const written: TemplateFileChange[] = [];
  try {
    for (const change of changes) {
      writeFile(change.filePath, change.content);
      written.push(change);
    }
  } catch (error: unknown) {
    for (const change of written.reverse()) {
      try {
        if (change.existed) {
          writeFile(change.filePath, change.original as string);
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

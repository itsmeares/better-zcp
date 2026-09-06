import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
export const EN_DIR = "apps/panel-client/src/locales/en";
export const ALL_LANGS = ["fr", "de", "es", "zh-CN", "zh-TW", "ht"];

const CO_CHANGE_WINDOW_MS = 30 * 60 * 1000;

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function blameLines(relPath) {
  const out = git(["blame", "--porcelain", "--", relPath]);
  if (out === null) return null;
  const lines = [];
  let curHash = null;
  const times = {};
  for (const line of out.split("\n")) {
    const hashMatch = line.match(/^([0-9a-f]{40}) /);
    if (hashMatch) {
      curHash = hashMatch[1];
    } else if (line.startsWith("author-time ")) {
      times[curHash] = parseInt(line.slice("author-time ".length), 10) * 1000;
    } else if (line.startsWith("\t")) {
      lines.push({ hash: curHash, time: times[curHash] });
    }
  }
  return lines;
}

const LEAF_RE = /^\s*"([^"]+)"\s*:\s*"(?:[^"\\]|\\.)*"\s*,?\s*$/;
const OPEN_RE = /^\s*"([^"]+)"\s*:\s*\{\s*$/;
const CLOSE_RE = /^\s*\}\s*,?\s*$/;

function keyPathsForFile(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return {};
  const rawLines = fs.readFileSync(full, "utf8").split("\n");
  const stack = [];
  const result = {};
  rawLines.forEach((line, i) => {
    const leaf = LEAF_RE.exec(line);
    if (leaf) {
      result[i] = [...stack, leaf[1]].join(".");
      return;
    }
    const open = OPEN_RE.exec(line);
    if (open) {
      stack.push(open[1]);
      return;
    }
    if (CLOSE_RE.test(line)) stack.pop();
  });
  return result;
}

function flattenCurrent(relPath) {
  const full = path.join(ROOT, relPath);
  const data = JSON.parse(fs.readFileSync(full, "utf8"));
  const out = {};
  (function walk(d, prefix) {
    if (d && typeof d === "object" && !Array.isArray(d)) {
      for (const k of Object.keys(d)) walk(d[k], [...prefix, k]);
    } else if (typeof d === "string") {
      out[prefix.join(".")] = d;
    }
  })(data, []);
  return out;
}

const jsonAtCommitCache = new Map();
function jsonAtCommit(commit, relPath) {
  const key = `${commit}:${relPath}`;
  if (jsonAtCommitCache.has(key)) return jsonAtCommitCache.get(key);
  const out = git(["show", key]);
  let data = null;
  if (out !== null) {
    try {
      data = JSON.parse(out);
    } catch {
      data = null;
    }
  }
  jsonAtCommitCache.set(key, data);
  return data;
}

function getValue(data, dottedKey) {
  let cur = data;
  for (const part of dottedKey.split(".")) {
    if (!cur || typeof cur !== "object" || !(part in cur)) return null;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : null;
}

function wasRealEdit(enHash, enPath, dottedKey, currentValue) {
  const parentData = jsonAtCommit(`${enHash}^`, enPath);
  if (parentData === null) return false;
  const parentValue = getValue(parentData, dottedKey);
  if (parentValue === null) return false;
  return parentValue !== currentValue;
}

function keyMapForFile(relPath) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  const blame = blameLines(relPath);
  if (blame === null) {
    throw new Error(
      `git blame failed for ${relPath} even though the file exists on disk -- ` +
        "this is a transient git failure (lock contention, resource exhaustion, etc), " +
        "not \"nothing to report\". Treating it as clean would silently hide real drift. Re-run once git is not contended.",
    );
  }
  const keyPaths = keyPathsForFile(relPath);
  const map = {};
  for (const [idxStr, kp] of Object.entries(keyPaths)) {
    const idx = Number(idxStr);
    if (idx < blame.length) map[kp] = blame[idx];
  }
  return map;
}

export function analyzeNamespace(ns, langs) {
  const enPath = `${EN_DIR}/${ns}`;
  const enMap = keyMapForFile(enPath);
  if (enMap === null) return [];
  const enCurrent = flattenCurrent(enPath);
  const realEditCache = new Map();
  const findings = [];

  for (const lang of langs) {
    const langPath = `apps/panel-client/src/locales/${lang}/${ns}`;
    const langMap = keyMapForFile(langPath);
    if (langMap === null) continue;

    for (const [kp, enEntry] of Object.entries(enMap)) {
      const langEntry = langMap[kp];
      if (!langEntry) continue;
      if (enEntry.hash === langEntry.hash) continue;
      if (!enEntry.time || !langEntry.time) continue;
      const gapMs = enEntry.time - langEntry.time;
      if (gapMs <= 0) continue;
      if (gapMs <= CO_CHANGE_WINDOW_MS) continue;

      const cacheKey = `${enEntry.hash}:${kp}`;
      if (!realEditCache.has(cacheKey)) {
        realEditCache.set(cacheKey, wasRealEdit(enEntry.hash, enPath, kp, enCurrent[kp]));
      }
      if (!realEditCache.get(cacheKey)) continue;

      findings.push({
        ns, lang, key: kp,
        enHash: enEntry.hash.slice(0, 9),
        langHash: langEntry.hash.slice(0, 9),
        gapMinutes: Math.round(gapMs / 60000),
      });
    }
  }
  return findings;
}

function parseArgs(argv) {
  const opts = { langs: ALL_LANGS, namespaces: null };
  for (const arg of argv) {
    if (arg.startsWith("--lang=")) opts.langs = arg.slice(7).split(",");
    else if (arg.startsWith("--ns=")) opts.namespaces = arg.slice(5).split(",").map((n) => `${n}.json`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const nsList = opts.namespaces || fs.readdirSync(path.join(ROOT, EN_DIR)).filter((f) => f.endsWith(".json")).sort();

  console.log(`Scanning ${nsList.length} namespace(s) x ${opts.langs.length} language(s), co-change window ${CO_CHANGE_WINDOW_MS / 60000}min...`);
  const all = [];
  const errored = [];
  for (const ns of nsList) {
    try {
      all.push(...analyzeNamespace(ns, opts.langs));
    } catch (err) {
      errored.push({ ns, message: err.message });
    }
  }
  all.sort((a, b) => b.gapMinutes - a.gapMinutes);

  if (errored.length > 0) {
    console.log(`\n${errored.length} namespace(s) could NOT be checked (git failure, not "clean") -- re-run:\n`);
    for (const e of errored) console.log(`  ${e.ns}: ${e.message}`);
  }

  console.log(`\n${all.length} candidate(s) -- each needs a human read of both languages' actual meaning, not just this table:\n`);
  for (const f of all) {
    console.log(
      `${f.ns.padEnd(28)} ${f.lang.padEnd(6)} ${f.key.padEnd(45)} gap=${String(f.gapMinutes).padStart(6)}min  en=${f.enHash} lang=${f.langHash}`
    );
  }
  if (all.length > 0) {
    console.log(
      "\nFor each: `git show <enHash> -- apps/panel-client/src/locales/en/<ns>` and the equivalent for <lang> " +
      "to read what actually changed, and compare current values in both languages by hand. " +
      "This script narrows the search space; it does not verify a finding."
    );
  }
  // Always exit 0 -- report tool, never a gate. See header.
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}

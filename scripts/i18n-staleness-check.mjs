// Finds locale VALUES that have gone stale against a changed English source
// -- the one class of i18n bug localeParity.test.ts structurally cannot see.
// Parity checks the SKELETON (key sets, {{placeholder}} sets, tag multisets)
// and is blind to MEANING: reusing an existing key path while changing only
// its English wording passes parity at full green while every other
// language still asserts the disproven old meaning. Built after finding
// exactly this in apps/panel-client/src/locales/ht/errors.json's SERVER_STATE_UNKNOWN
// (2026-08-24) via a manual git-history read; this is that method, cleaned
// up and made repeatable.
//
// === HONEST LIMIT -- READ BEFORE TRUSTING A REPORT FROM THIS SCRIPT ===
// This tool CANNOT compare meaning. It compares git commit timestamps: for
// each locale key, it finds the commit that last touched English's value and
// the commit that last touched a translation's value, and flags the pair
// when English's is later AND is confirmed (via the parent commit) to be a
// genuine content edit of an EXISTING key, not the key's first introduction.
// That still leaves one real failure mode a human has to catch: two commits
// landing minutes apart as part of ONE coherent fix (English fixed at 02:47,
// the same fix already applied to four other languages at 02:38) look
// identical, by ordering alone, to real staleness. The CO-CHANGE_WINDOW_MS
// below exists specifically to suppress that pattern, and is a heuristic
// tuned against the two real examples found on 2026-08-24, not a proven
// universal constant -- see the comment on the constant itself. A flagged
// item is a NARROWED CANDIDATE for a human to read, in both languages,
// never an automatic verdict. This script also cannot itself write or judge
// a translation -- a confirmed finding still needs a real re-translation,
// which is a different, higher-stakes act than filling in a missing key
// (see GLOSSARY.ht.md's own uncertainty-flagging convention for how this
// floor handles that without a native speaker on hand).
//
// REPORT ONLY, NEVER A GATE: this script always exits 0, regardless of
// findings. Do not wire it into a CI check that fails the build. A noisy
// gate on a tree several people are actively translating gets disabled, and
// a disabled check silently reads as a passing one -- worse than no check
// at all. Run it by hand or on a schedule and read the output.
//
// VERIFIED BOTH DIRECTIONS AT THE ACTUAL 30-MINUTE WINDOW, NOT JUST ONE:
// disabling the window (set to 0) on the current tree reproduces exactly the
// 22 known false positives from the pzmap.org host-migration fix and nothing
// else -- proves the window SUPPRESSES known noise. Separately, pointing the
// same code at the historical revision 1725281^ (immediately before the
// SERVER_STATE_UNKNOWN fix landed, via `git blame <rev>`/`git show <rev>:path`
// instead of the working tree -- no file on disk touched) at the real
// 30-minute window reports exactly one candidate: the known true positive,
// ht/errors.json/SERVER_STATE_UNKNOWN, gap 44 minutes, nothing spurious
// alongside it across all 55 namespaces. A filter that swallows everything
// and a filter that works correctly look identical on a tree with nothing
// left to find (both report zero) -- this second check is what rules that
// out, since zero-mutation reruns against real history are cheap and a tool
// that only shows it can be quiet is not yet shown to be able to speak.
//
// Usage: node scripts/i18n-staleness-check.mjs [--lang=fr,de] [--ns=errors,debug]
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
export const EN_DIR = "apps/panel-client/src/locales/en";
export const ALL_LANGS = ["fr", "de", "es", "zh-CN", "zh-TW", "ht"];

// Two locale values touched within this window of each other are treated as
// part of ONE coherent change (a translator working through the same fix the
// English commit made, committed in whichever order), not as evidence of
// staleness. Tuned against the two real cases found 2026-08-24: the false
// positive (debug.json/worldMap.json's pzmap.org -> tiles.pzmap.org fix) had
// English and four translations 9m29s apart, all part of one migration. The
// one genuine finding (errors.json ht/SERVER_STATE_UNKNOWN) had English
// change 43m39s after ht's translation, and ht's translation was never
// touched again. 30 minutes sits between those two observations -- generous
// enough to absorb a translator working through several files in one
// sitting, tight enough not to swallow a fix that landed a working session
// away. This is a judgment call from two data points, not a derived
// constant -- if this script's false-positive or false-negative rate on a
// second real run says otherwise, change it and say why in this comment.
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

// Maps line index (0-based) -> dotted key path, for leaf string values only.
// Relies on the codebase's consistent 2-space-indent, one-key-per-line JSON
// formatting -- a reformatted file would need this re-derived, not patched.
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
  if (parentValue === null) return false; // key didn't exist before -- fresh add
  return parentValue !== currentValue;
}

// blameLines()/git() collapse EVERY git-invocation failure to the same null
// -- "file isn't tracked" and "git blame errored out" (lock contention,
// resource exhaustion, any transient failure) are indistinguishable at that
// layer. analyzeNamespace() treats a null keyMapForFile() result as "this
// language has nothing to report", which is only correct for the first
// case. Conflating them silently drops a language from the report on a
// TRANSIENT failure -- indistinguishable from that language genuinely being
// up to date. Staged and confirmed 2026-09-02 (card
// staleness-gate-reported-3-of-5-stale-locales): a synthetic blame failure
// for one language, on a tree where that language WAS the only stale one,
// produces a clean report for it, same as if it were fine. So: only treat
// "file does not exist on disk" as the legitimate skip (a namespace that
// genuinely hasn't been localized into this language yet); anything else
// (file exists, blame still failed) is a real error the caller must not
// silently swallow.
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
      if (!langEntry) continue; // missing key -- parity's job, not ours
      if (enEntry.hash === langEntry.hash) continue;
      if (!enEntry.time || !langEntry.time) continue;
      const gapMs = enEntry.time - langEntry.time;
      if (gapMs <= 0) continue; // translation is not older than English's last touch
      if (gapMs <= CO_CHANGE_WINDOW_MS) continue; // same coherent change, different commit order

      const cacheKey = `${enEntry.hash}:${kp}`;
      if (!realEditCache.has(cacheKey)) {
        realEditCache.set(cacheKey, wasRealEdit(enEntry.hash, enPath, kp, enCurrent[kp]));
      }
      if (!realEditCache.get(cacheKey)) continue; // English's commit was the key's first introduction

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
      // Report tool: never fail the build over this (see header), but a
      // silently-skipped namespace reads as "checked, clean" -- say so loudly.
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

// Runnable as a CLI (`node scripts/i18n-staleness-check.mjs`) and importable
// as a module (apps/panel-server/tests/roleDescriptionStalenessGate.test.js reuses
// analyzeNamespace directly rather than re-implementing its git-blame/
// co-change-window logic) -- only invoke main() when this file is the
// process entrypoint, not when import()'d.
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main();
}

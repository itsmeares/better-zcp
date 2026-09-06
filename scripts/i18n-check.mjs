import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const enDir = path.join(root, "apps/panel-client/src/locales/en");
const frDir = path.join(root, "apps/panel-client/src/locales/fr");

const BASELINE_PATH = path.join(__dirname, "i18n-duplicates.baseline.json");
let baselineEntries = [];
if (fs.existsSync(BASELINE_PATH)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    baselineEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (err) {
    console.error(`Malformed baseline at ${path.relative(root, BASELINE_PATH)}: ${err.message}`);
    process.exit(1);
  }
}
const baselineKey = (ns, value) => `${ns}::${value}`;
const baselineByKey = new Map(baselineEntries.map((e) => [baselineKey(e.ns, e.value), e]));

function flatten(o, p = "") {
  let out = [];
  for (const k in o) {
    const full = p ? `${p}.${k}` : k;
    if (o[k] && typeof o[k] === "object" && !Array.isArray(o[k])) {
      out.push(...flatten(o[k], full));
    } else {
      out.push([full, o[k]]);
    }
  }
  return out;
}

function loadNamespace(ns) {
  const enPath = path.join(enDir, `${ns}.json`);
  const frPath = path.join(frDir, `${ns}.json`);
  if (!fs.existsSync(enPath) || !fs.existsSync(frPath)) return null;
  const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
  const fr = JSON.parse(fs.readFileSync(frPath, "utf8"));
  return { en, fr, enFlat: flatten(en), frFlat: flatten(fr) };
}

function normalizeEn(v) {
  return (v || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:!?]+$/, "");
}

function findSuspiciousDuplicates(ns, { en, frFlat }) {
  const enMap = new Map(flatten(en));
  const byValue = new Map();
  for (const [key, val] of frFlat) {
    if (typeof val !== "string" || val.trim() === "") continue;
    if (!byValue.has(val)) byValue.set(val, []);
    byValue.get(val).push(key);
  }
  const suspicious = [];
  for (const [value, keys] of byValue) {
    if (keys.length < 2) continue;
    const enValues = keys.map((k) => enMap.get(k));
    const distinctRaw = new Set(enValues);
    if (distinctRaw.size <= 1) continue;
    const distinctNormalized = new Set(enValues.map(normalizeEn));
    if (distinctNormalized.size <= 1) continue;
    suspicious.push({ ns, value, keys, enValues: [...distinctRaw] });
  }
  return suspicious;
}

function checkPage(pageFile, ns) {
  const pagePath = path.join(root, "apps/panel-client/src/pages", pageFile);
  if (!fs.existsSync(pagePath)) {
    console.error(`Page not found: ${pagePath}`);
    process.exit(1);
  }
  const page = fs.readFileSync(pagePath, "utf8");
  const nsData = loadNamespace(ns);
  if (!nsData) {
    console.error(`Namespace not found: en/fr locales/${ns}.json`);
    process.exit(1);
  }
  const { enFlat, frFlat } = nsData;
  const enKeys = new Set(enFlat.map(([k]) => k));
  const frKeys = new Set(frFlat.map(([k]) => k));

  const used = new Set();
  const re = /\bt\(\s*['"`]([a-zA-Z0-9_.]+)['"`]/g;
  let m;
  while ((m = re.exec(page))) used.add(m[1]);

  const hasKeyOrPlural = (keySet, base) =>
    keySet.has(base) || keySet.has(`${base}_one`) || keySet.has(`${base}_other`);

  const missingEn = [...used].filter((k) => !hasKeyOrPlural(enKeys, k));
  const missingFr = [...used].filter((k) => !hasKeyOrPlural(frKeys, k));

  console.log(`${pageFile}: ${used.size} t() keys referenced`);
  if (missingEn.length) console.log("MISSING IN EN:", missingEn);
  if (missingFr.length) console.log("MISSING IN FR:", missingFr);
  if (!missingEn.length && !missingFr.length) {
    console.log("OK: every t() usage has a matching en + fr key.");
  }
  console.log(
    "Note: Trans i18nKey=\"...\" usages are not t() calls and are not scanned — check those by eye.",
  );

  const suspicious = findSuspiciousDuplicates(ns, nsData);
  reportSuspicious(suspicious);
  return { missingEn, missingFr, suspicious };
}

function reportSuspicious(suspicious) {
  if (!suspicious.length) {
    console.log("No suspicious French duplicates (same FR value, different EN source).");
    return;
  }
  console.log(`${suspicious.length} SUSPICIOUS FRENCH DUPLICATE(S):`);
  for (const s of suspicious) {
    console.log(`  [${s.ns}] "${s.value}" used for ${s.keys.length} keys with different English source:`);
    console.log(`    keys: ${s.keys.join(", ")}`);
    console.log(`    english sources: ${s.enValues.map((v) => JSON.stringify(v)).join(" vs ")}`);
  }
}

function checkAllNamespaces() {
  const files = fs.readdirSync(enDir).filter((f) => f.endsWith(".json"));

  const MIN_NAMESPACES = 30;
  if (files.length < MIN_NAMESPACES) {
    console.error(
      `ERROR: found only ${files.length} namespace(s) under ${path.relative(root, enDir)} ` +
      `(expected at least ${MIN_NAMESPACES}). enDir is almost certainly wrong, empty, or the locales ` +
      `tree moved -- fix it before trusting this script's output.`,
    );
    process.exit(1);
  }

  let totalIdenticalEn = 0;
  let totalCaseOnlyEn = 0;
  const allBaselined = [];
  const allNew = [];
  const matchedBaselineKeys = new Set();
  for (const f of files) {
    const ns = f.replace(/\.json$/, "");
    const nsData = loadNamespace(ns);
    if (!nsData) continue;
    const suspicious = findSuspiciousDuplicates(ns, nsData);
    const enMap = new Map(flatten(nsData.en));
    const byValue = new Map();
    for (const [key, val] of nsData.frFlat) {
      if (typeof val !== "string" || val.trim() === "") continue;
      if (!byValue.has(val)) byValue.set(val, []);
      byValue.get(val).push(key);
    }
    for (const [, keys] of byValue) {
      if (keys.length < 2) continue;
      const enValues = keys.map((k) => enMap.get(k));
      if (new Set(enValues).size <= 1) {
        totalIdenticalEn++;
      } else if (new Set(enValues.map(normalizeEn)).size <= 1) {
        totalCaseOnlyEn++;
      }
    }
    for (const s of suspicious) {
      const key = baselineKey(ns, s.value);
      const entry = baselineByKey.get(key);
      if (entry) {
        matchedBaselineKeys.add(key);
        allBaselined.push({ s, entry });
      } else {
        allNew.push(s);
      }
    }
  }

  console.log("");
  if (allNew.length) {
    console.log(`${allNew.length} NEW SUSPICIOUS FRENCH DUPLICATE(S) (not in ${path.relative(root, BASELINE_PATH)}):`);
    reportSuspicious(allNew);
  }
  if (allBaselined.length) {
    console.log(`already-baselined: ${allBaselined.length} duplicate group(s)`);
  }
  const unmatched = baselineEntries.filter((e) => !matchedBaselineKeys.has(baselineKey(e.ns, e.value)));
  if (unmatched.length) {
    console.log(
      `NOTE: ${unmatched.length} baseline entr${unmatched.length === 1 ? "y" : "ies"} matched nothing this run ` +
      `(does not fail the gate -- the duplicate may have been fixed or reworded; safe to delete once confirmed):`,
    );
    for (const e of unmatched) console.log(`  [${e.ns}] ${JSON.stringify(e.value)}`);
  }

  console.log("");
  console.log(`Namespaces scanned: ${files.length}`);
  console.log(`Benign duplicate groups, identical EN source: ${totalIdenticalEn}`);
  console.log(`Benign duplicate groups, EN differs only by case/whitespace: ${totalCaseOnlyEn}`);
  console.log(`Suspicious duplicate groups, EN differs meaningfully: ${allBaselined.length + allNew.length} (${allBaselined.length} baselined, ${allNew.length} new)`);

  if (allNew.length) {
    console.error(`\nFAIL: ${allNew.length} suspicious French duplicate(s) not accounted for by the baseline.`);
    process.exit(1);
  }
  console.log(`\nPASS: no NEW suspicious French duplicates (${allBaselined.length} previously-reviewed finding(s) accounted for by the baseline).`);
}

const args = process.argv.slice(2);
if (args[0] === "--all") {
  checkAllNamespaces();
} else if (args.length === 2) {
  checkPage(args[0], args[1]);
} else {
  console.error("Usage: node scripts/i18n-check.mjs <PageFile.tsx> <namespace>");
  console.error("       node scripts/i18n-check.mjs --all");
  process.exit(1);
}

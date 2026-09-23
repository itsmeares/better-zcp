import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const readFirst = (...rels) => {
  const rel = rels.find((candidate) => fs.existsSync(path.join(root, candidate)));
  if (!rel) throw new Error(`None of these files exist: ${rels.join(", ")}`);
  return read(rel);
};

const lua = read("integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua");
const luaHandlers = new Set(
  [...lua.matchAll(/^\s*handlers\.([a-zA-Z]+)/gm)].map((m) => m[1]),
);

const routes = readFirst("apps/panel-server/routes/panelBridge.ts", "apps/panel-server/routes/panelBridge.js");
const segments = [];
const routeRe = /router\.(get|post|put|delete)\(\s*"([^"]+)"/g;
let match;
const marks = [];
while ((match = routeRe.exec(routes)) !== null) {
  marks.push({ index: match.index, path: match[2] });
}
for (let i = 0; i < marks.length; i++) {
  segments.push({
    path: marks[i].path,
    body: routes.slice(marks[i].index, marks[i + 1]?.index ?? routes.length),
  });
}

const problems = [];
const verified = [];
const unverifiable = [];

for (const segment of segments) {
  const literalActions = new Set();
  for (const m of segment.body.matchAll(/sendCommand\(\s*([^,)]+)/g)) {
    const raw = m[1].trim();
    const literal = raw.match(/^["']([a-zA-Z]+)["']$/);
    if (literal) {
      literalActions.add(literal[1]);
    } else {
      unverifiable.push(`${segment.path} -> sendCommand(${raw}, ...)`);
    }
  }
  for (const action of literalActions) {
    if (luaHandlers.has(action)) verified.push(`${segment.path} -> ${action}`);
    else problems.push(`${segment.path} -> ${action}  (NO LUA HANDLER)`);
  }
}

const MIN_ROUTE_ACTION_PAIRS = 10;
const routeActionPairs = verified.length + problems.length;
if (routeActionPairs < MIN_ROUTE_ACTION_PAIRS) {
  console.error(
    `ERROR: found only ${routeActionPairs} route->action pair(s) via the router.<verb>("path" anchor ` +
    `(expected at least ${MIN_ROUTE_ACTION_PAIRS}). The route-splitting regex is almost certainly stale -- ` +
    "the PanelBridge route declarations changed shape. Fix it before trusting this script's output.",
  );
  process.exit(1);
}

console.log(`lua handlers implemented:              ${luaHandlers.size}`);
console.log(`route->action pairs checked (literal):  ${routeActionPairs}`);
console.log(`UNVERIFIABLE call sites (non-literal action, cannot be checked): ${unverifiable.length}`);
for (const u of unverifiable) console.log(`  ${u}`);
console.log(`MISMATCHES:                              ${problems.length}`);
for (const p of problems) console.log(`  ${p}`);
if (unverifiable.length) {
  console.log(
    `\nNOTE: ${unverifiable.length} call site(s) above dispatch a non-literal action and are NOT covered ` +
    `by the counts above. The generic POST /command allowlist is checked by audit-bridge-actions.mjs.`,
  );
}

if (problems.length > 0) {
  process.exit(1);
}

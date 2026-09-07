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

const capabilityAnchor = "export const BRIDGE_ACTION_CAPABILITY";
const capabilityIdx = routes.indexOf(capabilityAnchor);
const capabilityActions = [];
if (capabilityIdx !== -1) {
  const openingBrace = routes.indexOf("{", capabilityIdx);
  const block = routes.slice(openingBrace === -1 ? capabilityIdx : openingBrace + 1);
  const closeIdx = block.indexOf("\n};");
  const body = closeIdx === -1 ? block : block.slice(0, closeIdx);
  for (const m of body.matchAll(/^\s*([a-zA-Z]+):\s*"/gm)) {
    capabilityActions.push(m[1]);
  }
}

const MIN_CAPABILITY_KEYS = 10;
if (capabilityIdx === -1) {
  console.error(
    "ERROR: could not find BRIDGE_ACTION_CAPABILITY in the PanelBridge route file at all -- " +
    "it was renamed, moved, or removed. Fix the anchor before trusting this script's output.",
  );
  process.exit(1);
}
if (capabilityActions.length < MIN_CAPABILITY_KEYS) {
  console.error(
    `ERROR: found BRIDGE_ACTION_CAPABILITY but extracted only ${capabilityActions.length} key(s) ` +
    `(expected at least ${MIN_CAPABILITY_KEYS}). The extraction regex is almost certainly stale -- ` +
    `fix it before trusting this script's output.`,
  );
  process.exit(1);
}

const capabilityVerified = [];
const capabilityMissingHandler = [];
for (const action of capabilityActions) {
  if (luaHandlers.has(action)) capabilityVerified.push(`BRIDGE_ACTION_CAPABILITY -> ${action}`);
  else capabilityMissingHandler.push(action);
}

const MIN_ROUTE_ACTION_PAIRS = 20;
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
console.log(`BRIDGE_ACTION_CAPABILITY keys checked:   ${capabilityActions.length} (${capabilityVerified.length} verified against a lua handler)`);
console.log(`UNVERIFIABLE call sites (non-literal action, cannot be checked): ${unverifiable.length}`);
for (const u of unverifiable) console.log(`  ${u}`);
console.log(`MISMATCHES:                              ${problems.length + capabilityMissingHandler.length}`);
for (const p of problems) console.log(`  ${p}`);
for (const a of capabilityMissingHandler) console.log(`  BRIDGE_ACTION_CAPABILITY -> ${a}  (NO LUA HANDLER)`);
if (unverifiable.length) {
  console.log(
    `\nNOTE: ${unverifiable.length} call site(s) above dispatch a non-literal action and are NOT covered ` +
    `by the counts above. This script also cannot enumerate every action reachable through the generic ` +
    `passthrough (POST /command) beyond BRIDGE_ACTION_CAPABILITY's own named keys -- any other Lua handler ` +
    `is technically reachable by a role holding plain bridge.command and is unverified by this tool.`,
  );
}

if (problems.length + capabilityMissingHandler.length > 0) {
  process.exit(1);
}

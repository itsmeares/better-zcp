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

const policy = readFirst(
  "apps/panel-server/services/panelBridgePolicy.ts",
  "apps/panel-server/services/panelBridgePolicy.js",
  "apps/panel-server/routes/panelBridge.ts",
  "apps/panel-server/routes/panelBridge.js",
);
const validBlock = policy.slice(policy.indexOf("VALID_ACTIONS"));
const allowList = new Set(
  [...validBlock.slice(0, validBlock.indexOf("]);")).matchAll(/["']([a-zA-Z]+)["']/g)].map(
    (m) => m[1],
  ),
);

const api = read("apps/panel-client/src/lib/api.ts");
const apiActions = new Set(
  [...api.matchAll(/sendCommand\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
);
for (const m of api.matchAll(/apiPost\(\s*"\/panel-bridge\/command",\s*\{\s*action:\s*"([a-zA-Z]+)"/g)) {
  apiActions.add(m[1]);
}

const events = read("apps/panel-client/src/pages/Events.tsx");
const literalEventsActions = [...events.matchAll(/sendCommand\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
const eventsOps = new Set(literalEventsActions);

const templateFnAnchor = "function getBridgeOperationTemplates";
const templateFnIdx = events.indexOf(templateFnAnchor);
let templateKeyCount = 0;
if (templateFnIdx !== -1) {
  const templatesBlock = events.slice(templateFnIdx);
  const closeIdx = templatesBlock.indexOf("\n}");
  const templatesBody = closeIdx === -1 ? templatesBlock : templatesBlock.slice(0, closeIdx);
  for (const m of templatesBody.matchAll(/^\s+([a-zA-Z]+):\s*\{/gm)) {
    eventsOps.add(m[1]);
    templateKeyCount++;
  }
}

const MIN_TEMPLATE_KEYS = 10;
if (templateFnIdx !== -1 && templateKeyCount < MIN_TEMPLATE_KEYS) {
  console.error(
    `ERROR: found getBridgeOperationTemplates() but extracted only ${templateKeyCount} key(s) ` +
    `(expected at least ${MIN_TEMPLATE_KEYS}). The extraction regex is almost certainly stale -- ` +
    `Events.tsx's structure changed again. Fix the regex before trusting this script's output.`,
  );
  process.exit(1);
}
if (templateFnIdx === -1) {
  console.error(
    "ERROR: could not find getBridgeOperationTemplates() in Events.tsx at all -- " +
    "the function was renamed, moved, or removed. Fix the anchor before trusting this script's output.",
  );
  process.exit(1);
}

const candidates = new Set([...apiActions, ...eventsOps]);
const missingHandler = [...candidates].filter((a) => !luaHandlers.has(a)).sort();
const missingAllow = [...candidates].filter((a) => !allowList.has(a)).sort();
const allowedButUnimplemented = [...allowList]
  .filter((a) => !luaHandlers.has(a))
  .sort();

console.log(`literal sendCommand('name', ...) calls in Events.tsx: ${new Set(literalEventsActions).size}`);
console.log(`getBridgeOperationTemplates() keys found:             ${templateKeyCount}`);
console.log(`literal sendCommand("name", ...) refs in api.ts:      ${apiActions.size}`);
console.log(`checked actions (denominator):     ${candidates.size}  -- NOT every action Events can send; see this script's own header for the honest ceiling`);
console.log(`lua handlers:                      ${luaHandlers.size}`);
console.log(`server allow-list:                 ${allowList.size}`);
console.log(`NO LUA HANDLER:             ${missingHandler.join(", ") || "none"}`);
console.log(`NOT IN ALLOW-LIST:          ${missingAllow.join(", ") || "none"}`);
console.log(`ALLOWED BUT NO HANDLER:     ${allowedButUnimplemented.join(", ") || "none"}`);

if (missingHandler.length || missingAllow.length || allowedButUnimplemented.length) {
  process.exit(1);
}

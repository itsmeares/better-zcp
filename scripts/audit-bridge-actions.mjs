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
const clientRoot = path.join(root, "apps/panel-client/src");
const clientSources = fs.readdirSync(clientRoot, { recursive: true })
  .filter((name) => /\.[jt]sx?$/.test(name))
  .map((name) => fs.readFileSync(path.join(clientRoot, name), "utf8"))
  .join("\n");
const apiActions = new Set(
  [...clientSources.matchAll(/sendCommand\(\s*["']([a-zA-Z]+)["']/g)].map((m) => m[1]),
);
for (const m of api.matchAll(/apiPost\(\s*"\/panel-bridge\/command",\s*\{\s*action:\s*"([a-zA-Z]+)"/g)) {
  apiActions.add(m[1]);
}

const candidates = apiActions;
const missingHandler = [...candidates].filter((a) => !luaHandlers.has(a)).sort();
const missingAllow = [...candidates].filter((a) => !allowList.has(a)).sort();
const allowedButUnimplemented = [...allowList]
  .filter((a) => !luaHandlers.has(a))
  .sort();

console.log(`literal client sendCommand refs:     ${apiActions.size}`);
console.log(`checked actions:                   ${candidates.size}`);
console.log(`lua handlers:                      ${luaHandlers.size}`);
console.log(`server allow-list:                 ${allowList.size}`);
console.log(`NO LUA HANDLER:             ${missingHandler.join(", ") || "none"}`);
console.log(`NOT IN ALLOW-LIST:          ${missingAllow.join(", ") || "none"}`);
console.log(`ALLOWED BUT NO HANDLER:     ${allowedButUnimplemented.join(", ") || "none"}`);

if (missingHandler.length || missingAllow.length || allowedButUnimplemented.length) {
  process.exit(1);
}

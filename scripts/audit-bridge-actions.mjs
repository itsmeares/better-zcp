// Cross-checks every PanelBridge action name this file can find as a literal in Events.tsx/api.ts
// against the deployed Lua handlers and the server-side allow-list. Reports only mismatches.
//
// HONEST CEILING (2026-08-31 bug hunt): this is NOT "every action the Events page can send" --
// most of Events.tsx's real dispatch is `sendCommand(action, args)` / `sendCommand(bridgeOperation,
// parsedArgs)` with a VARIABLE action name, invisible to any literal-string regex by construction.
// What this script actually covers: the handful of hardcoded pre-fetch calls (sendCommand('name',
// ...)) plus every key in getBridgeOperationTemplates()'s returned object (the fixed free-form-args
// operation list the "raw JSON" UI path offers) -- roughly 20 of the ~90-100 real bridge actions,
// not all of them. Was previously checking ~4 of those ~20 (0 of the 17 template keys) because its
// extraction anchor (`const bridgeOperationTemplates` followed by an inline object at 2-space
// indent) went stale when that data moved into a separately exported getBridgeOperationTemplates()
// function at 4-space indent -- a checker that silently covers almost nothing while printing a
// clean pass, the exact failure class this whole hunt kept finding. Fixed to anchor on the function
// itself and match keys at ANY indent depth, and to fail loudly (not print a quiet "0 mismatches")
// if the resulting corpus looks implausibly small -- see MIN_TEMPLATE_KEYS below.
import fs from "fs";
import path from "path";

const root = path.resolve(process.argv[2] || ".");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const lua = read("pz-mod/PanelBridge/media/lua/server/PanelBridge.lua");
const luaHandlers = new Set(
  [...lua.matchAll(/^\s*handlers\.([a-zA-Z]+)/gm)].map((m) => m[1]),
);

const routes = read("server/routes/panelBridge.js");
const validBlock = routes.slice(routes.indexOf("const VALID_ACTIONS"));
const allowList = new Set(
  [...validBlock.slice(0, validBlock.indexOf("]);")).matchAll(/"([a-zA-Z]+)"/g)].map(
    (m) => m[1],
  ),
);

// Every action name the client can put on the wire, from the API layer.
const api = read("client/src/lib/api.ts");
const apiActions = new Set(
  [...api.matchAll(/sendCommand\(\s*"([a-zA-Z]+)"/g)].map((m) => m[1]),
);
for (const m of api.matchAll(/apiPost\(\s*"\/panel-bridge\/command",\s*\{\s*action:\s*"([a-zA-Z]+)"/g)) {
  apiActions.add(m[1]);
}

const events = read("client/src/pages/Events.tsx");
const literalEventsActions = [...events.matchAll(/sendCommand\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
const eventsOps = new Set(literalEventsActions);

// getBridgeOperationTemplates() returns the fixed operation list the raw-JSON-args UI path offers
// -- anchor on the FUNCTION (not a `const` that may or may not still hold the data inline) and
// match its top-level keys at ANY indent (not a hardcoded depth that breaks the moment someone
// reformats). Bounded by the first column-0 `}` after the anchor, same as the function's own
// closing brace.
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

// A checker that silently covers almost nothing while printing a clean "0 mismatches" is worse
// than one that errors -- this is the exact failure class this script itself was found to be
// (2026-08-31: matched 0 of 17 real template keys after a refactor moved the data it was reading).
// If the anchor is found at all, finding implausibly few keys under it means the extraction regex
// itself has gone stale again, not that the file genuinely shrank to almost nothing -- fail loudly
// rather than let a future silent break look identical to a real pass.
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

// wire-up-the-unrun-checkers (2026-08-31 bug hunt): this script had no
// caller anywhere in the repo until this pass -- package script + CI job added
// alongside this exit code. Confirmed zero mismatches on HEAD before adding
// this (see the dispatch report); a checker that can never fail is
// decoration, the exact thing that let this script's own coverage rot
// silently until tonight.
if (missingHandler.length || missingAllow.length || allowedButUnimplemented.length) {
  process.exit(1);
}

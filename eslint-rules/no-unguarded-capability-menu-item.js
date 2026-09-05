/**
 * Radix menu items invoke the caller's `onClick` before their own disabled
 * handling. Their `disabled` prop is therefore an affordance, not a complete
 * code-level gate; capability checks must also guard the handler.
 *
 * Native `<button disabled>` controls do not dispatch activation events, so
 * the rule only requires missing guards for Radix-style non-native items.
 *
 * Native buttons are still checked when a handler contains a capability guard
 * that does not match the capability used by `disabled`; that mismatch is
 * unreachable while the button is disabled and is easy to miss in tests.
 *
 * A handler guard is checked directly and through one same-file delegate. This
 * covers inline callbacks without attempting general interprocedural analysis.
 *
 * Local component declarations are skipped because a JSX name alone cannot
 * prove whether the rendered control is native or Radix-based. Same-file
 * delegate callbacks are followed by one hop; unresolved, imported, or
 * multi-definition handlers are left alone to avoid false positives.
 *
 * Capability guards may appear anywhere in the leading run of
 * `if (...) return` statements, not only as the first statement.
 *
 * A capability binding is identified by the `/^can[A-Z]/` naming convention.
 * The rule compares those names within the current file; it does not perform
 * type analysis or resolve capability values across modules.
 *
 * TWO SEPARATE CHECKS, one per element category:
 *
 * MISSING-GUARD (RADIX_ITEM_COMPONENTS only, after the local-shadow
 * check) -- a violation requires ALL of:
 *   1. The JSX element's tag name is one of RADIX_ITEM_COMPONENTS and does
 *      NOT resolve to a local (non-import) declaration in this file.
 *   2. It has a `disabled={...}` expression container that references at
 *      least one `can*`-named identifier anywhere in its expression tree
 *      (through `!`, `&&`, `||`, ternaries, and call arguments).
 *   3. It has an `onClick={...}` expression container whose value is an
 *      inline arrow/function expression (see gap below for anything else).
 *   4. That function's body is a block whose LEADING RUN of `if (...)
 *      return`-shaped statements does NOT include one testing at least one
 *      of the same `can*` names found in (2) -- AND, if the whole onClick
 *      body is a single delegating call to a same-file function/useCallback
 *      handler, that function's own leading run doesn't either. An
 *      unresolvable delegate is NOT flagged (fallback policy
 *      above).
 *
 * MISMATCH-ONLY (NATIVE_BUTTON_COMPONENTS only, after the same local-shadow
 * shadow check) -- a violation requires ALL of:
 *   1. The JSX element's tag name is one of NATIVE_BUTTON_COMPONENTS and
 *      does not resolve to a local (non-import) declaration in this file.
 *   2. Same `disabled` requirement as above.
 *   3. Same inline-function `onClick` requirement as above (no one-hop
 *      delegate resolution on this side -- see known gaps below).
 *   4. That function's leading run of `if (...) return`-shaped statements
 *      DOES reference at least one `can*` name (i.e. a capability guard was
 *      clearly attempted) but NONE of the names across that whole run
 *      overlap the `disabled` set. A native button with NO guard at all,
 *      or whose leading run doesn't reference any `can*` name (ordinary
 *      loading-state logic, unrelated to capabilities), is NOT flagged --
 *      demanding a guard where `disabled` already blocks the click is the
 *      noise this rule exists to avoid.
 *
 * === KNOWN GAPS, ACCEPTED RATHER THAN CHASED (same policy as this
 * directory's other rules) ===
 *
 *   - `onClick={someNamedHandler}` (a BARE identifier reference, with no
 *     call at all -- `onClick={handleClick}`, not `onClick={() =>
 *     handleClick()}`) is still not analyzed. The one-hop check only
 *     follows an inline arrow/function whose body IS the delegating call;
 *     a bare identifier never gives the rule an inline function to inspect
 *     in the first place, so there's no `onClick` body to extract a callee
 *     from.
 *   - The one-hop resolution is exactly one hop: `onClick={() =>
 *     helper(x)}` where `helper` itself delegates to a SECOND same-file
 *     function is not traced further, same "one hop, not general data-flow"
 *     boundary used by other local lint rules for the same reason.
 *   - The one-hop check only unwraps a SINGLE `useCallback(fn, deps)` /
 *     `useMemo(fn, deps)` layer around the target function's own
 *     declaration (`const helper = useCallback((x) => {...}, [...])`) --
 *     any other wrapping (a custom HOC, a `.bind()`, an IIFE) is not
 *     recognized and the delegate resolves as "unresolved" (fallback: not
 *     flagged, per the policy above).
 *   - Direct `can('capability.name')` calls inlined into `disabled`
 *     (instead of a precomputed `const canX = can(...)`) are invisible to
 *     this rule -- the `/^can[A-Z]/` name check does not match a bare
 *     lowercase `can` call; callers must expose a named `can*` boolean for
 *     this rule to inspect it.
 *   - A guard whose leading run references a DIFFERENT `can*` name than the
 *     one(s) in `disabled` (rather than none at all) is accepted as
 *     "guarded"/"not mismatched" as long as the two name-sets overlap at
 *     all -- the rule does not require the sets to match exactly.
 *     `disabled={!canA || !canB}` guarded only by `if (!canA) return`
 *     passes here even though `canB` alone could still let the click
 *     through. The rule intentionally checks for overlap, not exact set
 *     equality.
 *   - Only `DropdownMenuItem`, `ContextMenuItem`, `MenubarItem`,
 *     `SelectItem`, `CommandItem` are checked for missing guards, and only
 *     `<button>`/`<Button>` for mismatched ones -- any other component
 *     under a different name (a checkbox/radio item variant, another native-
 *     rendering wrapper) is invisible unless added to the relevant Set
 *     below. The local-shadow check protects against a wrong conclusion
 *     from a name collision; it doesn't discover components under names
 *     this rule was never told to look for.
 */

const RADIX_ITEM_COMPONENTS = new Set([
  "DropdownMenuItem",
  "ContextMenuItem",
  "MenubarItem",
  "SelectItem",
  "CommandItem",
]);

const NATIVE_BUTTON_COMPONENTS = new Set(["button", "Button"]);

const CAPABILITY_NAME = /^can[A-Z]/;

function findAttribute(attributes, name) {
  return attributes.find(
    (attr) => attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name,
  );
}

// Walks a JS expression's own subtree (never crossing into a nested
// function's body) collecting every Identifier name matching CAPABILITY_NAME.
function collectCapabilityNames(node, out) {
  if (!node || typeof node.type !== "string") return;
  switch (node.type) {
    case "Identifier":
      if (CAPABILITY_NAME.test(node.name)) out.add(node.name);
      return;
    case "UnaryExpression":
      collectCapabilityNames(node.argument, out);
      return;
    case "LogicalExpression":
    case "BinaryExpression":
      collectCapabilityNames(node.left, out);
      collectCapabilityNames(node.right, out);
      return;
    case "ConditionalExpression":
      collectCapabilityNames(node.test, out);
      collectCapabilityNames(node.consequent, out);
      collectCapabilityNames(node.alternate, out);
      return;
    case "CallExpression":
      for (const arg of node.arguments) collectCapabilityNames(arg, out);
      return;
    case "ParenthesizedExpression":
      collectCapabilityNames(node.expression, out);
      return;
    default:
      return;
  }
}

function consequentReturns(node) {
  if (!node) return false;
  if (node.type === "ReturnStatement") return true;
  if (node.type === "BlockStatement") {
    return node.body.some((stmt) => stmt.type === "ReturnStatement");
  }
  return false;
}

// Walks the LEADING RUN of `if (...) return`-shaped statements at the start
// of a block (stops at the first statement that isn't one), collecting
// every can*-named identifier referenced across the whole run. Models
// "early exits before real work starts" -- a capability check doesn't have
// to be literally the first statement, just part of that leading guard
// sequence, before any side effect (handleActivateServer's own shape:
// `if (server.isActive) return; if (!canServersManage) return; ...`).
function collectLeadingGuardNames(blockStatement) {
  const names = new Set();
  for (const stmt of blockStatement.body) {
    if (stmt.type !== "IfStatement" || !consequentReturns(stmt.consequent)) break;
    collectCapabilityNames(stmt.test, names);
  }
  return names;
}

// True when `fn`'s body opens with a leading guard run referencing at
// least one of `capabilityNames` -- the two-layer guard the MISSING-GUARD
// check requires.
function isGuardedAtEntry(fn, capabilityNames) {
  if (fn.body.type !== "BlockStatement") return false;
  const guardNames = collectLeadingGuardNames(fn.body);
  return [...guardNames].some((name) => capabilityNames.has(name));
}

// Finds `name` in `scope` or any enclosing scope -- a plain lexical lookup,
// not full data-flow, same helper (and same restraint) as
// no-raw-error-message.js's own one-hop widening (a7138e1).
function findVariableInScope(scope, name) {
  let current = scope;
  while (current) {
    const found = current.variables.find((v) => v.name === name);
    if (found) return found;
    current = current.upper;
  }
  return null;
}

// If `onClickExpr`'s ENTIRE body is a single call to an Identifier callee
// (`() => helper(x)` or `() => { helper(x) }`), returns that callee
// Identifier node. Returns null for anything else -- this is deliberately
// narrow (exactly the real Servers.tsx shape), not a general "does this
// function eventually call something" search.
function extractSoleDelegateCallee(onClickExpr) {
  if (onClickExpr.body.type === "CallExpression") {
    return onClickExpr.body.callee;
  }
  if (onClickExpr.body.type === "BlockStatement" && onClickExpr.body.body.length === 1) {
    const stmt = onClickExpr.body.body[0];
    if (stmt.type === "ExpressionStatement" && stmt.expression.type === "CallExpression") {
      return stmt.expression.callee;
    }
  }
  return null;
}

// Unwraps exactly one `useCallback(fn, deps)` / `useMemo(fn, deps)` layer
// around a variable's initializer -- the common React-memoization shape
// this codebase's own handlers use (handleActivateServer's real shape).
function unwrapCallbackWrapper(node) {
  if (node.type === "CallExpression" && node.arguments.length > 0) {
    const first = node.arguments[0];
    if (first.type === "ArrowFunctionExpression" || first.type === "FunctionExpression") return first;
  }
  return node;
}

// Given an eslint-scope Definition for a resolved variable, returns the
// function node it points to (unwrapping one useCallback/useMemo layer),
// or null if the definition isn't a function/const-function shape this
// rule knows how to follow.
function getFunctionFromDefinition(def) {
  if (def.type === "FunctionName") return def.node;
  if (def.type === "Variable") {
    const init = def.node.init;
    if (!init) return null;
    const unwrapped = unwrapCallbackWrapper(init);
    if (unwrapped.type === "ArrowFunctionExpression" || unwrapped.type === "FunctionExpression") return unwrapped;
  }
  return null;
}

// Resolves the ONE-HOP delegate case for the MISSING-GUARD check. Returns:
//   "not-a-delegate" -- onClick's body isn't a single delegating call at
//       all; caller should judge guardedness from onClick's own body only.
//   "unresolved"     -- IS a delegate shape, but the callee couldn't be
//       resolved to exactly one same-file function (imported, a member
//       expression call, multiple definitions, unsupported wrapper, ...).
//       Per this rule's fallback policy, callers must NOT flag this case.
//   "guarded"         -- resolved, and the target function's own leading
//       guard run references one of capabilityNames.
//   "unguarded"       -- resolved, and it does not.
function resolveDelegateGuardState(context, onClickExpr, capabilityNames) {
  const callee = extractSoleDelegateCallee(onClickExpr);
  if (!callee) return "not-a-delegate";
  if (callee.type !== "Identifier") return "unresolved";

  const scope = context.sourceCode.getScope(onClickExpr);
  const variable = findVariableInScope(scope, callee.name);
  if (!variable || variable.defs.length !== 1) return "unresolved";

  const fn = getFunctionFromDefinition(variable.defs[0]);
  if (!fn) return "unresolved";

  return isGuardedAtEntry(fn, capabilityNames) ? "guarded" : "unguarded";
}

// Cause 1: does `tagName` resolve to a LOCAL (non-import) declaration
// visible from `node`'s scope? If so, the JSX tag is shadowing a Radix or
// native-button name with an unknown, file-local component -- we cannot
// safely assume it renders either shape, so the caller must skip it
// entirely (WorldMap.tsx's own `function ContextMenuItem(...)`, which
// renders a real `<button>`, is the real case this protects against).
function isShadowedByLocalDeclaration(context, node, tagName) {
  const scope = context.sourceCode.getScope(node);
  const variable = findVariableInScope(scope, tagName);
  if (!variable) return false;
  return variable.defs.some((def) => def.type !== "ImportBinding");
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flag (1) a capability-gated Radix menu-item primitive (DropdownMenuItem/ContextMenuItem/MenubarItem/SelectItem/CommandItem) whose onClick does not start with an early return on that same capability -- Radix runs onClick regardless of disabled for these non-native items -- and (2) a native button/Button whose onClick guard tests a DIFFERENT capability than its own disabled prop, the one shape no click-through test can ever catch",
    },
    schema: [],
    messages: {
      unguarded:
        "This {{tag}} is disabled on {{bindings}}, but Radix runs a menu item's onClick unconditionally -- the disabled attribute is CSS/unfocusability here, not a code-level gate (it renders a <div>, not a native <button>). Add `if (!{{firstBinding}}) return` as the first line of the onClick body, matching the two-layer guard pattern already used elsewhere (see this rule's file header).",
      mismatchedGuard:
        "This {{tag}}'s onClick guard tests {{guardBindings}}, but its own disabled prop is on {{bindings}} -- a disabled native button never dispatches the click that would exercise this guard, so NO TEST CAN EVER OBSERVE the disagreement at runtime. It is only visible by reading the code. Make the guard's first `if` test the SAME binding(s) as disabled.",
    },
  },

  create(context) {
    const candidates = [];

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;
        const isRadixItem = RADIX_ITEM_COMPONENTS.has(tag);
        const isNativeButton = NATIVE_BUTTON_COMPONENTS.has(tag);
        if (!isRadixItem && !isNativeButton) return;

        const disabledAttr = findAttribute(node.attributes, "disabled");
        if (!disabledAttr || !disabledAttr.value || disabledAttr.value.type !== "JSXExpressionContainer") return;

        const capabilityNames = new Set();
        collectCapabilityNames(disabledAttr.value.expression, capabilityNames);
        if (capabilityNames.size === 0) return;

        const onClickAttr = findAttribute(node.attributes, "onClick");
        if (!onClickAttr || !onClickAttr.value || onClickAttr.value.type !== "JSXExpressionContainer") return;

        const onClickExpr = onClickAttr.value.expression;
        if (onClickExpr.type !== "ArrowFunctionExpression" && onClickExpr.type !== "FunctionExpression") return;

        candidates.push({ node, tag, isRadixItem, onClickAttr, onClickExpr, capabilityNames });
      },

      // Deferred so every candidate's scope tree (and any function it might
      // one-hop-delegate to, wherever in the file that's declared) is fully
      // resolvable regardless of source-order relative to its JSX usage --
      // same reasoning as no-raw-error-message.js's own Program:exit
      // deferral (a7138e1), even though this rule's checks don't need
      // `.parent` links the way that one's sink walk does; kept consistent
      // with the proven pattern rather than relying on an unverified belief
      // that scope resolution alone never needs it.
      "Program:exit"() {
        for (const c of candidates) {
          const { node, tag, isRadixItem, onClickAttr, onClickExpr, capabilityNames } = c;

          if (isShadowedByLocalDeclaration(context, node, tag)) continue;

          const bindings = [...capabilityNames];

          if (isRadixItem) {
            if (isGuardedAtEntry(onClickExpr, capabilityNames)) continue;

            const delegateState = resolveDelegateGuardState(context, onClickExpr, capabilityNames);
            if (delegateState === "guarded" || delegateState === "unresolved") continue;

            context.report({
              node: onClickAttr,
              messageId: "unguarded",
              data: {
                tag,
                bindings: bindings.map((name) => `!${name}`).join(" / "),
                firstBinding: bindings[0],
              },
            });
            continue;
          }

          // Native button: missing guard is fine (disabled already blocks
          // the click for real); a PRESENT guard testing the wrong binding
          // is not. No one-hop delegate resolution on this side (see file
          // header) -- a delegating body naturally has no local leading
          // `if`, so it already reads as "no guard attempted" and is
          // correctly left unflagged without needing one.
          if (onClickExpr.body.type !== "BlockStatement") continue;
          const guardNames = collectLeadingGuardNames(onClickExpr.body);
          if (guardNames.size === 0) continue;
          const overlaps = [...guardNames].some((name) => capabilityNames.has(name));
          if (overlaps) continue;

          context.report({
            node: onClickAttr,
            messageId: "mismatchedGuard",
            data: {
              tag,
              bindings: bindings.map((name) => `!${name}`).join(" / "),
              guardBindings: [...guardNames].map((name) => `!${name}`).join(" / "),
            },
          });
        }
      },
    };
  },
};

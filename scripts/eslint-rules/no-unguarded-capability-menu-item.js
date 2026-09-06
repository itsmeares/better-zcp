
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

function collectLeadingGuardNames(blockStatement) {
  const names = new Set();
  for (const stmt of blockStatement.body) {
    if (stmt.type !== "IfStatement" || !consequentReturns(stmt.consequent)) break;
    collectCapabilityNames(stmt.test, names);
  }
  return names;
}

function isGuardedAtEntry(fn, capabilityNames) {
  if (fn.body.type !== "BlockStatement") return false;
  const guardNames = collectLeadingGuardNames(fn.body);
  return [...guardNames].some((name) => capabilityNames.has(name));
}

function findVariableInScope(scope, name) {
  let current = scope;
  while (current) {
    const found = current.variables.find((v) => v.name === name);
    if (found) return found;
    current = current.upper;
  }
  return null;
}

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

function unwrapCallbackWrapper(node) {
  if (node.type === "CallExpression" && node.arguments.length > 0) {
    const first = node.arguments[0];
    if (first.type === "ArrowFunctionExpression" || first.type === "FunctionExpression") return first;
  }
  return node;
}

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

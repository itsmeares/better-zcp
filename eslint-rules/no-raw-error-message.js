/**
 * Raw caught-error messages bypass translation and recovery guidance. This
 * rule catches the display patterns handled by `getUserErrorMessage()`:
 * `error.message` in an `instanceof Error` ternary, logical-or fallbacks, and
 * bare message access.
 *
 * The rule follows one assignment hop and checks both call sinks and JSX
 * output. It intentionally does not perform general data-flow or type
 * analysis, so deeper helper chains and unfamiliar error subclasses may need
 * a manual review.
 *
 * Only values reaching user-visible sinks are checked: direct `toast(...)`
 * arguments, `set...(...)` state updates, and JSX output. Normal API payload
 * fields are excluded by the error-variable-name heuristic below.
 *
 * A two-hop chain through an intermediate helper is outside the intended
 * scope; keep the rule local and predictable rather than building a data-flow
 * engine.
 *
 * Replace flagged values with `getUserErrorMessage(error, fallback)`. Code
 * that intentionally needs raw text should call
 * `rawErrorMessageIntentional(error, fallback)` so the decision is explicit.
 */

// Real error-catch variable names seen across this codebase for shape 2
// (`x.message || fallback`), which has no structural signal as strong as
// shape 1's `instanceof Error` check -- `result.message`, `data.message`,
// `res.message`, `backupProgress.message` etc. are common, legitimate reads
// of a normal API response/progress payload field, not a caught error, and
// must not be flagged. This is a heuristic, not a closed set: a caught
// error bound to a name outside this list is a known blind spot, same
// category as the two-step-assignment limitation above.
const ERROR_LIKE_IDENTIFIER_RE =
  /^(?:err|error|e|ex|exception|apiErr|caughtError|thrownError)$/i;

function unwrapChain(node) {
  return node && node.type === "ChainExpression" ? node.expression : node;
}

function isMessageMemberOf(node, objectName) {
  const member = unwrapChain(node);
  if (!member || member.type !== "MemberExpression") return false;
  if (member.property.type !== "Identifier" || member.property.name !== "message") {
    return false;
  }
  if (member.object.type !== "Identifier") return false;
  return objectName === undefined || member.object.name === objectName;
}

// Shape 1: `x instanceof Error ? x.message : fallback`.
function isSameErrorMessageTernary(node) {
  if (node.type !== "ConditionalExpression") return false;
  const { test, consequent } = node;
  if (test.type !== "BinaryExpression" || test.operator !== "instanceof") {
    return false;
  }
  if (test.left.type !== "Identifier" || test.right.type !== "Identifier") {
    return false;
  }
  if (test.right.name !== "Error") return false;

  return isMessageMemberOf(consequent, test.left.name);
}

// Shape 2: `x?.message || fallback` / `x.message || fallback`, x restricted
// to a common error-variable name (see ERROR_LIKE_IDENTIFIER_RE above).
function isRawMessageLogicalOr(node) {
  if (node.type !== "LogicalExpression" || node.operator !== "||") return false;
  const member = unwrapChain(node.left);
  if (!member || member.type !== "MemberExpression") return false;
  if (member.property.type !== "Identifier" || member.property.name !== "message") {
    return false;
  }
  if (member.object.type !== "Identifier") return false;
  return ERROR_LIKE_IDENTIFIER_RE.test(member.object.name);
}

// True for a bare error-like identifier or a chain whose final property is
// error-like, such as `this.state.error`.
function isErrorLikeReference(node) {
  if (node.type === "Identifier") return ERROR_LIKE_IDENTIFIER_RE.test(node.name);
  if (node.type === "MemberExpression" && node.property.type === "Identifier") {
    return ERROR_LIKE_IDENTIFIER_RE.test(node.property.name);
  }
  return false;
}

// Shape 3: a bare `x.message` / `x?.message` with no fallback. It uses the
// same identifier restriction as shape 2 and supports class-component chains.
// Visited directly as MemberExpression: espree/typescript-eslint parse
// `x?.message` as ChainExpression > MemberExpression, so the traversal
// reaches this exact node either way, optional or not.
function isBareErrorMessageAccess(node) {
  if (node.type !== "MemberExpression") return false;
  if (node.property.type !== "Identifier" || node.property.name !== "message") {
    return false;
  }
  return isErrorLikeReference(node.object);
}

// True when `node` reaches a user-visible `setXxx(...)` or `toast(...)` sink,
// including the functional state-updater shape. The bounded ancestor walk is
// intentionally shallow rather than a general data-flow search.
function isFeedingUserVisibleSink(node) {
  let current = node;
  for (let depth = 0; depth < 8 && current.parent; depth += 1) {
    const parent = current.parent;

    // `{error.message}` rendered directly into markup is also user-visible.
    if (parent.type === "JSXExpressionContainer") {
      return true;
    }

    if (parent.type === "CallExpression" && parent.callee.type === "Identifier") {
      if (/^set[A-Z]/.test(parent.callee.name) && parent.arguments.includes(current)) {
        return true;
      }
      if (parent.callee.name === "toast" && parent.arguments.includes(current)) {
        return true;
      }
    }

    // Keep walking through the Property -> ObjectExpression chain that both
    // `toast({ description: <node> })` and a nested functional-update object
    // (`{ ...prev, error: <node> }`, possibly nested again under a computed
    // key) produce.
    if (
      parent.type === "Property" ||
      parent.type === "ObjectExpression" ||
      parent.type === "ChainExpression"
    ) {
      current = parent;
      continue;
    }

    // `setX(prev => ({ ...prev, error: <node> }))` -- an implicit-return
    // arrow function body sits between the object literal and the set*()
    // call it's the sole argument of.
    if (parent.type === "ArrowFunctionExpression" && parent.body === current) {
      current = parent;
      continue;
    }

    return false;
  }
  return false;
}

// Finds `name` in `scope` or any enclosing scope -- a plain lexical lookup,
// not full data-flow: this is deliberately only strong enough to resolve a
// `const`/`let` declarator's own binding from where it was declared, the
// single relationship the ONE-HOP check below needs.
function findVariableInScope(scope, name) {
  let current = scope;
  while (current) {
    const found = current.variables.find((v) => v.name === name);
    if (found) return found;
    current = current.upper;
  }
  return null;
}

// Follow one const/let assignment before checking whether the value reaches a
// user-visible sink. A second hop through a helper is intentionally outside
// this rule's local, bounded analysis.
//
// Deferred to Program:exit rather than checked inline in the
// VariableDeclarator visitor: ESLint sets a node's `.parent` when it is
// ENTERED during the main traversal, in document order -- a reference that
// occurs LATER in the same block (the toast() call after the const) has not
// been entered yet, and so has no `.parent`, at the point a VariableDeclarator
// visitor for an EARLIER statement would run. Collecting candidates during
// the main pass and walking their references only after the whole file has
// been traversed (Program:exit) guarantees every reference's ancestor chain
// is fully linked before isFeedingUserVisibleSink ever walks it.
function checkVariableFlowGap(context, candidateDeclarators) {
  for (const declarator of candidateDeclarators) {
    const scope = context.sourceCode.getScope(declarator);
    const variable = findVariableInScope(scope, declarator.id.name);
    if (!variable) continue;

    const feedsASink = variable.references.some(
      (reference) =>
        reference.identifier !== declarator.id &&
        reference.isRead() &&
        isFeedingUserVisibleSink(reference.identifier),
    );
    if (feedsASink) {
      context.report({ node: declarator.init, messageId: "rawMessage" });
    }
  }
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow showing a caught error's raw .message directly (via a ternary or a `|| fallback`) in a toast or error state; use getUserErrorMessage() so a registered error code's translation and recovery link aren't silently discarded",
    },
    schema: [],
    messages: {
      rawMessage:
        "This shows the raw, untranslated error text directly, discarding any translated message or recovery link getUserErrorMessage() (lib/errorMessage.ts) would provide for a coded error -- and it behaves identically to that call when no code exists, so there's no downside to switching. If this is a genuinely exceptional site where the raw behavior is intentional, call rawErrorMessageIntentional(error, fallback) (also in lib/errorMessage.ts) instead of this expression to make that exemption explicit.",
    },
  },

  create(context) {
    const candidateDeclarators = [];

    return {
      ConditionalExpression(node) {
        if (!isSameErrorMessageTernary(node)) return;
        if (!isFeedingUserVisibleSink(node)) return;
        context.report({ node, messageId: "rawMessage" });
      },
      LogicalExpression(node) {
        if (!isRawMessageLogicalOr(node)) return;
        if (!isFeedingUserVisibleSink(node)) return;
        context.report({ node, messageId: "rawMessage" });
      },
      MemberExpression(node) {
        if (!isBareErrorMessageAccess(node)) return;
        if (!isFeedingUserVisibleSink(node)) return;
        context.report({ node, messageId: "rawMessage" });
      },
      VariableDeclarator(node) {
        if (!node.init || node.id.type !== "Identifier") return;
        if (node.parent.type !== "VariableDeclaration" || node.parent.kind === "var") return;
        // isBareErrorMessageAccess expects an unwrapped MemberExpression --
        // the MemberExpression visitor above receives that directly because
        // ESLint's traversal reaches the inner node regardless of its
        // ChainExpression wrapper, but `node.init` here IS that wrapper for
        // an optional-chained `err?.message` and must be unwrapped first.
        const isShape =
          isSameErrorMessageTernary(node.init) ||
          isRawMessageLogicalOr(node.init) ||
          isBareErrorMessageAccess(unwrapChain(node.init));
        if (isShape) candidateDeclarators.push(node);
      },
      "Program:exit"() {
        checkVariableFlowGap(context, candidateDeclarators);
      },
    };
  },
};

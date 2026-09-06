
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

function isErrorLikeReference(node) {
  if (node.type === "Identifier") return ERROR_LIKE_IDENTIFIER_RE.test(node.name);
  if (node.type === "MemberExpression" && node.property.type === "Identifier") {
    return ERROR_LIKE_IDENTIFIER_RE.test(node.property.name);
  }
  return false;
}

function isBareErrorMessageAccess(node) {
  if (node.type !== "MemberExpression") return false;
  if (node.property.type !== "Identifier" || node.property.name !== "message") {
    return false;
  }
  return isErrorLikeReference(node.object);
}

function isFeedingUserVisibleSink(node) {
  let current = node;
  for (let depth = 0; depth < 8 && current.parent; depth += 1) {
    const parent = current.parent;

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

    if (
      parent.type === "Property" ||
      parent.type === "ObjectExpression" ||
      parent.type === "ChainExpression"
    ) {
      current = parent;
      continue;
    }

    if (parent.type === "ArrowFunctionExpression" && parent.body === current) {
      current = parent;
      continue;
    }

    return false;
  }
  return false;
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
        // ESLint's traversal reaches the inner node regardless of its
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

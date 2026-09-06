
function isAbsentLiteral(node) {
  if (!node) return false;
  if (node.type === "Identifier" && node.name === "undefined") return true;
  if (node.type === "Literal" && node.value === null) return true;
  return false;
}

function finalAlternate(node) {
  let current = node;
  while (current.type === "ConditionalExpression") {
    current = current.alternate;
  }
  return current;
}

function findAttribute(attributes, name) {
  return attributes.find(
    (attr) => attr.type === "JSXAttribute" && attr.name.type === "JSXIdentifier" && attr.name.name === name,
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Flag a `title` attribute sharing a JSX element with a `disabled` attribute -- Chromium shows no native tooltip on a disabled element, so the title is invisible exactly when it would matter",
    },
    schema: [],
    messages: {
      deadDisabledReason:
        "title is a ternary ending in undefined/null while this element can be disabled -- that text shows ONLY conditionally and nothing otherwise, the exact shape of a disabled-reason string, and Chromium never renders a native tooltip on a disabled element (confirmed empirically). Wrap the control in <DisabledReason reason={...}> (components/DisabledReason.tsx) reusing this same text, instead of the dead title=.",
      possibleDeadTitle:
        "title and disabled coexist on this element, but this rule cannot tell from the code alone whether title is a disabled-reason (dead right now -- wrap in <DisabledReason>) or a hint that's only relevant while enabled (leave it as title=, it already works correctly there) or double duty needing both. Read the referenced copy: if any part of it explains why the control can't be used right now, split it per components/DisabledReason.tsx's Force Stop/Lightning precedent.",
    },
  },

  create(context) {
    return {
      JSXOpeningElement(node) {
        const attributes = node.attributes;
        if (!findAttribute(attributes, "disabled")) return;

        const titleAttr = findAttribute(attributes, "title");
        if (!titleAttr || !titleAttr.value) return;

        if (titleAttr.value.type !== "JSXExpressionContainer") {
          context.report({ node: titleAttr, messageId: "possibleDeadTitle" });
          return;
        }

        const expr = titleAttr.value.expression;
        if (expr.type === "ConditionalExpression") {
          const base = finalAlternate(expr);
          context.report({
            node: titleAttr,
            messageId: isAbsentLiteral(base) ? "deadDisabledReason" : "possibleDeadTitle",
          });
          return;
        }

        context.report({ node: titleAttr, messageId: "possibleDeadTitle" });
      },
    };
  },
};

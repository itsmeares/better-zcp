/**
 * Chromium does not show native tooltips for disabled elements. A conditional
 * `title` on the same element is therefore invisible when it is meant to
 * explain the disabled state. Use `components/DisabledReason.tsx`, which
 * places the tooltip trigger on a focusable wrapper instead.
 *
 * THREE SHAPES FOUND SO FAR, ONLY ONE OF WHICH IS THE BUG:
 *
 *   1. PURE DISABLED-REASON (the actual defect, always invisible while it
 *      matters): `title`'s value is a ternary (possibly a chain of them in
 *      the `alternate` position) whose final, unconditional base case is a
 *      literal `undefined` or `null` -- i.e. the text is shown ONLY under
 *      some condition and nothing otherwise. `!hasServer ? addServerFirst :
 *      isRemote ? notAvailableRemote : undefined` is this shape exactly.
 *      This is the one case the rule can assert as broken without reading
 *      the referenced copy, because the STRUCTURE alone proves the text is
 *      conditional on some state and silently absent otherwise -- exactly
 *      the shape a disabled-reason takes and a hint never does.
 *
 *   2. DOUBLE DUTY: the final branch is not undefined/null, so the value may
 *      contain both a disabled reason and an always-relevant enabled-state
 *      hint. Split those cases instead of wrapping the whole expression.
 *
 *   3. PURE HINT (not a defect at all -- Start Rain, Alarm, Teleport
 *      Player/Self, and several unconditional titles elsewhere): `title`'s
 *      value isn't a ternary shaped like #1, or is a single unconditional
 *      expression. Structurally identical, from the parser's point of
 *      view, to a legitimate always-relevant label or description that
 *      happens to share an element with an unrelated `disabled` cause.
 *      Flagging this as a confirmed bug would be wrong often enough to
 *      train everyone to ignore the rule.
 *
 * THE RULE CANNOT TELL SHAPES 2 AND 3 APART WITHOUT READING THE REFERENCED
 * COPY, so it doesn't try: both land on the SAME lower-confidence message,
 * which says so explicitly and asks for a human read rather than asserting
 * a defect. Shape 1 alone gets the confident message.
 *
 * Both messages are warnings. Shape 1 is mechanically provable; the other
 * shapes need a human read because the rule cannot infer the intended copy.
 *
 * Known gaps, accepted rather than chased (same policy as the other rules
 * in this directory -- documented, not silently assumed complete):
 *   - `title={cond && text}` (a logical-AND short-circuit rather than a
 *     ternary) is not recognized as shape 1 even when it resolves to
 *     `false`/absent on the same branch a ternary would use `undefined`
 *     for.
 *   - Attributes reaching the element through a spread (`{...props}`)
 *     aren't traced -- only literal `title`/`disabled` JSXAttribute nodes
 *     are checked, same limitation as no-duplicate-interface-name's
 *     scope-based exclusions.
 *   - This rule only proves shape 1 is CONDITIONALLY invisible in
 *     structure; it does not (and structurally cannot) check whether the
 *     condition it keys on is the SAME state `disabled` itself checks --
 *     a title conditioned on a different variable than disabled would
 *     still match.
 *   - The inverse defect -- a `disabled` with no `title` at all, when one
 *     genuinely ought to explain a real precondition -- is invisible to
 *     this rule by construction (nothing to key off). That is a design
 *     question (should every gated control explain itself?), not a
 *     structural bug this rule is built to find.
 */

function isAbsentLiteral(node) {
  if (!node) return false;
  if (node.type === "Identifier" && node.name === "undefined") return true;
  if (node.type === "Literal" && node.value === null) return true;
  return false;
}

// Walks a possibly-chained ternary's `alternate` spine (the `: x ? y : z`
// tail) down to its final, non-conditional base case.
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

        // `title="literal"` -- a plain JSX string attribute, not an
        // expression container. Always unconditional -- shape 3, or a rare
        // shape-1-in-spirit case this rule can't structurally confirm.
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

        // Any other expression (a t(...) call, a template literal, a bare
        // identifier, ...) -- unconditional, same as the string-literal case.
        context.report({ node: titleAttr, messageId: "possibleDeadTitle" });
      },
    };
  },
};

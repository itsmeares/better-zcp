/**
 * Chromium shows no native tooltip on a `title={...}` attribute of a
 * disabled element -- confirmed empirically (2026-08-27, a live Chromium
 * test with `<button disabled title="...">`, with and without
 * `pointer-events:none`: zero tooltip in either case). A `title` and a
 * `disabled` attribute on the SAME JSX element is therefore never a safe
 * combination: whatever text `title` carries never reaches an operator
 * while the element is actually disabled, native tooltip mechanics being
 * what they are. The fix in this codebase is `components/DisabledReason.tsx`
 * (a focusable wrapper span that becomes the real Radix Tooltip trigger).
 *
 * Real case: Dashboard.tsx's Start/Force Stop/Restart/Wipe buttons and
 * seven more across Players.tsx and Events.tsx all had correct, six-locale
 * translated copy sitting in a dead `title=` -- see commits dd339a7 and
 * 551c75f. A first counting pass (a `<[A-Za-z]` regex over raw file text)
 * found 49 across the client, then -- while manually re-reading Events.tsx
 * rather than trusting that regex -- three MORE turned up that the regex
 * had silently missed (a naive tag-start regex cannot tell a JSXOpeningElement
 * from a TypeScript generic like `useState<T>()`; no patch fixes that,
 * only a real parser does). That regex is gone; this is the parser-based
 * replacement, and it is a lint RULE rather than a one-off count on
 * purpose -- a count goes stale silently the moment someone adds the next
 * occurrence; a rule fails on it.
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
 *   2. DOUBLE DUTY (found the hard way, twice -- Dashboard's Force
 *      Stop/Wipe, then Events.tsx's Lightning/Thunder): a ternary where the
 *      final branch is NOT undefined/null -- something is shown regardless
 *      of the disabled state. One branch is a genuine disabled-reason, the
 *      other an always-relevant "what this does" hint (forceStopTooltip,
 *      lightningTooltip) that already works correctly while the element is
 *      enabled. Needs SPLITTING (the reason branch moves into
 *      DisabledReason, the hint branch stays a plain title=), never a blind
 *      wrap of the whole ternary -- that would either show a Radix tooltip
 *      on a perfectly clickable element or silently delete a working hint.
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
 * Both messages are reported at the SAME lint severity (see
 * client/eslint.config.js) -- deliberately `warn`, not `error`. Unlike
 * no-duplicate-interface-name (one real violation when it landed, safe to
 * hard-error), the client had dozens of hits across both categories the
 * night this rule shipped. A hard error would force either fixing all of
 * them in one pass or maintaining a per-file exemption list -- and this
 * codebase has already deleted four such lists' worth of stale exemptions
 * tonight for other reasons. `warn` keeps `pnpm run lint` informative
 * without inventing a new list to keep honest forever.
 *
 * Known gaps, accepted rather than chased (same policy as the other rules
 * in this directory -- documented, not silently assumed complete):
 *   - `title={cond && text}` (a logical-AND short-circuit rather than a
 *     ternary) is not recognized as shape 1 even when it resolves to
 *     `false`/absent on the same branch a ternary would use `undefined`
 *     for. No real site used this shape as of this rule landing.
 *   - Attributes reaching the element through a spread (`{...props}`)
 *     aren't traced -- only literal `title`/`disabled` JSXAttribute nodes
 *     are checked, same limitation as no-duplicate-interface-name's
 *     scope-based exclusions.
 *   - This rule only proves shape 1 is CONDITIONALLY invisible in
 *     structure; it does not (and structurally cannot) check whether the
 *     condition it keys on is the SAME state `disabled` itself checks --
 *     a title conditioned on a different variable than disabled would
 *     still match. No real site found this gap live as of landing.
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

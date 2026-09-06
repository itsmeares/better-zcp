import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../../../scripts/eslint-rules/no-unguarded-capability-menu-item.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("no-unguarded-capability-menu-item", () => {
  it("flags a capability-gated Radix item onClick with no matching early-return guard, and nothing else", () => {
    ruleTester.run("no-unguarded-capability-menu-item", rule, {
      valid: [
        // Native button, guard present and correct.
        "<Button disabled={!canModerate} onClick={() => { if (!canModerate) return; doThing() }} />",
        // Native button, guard present but tests something unrelated to capabilities (ordinary loading logic) -- not a mismatch.
        "<Button disabled={!canModerate} onClick={() => { if (loading) return; doThing() }} />",
        // Native button, disabled references no capability at all -- out of scope either way.
        "<Button disabled={loading} onClick={() => { if (somethingElse) return; doThing() }} />",
        // Guarded: first statement is `if (!canX) return`, same binding as disabled.
        "<DropdownMenuItem disabled={!canModerate} onClick={() => { if (!canModerate) return; doThing() }} />",
        // Guard can appear after other logic is skipped -- still first statement, negation via !.
        "<DropdownMenuItem disabled={loading || !canBridgeGmTools} onClick={() => { if (!canBridgeGmTools) return; handleGodMode(true) }} />",
        // Consequent as a block containing a return is still a guard.
        "<ContextMenuItem disabled={!canGmTools} onClick={() => { if (!canGmTools) { return } doThing() }} />",
        // A regular function expression, not just an arrow.
        "<SelectItem disabled={!canModerate} onClick={function () { if (!canModerate) return; doThing() }} />",
        // A native button with NO guard at all is never flagged -- disabled genuinely blocks the click for real.
        "<button disabled={!canModerate} onClick={() => doThing()} />",
        "<Button disabled={!canModerate} onClick={() => doThing()} />",
        // A Radix item with no disabled at all isn't this rule's concern.
        "<DropdownMenuItem onClick={() => doThing()} />",
        // disabled references no can*-named identifier -- not a capability check by this rule's heuristic.
        "<DropdownMenuItem disabled={loading} onClick={() => doThing()} />",
        // No onClick at all -- nothing to guard.
        "<DropdownMenuItem disabled={!canModerate} />",
        // onClick is a bare identifier reference -- can't verify locally, accepted gap, not flagged.
        "<DropdownMenuItem disabled={!canModerate} onClick={handleClick} />",
        // Cause 1 (0/10 run, WorldMap.tsx): the JSX tag resolves to a LOCAL
        // declaration in this file, not an import -- can't assume it renders
        // a Radix div, so it's skipped entirely regardless of its own
        // disabled/onClick shape.
        "function ContextMenuItem({ disabled, onClick }) { return <button disabled={disabled} onClick={onClick} />; } <ContextMenuItem disabled={!canWorldEvents} onClick={() => doThing()} />;",
        // Same shadow protection for a locally-declared native-button-named component.
        "function Button({ disabled, onClick }) { return <button disabled={disabled} onClick={onClick} />; } <Button disabled={!canModerate} onClick={() => { if (!canGmTools) return; doThing() }} />;",
        // An IMPORTED name of the same tag is NOT a local declaration --
        // still analyzed normally (this is the ordinary Radix-import case).
        "import { DropdownMenuItem } from '@/components/ui/dropdown-menu'; <DropdownMenuItem disabled={!canModerate} onClick={() => { if (!canModerate) return; doThing() }} />;",
        // Cause 2 (0/10 run, Servers.tsx:1610): onClick delegates in a
        // single call to a same-file function whose OWN leading guard run
        // references the right binding -- one hop, resolved, guarded.
        "function handleActivate() { if (loading) return; if (!canServersManage) return; doThing(); } <DropdownMenuItem disabled={!canServersManage} onClick={() => handleActivate()} />;",
        // Same shape, block-bodied arrow instead of expression-bodied.
        "function handleActivate() { if (!canServersManage) return; doThing(); } <DropdownMenuItem disabled={!canServersManage} onClick={() => { handleActivate() }} />;",
        // Same shape, target wrapped in useCallback -- the real Servers.tsx shape.
        "const handleActivate = useCallback(() => { if (!canServersManage) return; doThing(); }, []); <DropdownMenuItem disabled={!canServersManage} onClick={() => handleActivate()} />;",
        // Delegate target can't be resolved locally (imported) -- fallback
        // policy: skip rather than flag, since it might be guarded elsewhere.
        "import { handleActivate } from './handlers'; <DropdownMenuItem disabled={!canServersManage} onClick={() => handleActivate()} />;",
        // Guard present but not literally the first statement -- still
        // counts as long as it's in the LEADING run before any real work.
        "<DropdownMenuItem disabled={!canModerate} onClick={() => { if (loading) return; if (!canModerate) return; doThing() }} />",
      ],
      invalid: [
        {
          // A bare single-call expression body IS the one-hop delegate
          // shape, but the callee resolves to a same-file function with no
          // guard at all -- a CONFIRMED finding (see the two dedicated
          // one-hop cases further down for the general shape).
          code: "function doThing() { performMutation() } <DropdownMenuItem disabled={!canModerate} onClick={() => doThing()} />;",
          errors: [{ messageId: "unguarded" }],
        },
        {
          // Two statements -- structurally outside the one-hop "sole call"
          // delegate shape either way, has no room for a guard statement.
          code: "<DropdownMenuItem disabled={loading || !canGmTools} onClick={() => { doThing(); doOther() }} />",
          errors: [{ messageId: "unguarded" }],
        },
        {
          // Block body, but the guard isn't the FIRST statement.
          code: "<ContextMenuItem disabled={!canModerate} onClick={() => { doOtherThing(); if (!canModerate) return; doThing() }} />",
          errors: [{ messageId: "unguarded" }],
        },
        {
          // First statement is an if, but it tests an unrelated condition.
          code: "<MenubarItem disabled={!canModerate} onClick={() => { if (loading) return; doThing() }} />",
          errors: [{ messageId: "unguarded" }],
        },
        {
          // If-test references the right binding but the consequent doesn't return.
          code: "<CommandItem disabled={!canModerate} onClick={() => { if (!canModerate) { doNothing() } doThing() }} />",
          errors: [{ messageId: "unguarded" }],
        },
        {
          // No guard at all, function expression form, and the sole-call
          // body's callee resolves locally with no guard of its own either.
          code: "function doThing() { performMutation() } <SelectItem disabled={!canGmTools} onClick={function () { doThing() }} />;",
          errors: [{ messageId: "unguarded" }],
        },
        {
          // Native button: guard present, but tests a DIFFERENT capability
          // than its own disabled prop -- Angela's Debug.tsx break-verify
          // shape, invisible to any click-through test since disabled
          // genuinely blocks a real click here.
          code: "<Button disabled={!canModerate} onClick={() => { if (!canGmTools) return; doThing() }} />",
          errors: [{ messageId: "mismatchedGuard" }],
        },
        {
          code: "<button disabled={!canModerate} onClick={() => { if (!canGmTools) return; doThing() }} />",
          errors: [{ messageId: "mismatchedGuard" }],
        },
        {
          // One-hop delegate resolves to a same-file function, but that
          // function genuinely has no guard at all -- a confirmed finding,
          // not an uncertain one, so it IS flagged (the fallback-skip
          // policy only applies when resolution itself fails).
          code: "function handleActivate() { doThing(); } <DropdownMenuItem disabled={!canServersManage} onClick={() => handleActivate()} />;",
          errors: [{ messageId: "unguarded" }],
        },
        {
          // One-hop delegate resolves, and its leading guard run tests the
          // WRONG capability -- also a confirmed finding.
          code: "function handleActivate() { if (!canGmTools) return; doThing(); } <DropdownMenuItem disabled={!canServersManage} onClick={() => handleActivate()} />;",
          errors: [{ messageId: "unguarded" }],
        },
      ],
    });
  });
});

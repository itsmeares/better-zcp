import { describe } from 'vitest'
import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
// @ts-expect-error -- plain JS rule module, no type declarations
import rule from '../../../../../scripts/eslint-rules/no-dead-disabled-title.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

// scripts/eslint-rules/no-dead-disabled-title.js: a `title` sharing an element with
// `disabled` is invisible while disabled (Chromium shows no native tooltip
// on a disabled element, confirmed empirically 2026-08-27). Real cases:
// Dashboard's Start/Force Stop/Restart/Wipe (dd339a7), Events.tsx's quick
// sounds/horde/vehicle buttons (551c75f). Two severities of finding: a
// ternary ending in undefined/null is the confirmed dead-reason shape
// (deadDisabledReason); anything else sharing the element is structurally
// ambiguous between a live hint and a reason needing a split
// (possibleDeadTitle) -- see Force Stop/Lightning's double-duty ternaries,
// which are NOT the confident shape since their final branch is real text,
// not undefined.
describe('local/no-dead-disabled-title', () => {
  ruleTester.run('no-dead-disabled-title', rule, {
    valid: [
      // No `disabled` at all -- a title on an always-enabled element works
      // fine natively; not this rule's class.
      '<button title={t("hint")}>{label}</button>',

      // `disabled` with no `title` at all -- nothing dead to report. (The
      // inverse case -- should this control explain itself? -- is a design
      // question the rule can't answer, documented in the file header.)
      '<button disabled={loading}>{label}</button>',

      // Native <abbr title> etc with no disabled prop -- same as the first
      // case, just a different element type.
      '<abbr title="abbreviation">{text}</abbr>',
    ],
    invalid: [
      {
        // The confirmed shape: text shown ONLY when a condition holds,
        // nothing (undefined) otherwise -- Dashboard's Start button before
        // dd339a7.
        code: '<Button disabled={!hasServer || isRemote} title={!hasServer ? addServerFirst : isRemote ? notAvailableRemote : undefined}>{label}</Button>',
        errors: [{ messageId: 'deadDisabledReason' }],
      },
      {
        // Single-level ternary ending in `undefined` -- Events.tsx's
        // Helicopter/Gunshot before 551c75f.
        code: '<Button disabled={loading || players.length === 0} title={players.length === 0 ? noPlayersOnlineTitle : undefined}>{label}</Button>',
        errors: [{ messageId: 'deadDisabledReason' }],
      },
      {
        // Ending in `null` is the same shape as `undefined`.
        code: '<Button disabled={busy} title={busy ? busyReason : null}>{label}</Button>',
        errors: [{ messageId: 'deadDisabledReason' }],
      },
      {
        // DOUBLE DUTY: the final branch is real text, not undefined --
        // Dashboard's Force Stop / Events.tsx's Lightning before their
        // fixes. Structurally ambiguous, not the confident shape.
        code: '<Button disabled={isRemote} title={isRemote ? notAvailableRemote : forceStopTooltip}>{label}</Button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        // PURE HINT: unconditional title, no ternary at all -- Events.tsx's
        // Start Rain/Teleport Self. Ambiguous, not asserted as broken.
        code: '<Button disabled={bridgeLoading} title={t("climate.rainTooltip")}>{label}</Button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        // A plain string literal title, unconditional -- same ambiguous
        // bucket as the call-expression case above.
        code: '<button disabled={dismissing} title="Dismiss">{icon}</button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        // Nested ternary where NO branch is undefined -- ChunkCleaner's
        // canvas path title (three real strings depending on folder state).
        // All-branches-real-text is the same ambiguous shape as double duty,
        // not the confident one, even though it's a 3-way chain.
        code: '<button disabled={!s.exists || loadingSaves} title={s.exists ? (s.hasSaves ? hasSavesText : folderExistsText) : folderMissingText}>{path}</button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        // Bare `disabled` (no value, implies true) still counts as the
        // attribute being present.
        code: '<button disabled title={reason}>{label}</button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
    ],
  })
})

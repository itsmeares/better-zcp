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
        code: '<Button disabled={!hasServer || isRemote} title={!hasServer ? addServerFirst : isRemote ? notAvailableRemote : undefined}>{label}</Button>',
        errors: [{ messageId: 'deadDisabledReason' }],
      },
      {
        code: '<Button disabled={loading || players.length === 0} title={players.length === 0 ? noPlayersOnlineTitle : undefined}>{label}</Button>',
        errors: [{ messageId: 'deadDisabledReason' }],
      },
      {
        code: '<Button disabled={busy} title={busy ? busyReason : null}>{label}</Button>',
        errors: [{ messageId: 'deadDisabledReason' }],
      },
      {
        code: '<Button disabled={isRemote} title={isRemote ? notAvailableRemote : forceStopTooltip}>{label}</Button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        code: '<Button disabled={bridgeLoading} title={t("climate.rainTooltip")}>{label}</Button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        code: '<button disabled={dismissing} title="Dismiss">{icon}</button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        code: '<button disabled={!s.exists || loadingSaves} title={s.exists ? (s.hasSaves ? hasSavesText : folderExistsText) : folderMissingText}>{path}</button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
      {
        code: '<button disabled title={reason}>{label}</button>',
        errors: [{ messageId: 'possibleDeadTitle' }],
      },
    ],
  })
})

import { describe } from 'vitest'
import { RuleTester } from 'eslint'
// @ts-expect-error -- plain JS rule module, no type declarations
import rule from '../../../../../scripts/eslint-rules/no-raw-error-message.js'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
})

describe('local/no-raw-error-message', () => {
  ruleTester.run('no-raw-error-message', rule, {
    valid: [
      // The fix this rule exists to push people toward.
      "toast({ description: getUserErrorMessage(error, 'fallback') })",
      "setDetectError(getUserErrorMessage(error, 'fallback'))",

      // The documented escape hatch -- a CallExpression, not the ternary
      // shape, so it never matches regardless of context.
      "toast({ description: rawErrorMessageIntentional(error, 'fallback') })",

      // Different identifiers on each side -- not the same-error idiom,
      // just code that happens to share some tokens.
      "toast({ description: a instanceof Error ? b.message : 'fallback' })",

      // Not `.message` at all.
      "toast({ description: error instanceof Error ? error.code : 'fallback' })",

      // errorMessage.ts's own getRecoveryUrl(): builds the string to
      // pattern-match against, never assigns it to a toast/state call.
      "function f(error) { const message = error instanceof Error ? error.message : String(error || ''); if (/rcon/i.test(message)) return '/servers'; }",

      // client-errors.ts's diagnostic payload: sent to the server for
      // logging, not shown to the user -- not a toast()/set*() argument.
      "fetch('/api/debug/client-errors', { body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) })",

      // A call whose name doesn't match the toast()/set*() shapes this
      // rule targets.
      "logSomething(error instanceof Error ? error.message : 'fallback')",

      // Shape 2 (`x?.message || fallback`), legitimate uses: reading a
      // normal API response/progress field, not a caught error -- real
      // sites found for both (Backups.tsx's backupProgress, Debug.tsx's
      // result/data). Excluded by the identifier not matching
      // ERROR_LIKE_IDENTIFIER_RE, not by sink scoping.
      "toast({ description: backupProgress?.message || fallbackText })",
      "setStatus(result?.message || fallbackText)",

      // Shape 3 (bare `x.message`, no fallback), legitimate use: a normal
      // API response field, not a caught error -- excluded by identifier,
      // same as shape 2's equivalents.
      "toast({ description: result.message })",
      "setStatus(data?.message)",

      // JSX sink (testing, 2026-08-26), legitimate use: a non-error-like chain
      // rendered straight into markup -- not excluded by sink, excluded by
      // the object not being error-like.
      'const el = <p>{data.message}</p>',
      // Same shape, chain two levels deep -- the last segment ("count") is
      // not error-like either, so isErrorLikeReference must reject it
      // rather than matching on ANY member access ending in a plausible word.
      'const el = <p>{this.state.error.count}</p>',
      // `.message` accessed on a chain, with no other statement referencing
      // the variable at all -- the one-hop check (2026-08-27) has nothing to
      // walk, so this stays valid the same way a totally unused variable
      // would.
      'const msg = this.state.error.message',

      // One-hop check (2026-08-27), Setup.tsx's real shape: the two-step
      // variable is used ONLY as a comparison operand, never fed to a sink
      // -- isFeedingUserVisibleSink correctly rejects a BinaryExpression
      // test as an ancestor shape, so this must stay valid even though the
      // variable IS referenced again.
      "const message = err instanceof Error ? err.message : ''; setError(message === 'SETUP_TOKEN_REQUIRED' ? t('errors.invalidSetupToken') : getUserErrorMessage(err, t('errors.setupFailed')))",

      // `var`, not `const`/`let` -- the one-hop check deliberately does not
      // reason about var's reassignment/hoisting semantics.
      "var msg = error instanceof Error ? error.message : 'fallback'; toast({ description: msg })",

      // Two-HOP chain through an intermediate function call -- the real
      // ServerSetup.tsx shape (`raw` feeds installationErrorGuidance(),
      // NOT a sink directly; the helper's return value, a different
      // variable, is what reaches toast()). Documented as a known,
      // still-open gap in checkVariableFlowGap's own comment, not chased:
      // this must stay valid.
      "const raw = error instanceof Error ? error.message : t('common.unknownError'); const msg = installationErrorGuidance(raw, t, platform); toast({ description: msg })",

      // ANOTHER still-open gap, different shape -- the real Servers.tsx:1014
      // site: the two-step variable is embedded inside an i18n
      // interpolation (`t(key, { message: msg })`), and it is t()'s RETURN
      // VALUE, not msg itself, that reaches toast()'s description. Catching
      // this needs the walk to treat a `t(...)` call as a transparent
      // pass-through -- a different, broader widening than the one-hop
      // variable check adds here, and not attempted (see this rule's top
      // comment). Must stay valid until/unless that's built.
      "const msg = e instanceof Error ? e.message : t('toasts.couldNotDeleteFiles'); toast({ title: t('toasts.warningTitle'), description: t('toasts.removingFromPanelAnyway', { message: msg }), variant: 'destructive' })",
    ],
    invalid: [
      {
        code: "toast({ title: t('toasts.error'), description: error instanceof Error ? error.message : t('toasts.fallback'), variant: 'destructive' })",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "setDetectError(error instanceof Error ? error.message : t('toasts.detectionFailed'))",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "setBridgeError(err instanceof Error ? err.message : t('errors.couldNotStartSftpBridge'))",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "toast({ description: error instanceof Error ? error?.message : 'fallback' })",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "toast({ variant: 'destructive', title: t('title'), description: err?.message || t('fallback') })",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "setDiffError(apiErr.message || t('failedToReadCollection'))",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "setCollectionStatus((s) => ({ ...s, loading: false, error: err?.message || 'Network error' }))",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "setDepSearchData(prev => ({ ...prev, [key]: { loading: false, results: [], error: err?.message || t('searchFailed'), searchUrl: null } }))",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "toast({ title: t('toasts.serverRunningTitle'), description: err.message, variant: 'destructive' })",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: 'setDetectError(error?.message)',
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: 'const el = <p>{error.message}</p>',
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: 'const el = <pre>{this.state.error.message}</pre>',
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: 'const el = <pre>{this.props.error.message}</pre>',
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "const msg = error instanceof Error ? error.message : 'fallback'; toast({ description: msg })",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "function f() { if (!mountedRef.current) return; const msg = err instanceof Error ? err.message : t('toasts.areaNotLoaded'); toast({ title: t('toasts.airdropFailedTitle'), description: msg, variant: 'destructive' }) }",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "const msg = err?.message || t('fallback'); setDetectError(msg)",
        errors: [{ messageId: 'rawMessage' }],
      },
      {
        code: "const msg = err?.message; setCollectionStatus((s) => ({ ...s, loading: false, error: msg }))",
        errors: [{ messageId: 'rawMessage' }],
      },
    ],
  })
})

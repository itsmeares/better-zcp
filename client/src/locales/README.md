# Adding a language

1. **Register it.** Add one row to `LANGUAGES` in `client/src/i18n/languages.ts`:
   ```ts
   { code: 'de', nativeName: 'Deutsch' }
   ```
   `nativeName` is the language's own name for itself, not its English name — this is what shows in the switcher menu, in every language.

2. **Add the folder.** Create `client/src/locales/de/` and copy every `.json` file from `client/src/locales/en/` into it (same filenames — each one is a namespace, e.g. `login.json`, `setup.json`, `shell.json`). Translate the values; never rename or add keys, only translate them.

3. **Check your work.** Run:
   ```
   pnpm exec vitest run src/locales/__tests__/localeParity.test.ts
   ```
   This is discovery-based — it finds every language folder and every namespace file on its own, so a new language is tested automatically. It fails loudly, one test per `language/namespace` pair, listing exactly which keys are missing, which are stale/misspelled, and which are present but empty. There is nothing else to configure for a new language to be checked.

That's it — no other file should need touching. If you find yourself editing `i18n/index.ts`, `LanguageSwitcher.tsx`, or the parity test itself to add a language, something has regressed back to being hardcoded; fix that instead of the symptom.

## What the parity test does NOT check

It checks that every language has the same **keys** as English (`en`, the source of truth — see `SOURCE_LANGUAGE` in `languages.ts`). It does not check that the **translated text is correct**, or that two different keys weren't accidentally translated to the same phrase (a real bug that shipped once — see git history for `nav.items.serverSetup` in `fr/shell.json`). Structure passing is not the same as the rendered screen being right — look at it before trusting it.

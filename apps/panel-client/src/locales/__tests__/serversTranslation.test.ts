import { describe, expect, it } from 'vitest'
import en from '../en/servers.json'
import de from '../de/servers.json'
import fr from '../fr/servers.json'
import es from '../es/servers.json'
import ht from '../ht/servers.json'
import zhCN from '../zh-CN/servers.json'

const localizedServers = { de, fr, es, ht, 'zh-CN': zhCN }

describe('server-management translations', () => {
  it('translates lifecycle help and command placeholders in every supported locale', () => {
    const keys = [
      'lifecycleProviderLabel',
      'lifecycleProviderHint',
      'lifecycleMigrationWarning',
      'lifecycleDownloadTemplate',
      'lifecycleActivate',
      'lifecycleConfirmTitle',
      'lifecycleConfirmDesc',
      'lifecycleTemplateReadyTitle',
      'lifecycleTemplateReadyDesc',
      'lifecycleTemplateFailed',
      'lifecycleActivatedTitle',
      'lifecycleActivationFailed',
      'lifecycleCompleteFirst',
      'customStartCommandPlaceholder',
      'customStartCommandPlaceholderWindows',
      'customStartCommandPlaceholderPosix',
    ] as const

    for (const [locale, translations] of Object.entries(localizedServers)) {
      for (const key of keys) {
        expect(
          translations.editDialog[key],
          `${locale} is missing a translation for editDialog.${key}`,
        ).toBeTypeOf('string')
        expect(
          translations.editDialog[key],
          `${locale} still uses the English editDialog.${key}`,
        ).not.toBe(en.editDialog[key])
      }
    }
  })

  it('translates all platform-specific installation path placeholders', () => {
    for (const [locale, translations] of Object.entries(localizedServers)) {
      expect(translations.localForm.installPathPlaceholder, locale).not.toBe(
        en.localForm.installPathPlaceholder,
      )
      expect(translations.localForm.installPathPlaceholderWindows, locale).not.toBe(
        en.localForm.installPathPlaceholderWindows,
      )
      expect(translations.localForm.installPathPlaceholderPosix, locale).not.toBe(
        en.localForm.installPathPlaceholderPosix,
      )
    }
  })
})
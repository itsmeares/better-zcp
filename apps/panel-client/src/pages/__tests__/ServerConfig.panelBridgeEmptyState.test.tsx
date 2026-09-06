import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useTranslation } from 'react-i18next'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HelpTip } from '@/components/HelpTip'
import { EmptyState } from '@/components/EmptyState'

// Mirrors the exact composition ServerConfig.tsx's mod-settings "not loaded"
// EmptyState uses -- real locale strings, not stand-ins -- to prove the
// EmptyState ReactNode-description seam actually closes the gap it was cut
// for: the mod-settings tab's own copy names the app-specific term
// "PanelBridge" with nowhere to explain it until EmptyState's description
// accepted more than a plain string.
function ModSettingsNotLoaded() {
  const { t } = useTranslation('serverconfig')
  return (
    <EmptyState
      type="noMods"
      title={t('modSettingsTab.notLoadedTitle')}
      description={
        <span>
          {t('modSettingsTab.notLoadedDescPrefix')}
          <HelpTip label={t('modSettingsTab.panelBridgeLabel')}>
            {t('modSettingsTab.panelBridgeTip')}
          </HelpTip>
          {t('modSettingsTab.notLoadedDescSuffix')}
        </span>
      }
    />
  )
}

describe('ServerConfig -- mod settings "not loaded" EmptyState', () => {
  it('renders the real notLoadedDesc copy with an inline HelpTip on "PanelBridge" that reveals its real definition on click', async () => {
    render(
      <TooltipProvider>
        <ModSettingsNotLoaded />
      </TooltipProvider>
    )
    expect(screen.getByText('Mod settings not loaded')).toBeInTheDocument()
    expect(screen.getByText(/Click load to fetch sandbox options from all installed mods via PanelBridge/)).toBeInTheDocument()
    expect(screen.getByText(/The PZ server must be running with PanelBridge active\./)).toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: 'Help: PanelBridge' })
    fireEvent.click(trigger)
    await waitFor(() =>
      expect(
        screen.getByText(/PanelBridge is the Lua mod that runs on the game server/)
      ).toBeInTheDocument()
    )
  })
})

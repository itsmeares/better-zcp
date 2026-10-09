import { NumberInput } from '@/components/NumberInput'
import { SettingsRow } from '@/components/settings-layout'
import { Switch } from '@/components/ui/switch'

export interface WaitPolicy {
  /** Minutes to wait for the server to empty. */
  waitMinutes: number
  /** At the end of the wait: warn players and go ahead anyway, or skip. */
  force: boolean
  /** Countdown players get when it goes ahead anyway. */
  warningMinutes: number
}

/**
 * The same three choices for every automatic job that stops the server:
 * wait for an empty server, then either skip or warn and go ahead.
 */
export function WaitPolicyFields({ policy, onChange, waitRange, action }: { policy: WaitPolicy; onChange: (next: WaitPolicy) => void; waitRange: [number, number]; action: string }) {
  return (
    <>
      <SettingsRow label="Wait for an empty server" description={`Between ${waitRange[0]} and ${waitRange[1]} minutes.`}>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <NumberInput className="w-24" min={waitRange[0]} max={waitRange[1]} value={policy.waitMinutes} onChange={(waitMinutes) => onChange({ ...policy, waitMinutes })} aria-label="Minutes to wait" />
          minutes
        </div>
      </SettingsRow>
      <SettingsRow
        label={`${action} even if players are still on`}
        description={policy.force ? `Players get a countdown before the wait ends, then the ${action.toLowerCase()} goes ahead.` : `If players are still on when the wait ends, the ${action.toLowerCase()} is skipped until next time.`}
      >
        <Switch checked={policy.force} onCheckedChange={(force) => onChange({ ...policy, force })} aria-label={`${action} even if players are still on`} />
      </SettingsRow>
      {policy.force && (
        <SettingsRow label="Warn players" description="How long the countdown runs.">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <NumberInput className="w-24" min={1} max={30} value={policy.warningMinutes} onChange={(warningMinutes) => onChange({ ...policy, warningMinutes })} aria-label="Warning minutes" />
            minutes before
          </div>
        </SettingsRow>
      )}
    </>
  )
}

import { useMemo } from 'react'
import { Autocomplete, AutocompleteEmpty, AutocompleteInput, AutocompleteItem, AutocompleteList, AutocompletePopup } from '@/components/ui/autocomplete'

type IntlWithSupportedValues = typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }

function timezones(): string[] {
  let canonical: string[] = []
  try {
    canonical = (Intl as IntlWithSupportedValues).supportedValuesOf?.('timeZone') ?? []
  } catch {
    // Older engines lack supportedValuesOf; UTC and typed names still work.
  }
  return Array.from(new Set(['UTC', ...canonical]))
}

/** IANA timezone picker. Typing a name the list doesn't know is still allowed. */
export function TimezoneField({ id, value, onChange, disabled }: { id: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const zones = useMemo(timezones, [])
  return (
    <Autocomplete items={zones} value={value} onValueChange={(next) => onChange(String(next ?? ''))} disabled={disabled}>
      <AutocompleteInput id={id} className="w-64 font-mono" placeholder="America/New_York" />
      <AutocompletePopup>
        <AutocompleteEmpty>No matching timezone.</AutocompleteEmpty>
        <AutocompleteList>
          {(zone: string) => (
            <AutocompleteItem key={zone} value={zone} className="font-mono">
              {zone}
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  )
}

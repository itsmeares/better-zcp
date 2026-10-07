import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { SHORTCUTS } from '@/hooks/useKeyboardShortcuts'

const GROUPS = [...new Set(SHORTCUTS.map((s) => s.group))]

export function KeyboardShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts don't fire while you type in a field.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5">
          {GROUPS.map((group) => (
            <section key={group}>
              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{group}</h3>
              <ul className="grid gap-1">
                {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                  <li key={s.key} className="flex items-center justify-between gap-4 text-sm">
                    <span>{s.label}</span>
                    <KbdGroup>
                      {s.key.split(/[+ ]/).map((part) => (
                        <Kbd key={part}>{part}</Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

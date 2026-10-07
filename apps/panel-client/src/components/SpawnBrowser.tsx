import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { NumberInput } from '@/components/NumberInput'
import { ItemPicker } from './ItemPicker'

interface RecentItem {
  id: string
  qty: number
}

const RECENT_KEY = 'pz-spawn-recent-items'

function readRecent(): RecentItem[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(value)
      ? value.filter((item): item is RecentItem =>
          typeof item?.id === 'string' && Number.isInteger(item.qty) && item.qty > 0,
        ).slice(0, 8)
      : []
  } catch {
    return []
  }
}

export function SpawnBrowser({
  open,
  onOpenChange,
  playerName,
  onSpawn,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  playerName: string
  onSpawn: (id: string, qty?: number) => Promise<void>
}) {
  const [itemId, setItemId] = useState('')
  const [qty, setQty] = useState(1)
  const [spawning, setSpawning] = useState(false)
  const [recent, setRecent] = useState<RecentItem[]>([])

  useEffect(() => {
    if (!open) return
    setItemId('')
    setQty(1)
    setRecent(readRecent())
  }, [open])

  const give = async (id: string, count: number) => {
    if (!playerName || spawning) return
    setSpawning(true)
    try {
      await onSpawn(id, count)
      const next = [{ id, qty: count }, ...recent.filter((item) => item.id !== id)].slice(0, 8)
      setRecent(next)
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)) } catch { /* storage disabled */ }
      setItemId('')
    } catch {
      // The parent reports the action error and keeps the selection for retry.
    } finally {
      setSpawning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Give items</DialogTitle>
          <DialogDescription>Items go straight into {playerName || 'the selected player'}'s inventory. Give as many as you like.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <ItemPicker value={itemId} onChange={setItemId} disabled={spawning} />
          <div className="flex items-center gap-3">
            <Label htmlFor="spawn-qty">Quantity</Label>
            <NumberInput
              id="spawn-qty"
              value={qty}
              onChange={(n) => { if (Number.isFinite(n)) setQty(n) }}
              clamp={(n) => Math.max(1, Math.min(100, n))}
              min={1}
              max={100}
              disabled={spawning}
              className="w-20"
            />
            <Button className="ms-auto" disabled={!itemId || !playerName || spawning} onClick={() => void give(itemId, qty)}>
              {spawning && <Spinner />}
              Give
            </Button>
          </div>
          {recent.length > 0 && (
            <div className="grid gap-2 border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Recent items</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear recent items"
                  onClick={() => {
                    setRecent([])
                    try { localStorage.removeItem(RECENT_KEY) } catch { /* storage disabled */ }
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {recent.map((item) => (
                  <Button key={item.id} variant="outline" size="sm" disabled={spawning || !playerName} onClick={() => void give(item.id, item.qty)}>
                    {item.id} × {item.qty}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

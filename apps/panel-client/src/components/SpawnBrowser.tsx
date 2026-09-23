import { useEffect, useState } from 'react'
import { Loader2, Package, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
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
      <DialogContent className="w-[min(560px,95vw)] max-w-[min(560px,95vw)]">
        <div className="flex items-center gap-3">
          <Package className="h-5 w-5 text-primary" />
          <div>
            <DialogTitle>Give items</DialogTitle>
            <DialogDescription>Giving to {playerName || 'a selected player'}</DialogDescription>
          </div>
        </div>
        <ItemPicker value={itemId} onChange={setItemId} disabled={spawning} />
        <div className="flex items-center gap-3">
          <label htmlFor="spawn-qty" className="text-sm">Quantity</label>
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
          <Button
            className="ms-auto"
            disabled={!itemId || !playerName || spawning}
            onClick={() => void give(itemId, qty)}
          >
            {spawning && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            Give
          </Button>
        </div>
        {recent.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Recent items</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Clear recent items"
                onClick={() => {
                  setRecent([])
                  try { localStorage.removeItem(RECENT_KEY) } catch { /* storage disabled */ }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {recent.map((item) => (
                <Button
                  key={item.id}
                  variant="outline"
                  size="sm"
                  disabled={spawning || !playerName}
                  onClick={() => void give(item.id, item.qty)}
                >
                  {item.id} × {item.qty}
                </Button>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

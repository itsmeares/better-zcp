import { useEffect, useState } from 'react'

const AUTH_BOOT_STEPS = [
  { code: 'AUTH', label: 'Verifying credentials' },
  { code: 'LINK', label: 'Opening control channel' },
  { code: 'SYNC', label: 'Restoring panel state' },
  { code: 'NET ', label: 'Pinging live servers' },
  { code: 'OK  ', label: 'Standing by' },
]

export function AuthScreenLoader() {
  const [stepIndex, setStepIndex] = useState(0)
  const [tick, setTick] = useState(0)
  const totalSteps = AUTH_BOOT_STEPS.length

  useEffect(() => {
    const stepTimer = window.setInterval(() => {
      setStepIndex((current) => Math.min(current + 1, totalSteps - 1))
    }, 350)
    const tickTimer = window.setInterval(() => {
      setTick((current) => (current + 1) % 4)
    }, 500)
    return () => {
      window.clearInterval(stepTimer)
      window.clearInterval(tickTimer)
    }
  }, [totalSteps])

  const now = new Date()
  const clock = now.toISOString().slice(11, 19)
  const dots = '·'.repeat(tick) + ' '.repeat(3 - tick)
  const progress = Math.round(((stepIndex + 1) / totalSteps) * 100)
  const segments = 24
  const lit = Math.round((segments * (stepIndex + 1)) / totalSteps)

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 py-10">
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 50% 30%, hsl(var(--primary) / 0.10), transparent 55%), radial-gradient(circle at 12% 110%, hsl(var(--destructive) / 0.10), transparent 45%), linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
        }}
      />
      <div
        aria-hidden="true"
        className="control-room-sweep absolute inset-0 opacity-40"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 220px 40px hsl(var(--background))' }}
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
        <span>Project Zomboid // Control Panel</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80 shadow-[0_0_8px_hsl(var(--primary)/0.6)]" />
          <span>Secure Handshake</span>
        </span>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/60">
        <span>{clock} UTC</span>
        <span>STAND BY{dots}</span>
        <span>{progress.toString().padStart(3, '0')}%</span>
      </div>

      <div className="relative w-full max-w-[520px]">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -start-2 -top-2 h-5 w-5 border-s-2 border-t-2 border-primary/45"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -end-2 -top-2 h-5 w-5 border-e-2 border-t-2 border-primary/45"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-2 -start-2 h-5 w-5 border-b-2 border-s-2 border-primary/45"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-2 -end-2 h-5 w-5 border-b-2 border-e-2 border-primary/45"
        />

        <div className="relative rounded-md border border-border/60 bg-card/70 px-6 py-7 backdrop-blur-sm shadow-[0_30px_80px_-50px_hsl(var(--foreground)/0.6)]">
          <div className="mb-5 flex items-center justify-between border-b border-border/50 pb-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="text-primary/80">// boot.sequence</span>
            <span>node · admin</span>
          </div>

          <div className="flex items-center gap-5">
            <div className="relative shrink-0">
              <img
                src={`${import.meta.env.BASE_URL}spiffo.png`}
                alt=""
                aria-hidden="true"
                className="h-16 w-16 select-none drop-shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
                style={{ imageRendering: 'pixelated' }}
                draggable={false}
              />
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400 ring-2 ring-card" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
                Establishing session
              </div>
              <div className="mt-1 truncate font-mono text-base font-semibold tracking-[0.18em] text-foreground">
                CONTROL ROOM ONLINE
              </div>
            </div>
          </div>

          <ul
            className="mt-6 space-y-1.5 font-mono text-[11px] leading-tight"
            aria-live="polite"
          >
            {AUTH_BOOT_STEPS.map((step, idx) => {
              const isDone = idx < stepIndex
              const isCurrent = idx === stepIndex
              const isPending = idx > stepIndex
              return (
                <li
                  key={step.code}
                  className={`flex items-center gap-3 transition-colors ${
                    isPending
                      ? 'text-muted-foreground/35'
                      : 'text-foreground/85'
                  }`}
                >
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-[3px] border text-[8px] font-semibold ${
                      isDone
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                        : isCurrent
                          ? 'border-primary/60 bg-primary/15 text-primary animate-pulse'
                          : 'border-border/50 bg-transparent text-muted-foreground/50'
                    }`}
                  >
                    {isDone ? '✓' : isCurrent ? '›' : '·'}
                  </span>
                  <span className="w-10 shrink-0 uppercase tracking-[0.18em] text-muted-foreground/70">
                    {step.code}
                  </span>
                  <span className="truncate">{step.label}</span>
                  {isCurrent && (
                    <span className="ms-auto text-[10px] uppercase tracking-[0.2em] text-primary/80">
                      …
                    </span>
                  )}
                  {isDone && (
                    <span className="ms-auto text-[10px] uppercase tracking-[0.2em] text-emerald-500/70">
                      OK
                    </span>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="mt-6 flex items-center gap-[3px]" aria-hidden="true">
            {Array.from({ length: segments }).map((_, idx) => (
              <span
                key={idx}
                className={`h-1.5 flex-1 rounded-[1px] transition-colors duration-300 ${
                  idx < lit
                    ? idx === lit - 1
                      ? 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]'
                      : 'bg-primary/70'
                    : 'bg-border/40'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

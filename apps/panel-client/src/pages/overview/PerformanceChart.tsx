import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { PerfPoint } from './usePerformance'

export type PerfMetric = 'cpu' | 'memory' | 'players'

const METRIC: Record<PerfMetric, { label: string; unit: string; value: (point: PerfPoint) => number | null }> = {
  cpu: { label: 'Host CPU', unit: '%', value: (point) => point.cpu },
  memory: { label: 'Server memory', unit: 'GB', value: (point) => point.pzMemGB ?? point.hostMemUsedGB },
  players: { label: 'Players', unit: '', value: (point) => point.players },
}

const clock = (time: number) => new Date(time).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })

export default function PerformanceChart({ points, metric, max }: { points: PerfPoint[]; metric: PerfMetric; max?: number }) {
  const { label, unit, value } = METRIC[metric]
  const data = points.map((point) => ({ time: point.time, value: value(point) }))
  const domainMax = metric === 'cpu' ? 100 : (max ?? 'auto')

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="perf-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--foreground)" stopOpacity={0.14} />
            <stop offset="100%" stopColor="var(--foreground)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis
          dataKey="time"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={clock}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
          tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
        />
        <YAxis
          width={36}
          domain={[0, domainMax]}
          allowDecimals={metric !== 'players'}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
        />
        <Tooltip
          cursor={{ stroke: 'var(--border)' }}
          contentStyle={{
            background: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            color: 'var(--popover-foreground)',
            fontSize: 12,
          }}
          labelFormatter={(time) => clock(Number(time))}
          formatter={(raw) => [`${raw}${unit ? ` ${unit}` : ''}`, label]}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--foreground)"
          strokeWidth={1.5}
          fill="url(#perf-fill)"
          connectNulls
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

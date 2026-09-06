import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, TrendingUp, Server, HardDrive } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTheme } from '@/contexts/ThemeContext'

export interface DebugPerformancePoint {
  memoryMB?: number
  cpuLoad?: number
  time?: string
  hostMemUsedGB?: number
  hostMemGB?: number
  pzMemMB?: number | null
  playerCount?: number
}

interface DebugPerformanceChartsProps {
  performanceHistory: DebugPerformancePoint[]
}

function useChartColors() {
  const { theme } = useTheme()
  return useMemo(() => {
    const root = document.documentElement
    const style = getComputedStyle(root)
    const hsl = (v: string) => `hsl(${style.getPropertyValue(v).trim()})`
    return {
      grid: hsl('--border'),
      axis: hsl('--muted-foreground'),
      memory: hsl('--chart-1'),
      cpu: hsl('--chart-2'),
      pz: hsl('--chart-3'),
      players: hsl('--chart-4'),
      bg: hsl('--popover'),
      fg: hsl('--popover-foreground'),
      warn: hsl('--warning'),
      danger: hsl('--destructive'),
    }
  }, [theme])
}

function DebugPerformanceCharts({ performanceHistory }: DebugPerformanceChartsProps) {
  const { t } = useTranslation('debugPerformanceCharts')
  const colors = useChartColors()

  const hasPzData = performanceHistory.some(p => p.pzMemMB != null)

  // Shared tooltip styling so values match the panel surface in both themes
  const tooltipStyle = {
    contentStyle: {
      background: colors.bg,
      border: `1px solid ${colors.grid}`,
      borderRadius: 6,
      color: colors.fg,
      fontSize: 12,
    },
    labelStyle: { color: colors.fg, fontWeight: 600 },
    itemStyle: { color: colors.fg },
    cursor: { stroke: colors.axis, strokeOpacity: 0.4 },
  }

  if (performanceHistory.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index}>
            <CardContent>
              <div className="flex h-[250px] items-center justify-center text-muted-foreground">
                {t('noDataYet')}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* PZ Server Memory */}
      {hasPzData && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              {t('pzServerMemoryTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={performanceHistory}>
                <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
                <XAxis dataKey="time" stroke={colors.axis} fontSize={12} minTickGap={30} />
                <YAxis stroke={colors.axis} fontSize={12} unit=" MB" />
                <RTooltip {...tooltipStyle} formatter={(value) => [`${value} MB`, t('pzServer')]} />
                <ReferenceLine y={6000} stroke={colors.warn} strokeDasharray="4 4" strokeOpacity={0.6} label={{ value: t('warnLabel'), fill: colors.warn, fontSize: 10, position: 'insideTopRight' }} />
                <ReferenceLine y={7600} stroke={colors.danger} strokeDasharray="4 4" strokeOpacity={0.7} label={{ value: t('limitLabel'), fill: colors.danger, fontSize: 10, position: 'insideTopRight' }} />
                <Area type="monotone" dataKey="pzMemMB" stroke={colors.pz} fill={colors.pz} fillOpacity={0.3} name={t('pzServerMb')} connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Host Memory */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5" />
            {t('hostMemoryTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={performanceHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
              <XAxis dataKey="time" stroke={colors.axis} fontSize={12} minTickGap={30} />
              <YAxis stroke={colors.axis} fontSize={12} unit=" GB" />
              <RTooltip {...tooltipStyle} formatter={(value) => [`${value} GB`, t('hostUsed')]} />
              <Area type="monotone" dataKey="hostMemUsedGB" stroke={colors.memory} fill={colors.memory} fillOpacity={0.3} name={t('hostUsedGb')} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* CPU */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            {t('hostCpuUsageTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={performanceHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
              <XAxis dataKey="time" stroke={colors.axis} fontSize={12} minTickGap={30} />
              <YAxis stroke={colors.axis} fontSize={12} unit="%" domain={[0, 100]} />
              <RTooltip {...tooltipStyle} formatter={(value) => [`${value}%`, t('cpu')]} />
              <ReferenceLine y={75} stroke={colors.warn} strokeDasharray="4 4" strokeOpacity={0.5} />
              <ReferenceLine y={90} stroke={colors.danger} strokeDasharray="4 4" strokeOpacity={0.6} />
              <Line type="monotone" dataKey="cpuLoad" stroke={colors.cpu} strokeWidth={2} dot={false} name={t('cpuPercent')} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Player Count */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            {t('playerCountTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={performanceHistory}>
              <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
              <XAxis dataKey="time" stroke={colors.axis} fontSize={12} minTickGap={30} />
              <YAxis stroke={colors.axis} fontSize={12} allowDecimals={false} />
              <RTooltip {...tooltipStyle} />
              <Line type="stepAfter" dataKey="playerCount" stroke={colors.players} strokeWidth={2} dot={false} name={t('players')} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  )
}

export default memo(DebugPerformanceCharts)
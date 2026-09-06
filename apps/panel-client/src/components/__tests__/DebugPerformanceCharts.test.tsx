import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DebugPerformanceCharts, { type DebugPerformancePoint } from '../DebugPerformanceCharts'

describe('DebugPerformanceCharts', () => {
  it('shows a real "no data yet" placeholder when history is empty, not blank charts', () => {
    render(<DebugPerformanceCharts performanceHistory={[]} />)
    expect(screen.getAllByText('No performance data yet. Data collects every 60 seconds.')).toHaveLength(2)
  })

  it('always renders Host Memory, Host CPU and Player Count once there is data', () => {
    const history: DebugPerformancePoint[] = [{ time: '12:00', hostMemUsedGB: 4, cpuLoad: 20, playerCount: 2 }]
    render(<DebugPerformanceCharts performanceHistory={history} />)
    expect(screen.getByText('Host Memory')).toBeInTheDocument()
    expect(screen.getByText('Host CPU Usage')).toBeInTheDocument()
    expect(screen.getByText('Player Count')).toBeInTheDocument()
  })

  it('omits the PZ Server Memory card when no point in the window has PZ JVM data', () => {
    const history: DebugPerformancePoint[] = [{ time: '12:00', hostMemUsedGB: 4, cpuLoad: 20 }]
    render(<DebugPerformanceCharts performanceHistory={history} />)
    expect(screen.queryByText('PZ Server Memory (JVM)')).not.toBeInTheDocument()
  })

  it('renders the PZ Server Memory card once any point in the window has PZ JVM data, even if other points do not', () => {
    const history: DebugPerformancePoint[] = [
      { time: '11:59', hostMemUsedGB: 4, cpuLoad: 20 },
      { time: '12:00', hostMemUsedGB: 4, cpuLoad: 20, pzMemMB: 2048 },
    ]
    render(<DebugPerformanceCharts performanceHistory={history} />)
    expect(screen.getByText('PZ Server Memory (JVM)')).toBeInTheDocument()
  })
})

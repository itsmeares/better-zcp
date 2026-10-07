import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { debugApi } from '@/lib/api'
import { useSocket } from '@/contexts/SocketContext'

export type PerfRange = '1h' | '6h' | '24h'

/** The server samples once a minute and keeps 24 hours. */
const SAMPLES: Record<PerfRange, number> = { '1h': 60, '6h': 360, '24h': 1440 }

export interface PerfPoint {
  time: number
  players: number
  cpu: number | null
  pzMemGB: number | null
  hostMemUsedGB: number | null
  hostMemTotalGB: number | null
  diskUsedGB: number | null
  diskTotalGB: number | null
  swapUsedGB: number | null
  swapTotalGB: number | null
}

type RawSample = Record<string, unknown>

const gb = (bytes: unknown) => (typeof bytes === 'number' && bytes > 0 ? +(bytes / 1024 ** 3).toFixed(1) : null)

function toPoint(sample: RawSample, time: number): PerfPoint {
  return {
    time,
    players: typeof sample.playerCount === 'number' ? sample.playerCount : 0,
    cpu: typeof sample.cpuUsage === 'number' ? Math.round(sample.cpuUsage) : null,
    pzMemGB: gb(sample.pzMemUsed),
    hostMemUsedGB: gb(sample.hostMemUsed),
    hostMemTotalGB: gb(sample.hostMemTotal),
    diskUsedGB: gb(sample.hostDiskUsed),
    diskTotalGB: gb(sample.hostDiskTotal),
    swapUsedGB: typeof sample.hostSwapUsed === 'number' ? +(sample.hostSwapUsed / 1024 ** 3).toFixed(1) : null,
    swapTotalGB: gb(sample.hostSwapTotal),
  }
}

/** Host and server samples for the range, kept live from the `perf` socket room. */
export function usePerformance(serverId: string | number | undefined, range: PerfRange) {
  const socket = useSocket()
  const queryClient = useQueryClient()
  const queryKey = ['performance', serverId ?? 'none', range] as const

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const { history } = await debugApi.getPerformanceHistory(SAMPLES[range])
      return history.map((sample) => toPoint(sample, Date.parse(sample.timestamp)))
    },
    enabled: serverId !== undefined,
    retry: false,
    staleTime: 60_000,
  })

  useEffect(() => {
    if (!socket) return
    const subscribe = () => socket.emit('subscribe:perf')
    const onSnapshot = (sample: RawSample) => {
      const point = toPoint(sample, Date.now())
      for (const key of Object.keys(SAMPLES) as PerfRange[]) {
        queryClient.setQueryData<PerfPoint[]>(['performance', serverId ?? 'none', key], (points) =>
          points ? [...points, point].slice(-SAMPLES[key]) : points,
        )
      }
    }
    if (socket.connected) subscribe()
    socket.on('connect', subscribe)
    socket.on('perf:snapshot', onSnapshot)
    return () => {
      socket.off('connect', subscribe)
      socket.off('perf:snapshot', onSnapshot)
      socket.emit('unsubscribe:perf')
    }
  }, [socket, queryClient, serverId])

  return query
}

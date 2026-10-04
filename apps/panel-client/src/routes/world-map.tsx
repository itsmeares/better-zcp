import { createFileRoute } from '@tanstack/react-router'
import { lazy } from 'react'
import { FeatureRoute } from '../route-components'

const WorldMap = lazy(() => import('../pages/WorldMap'))

export const Route = createFileRoute('/world-map')({
  validateSearch: (search: Record<string, unknown>) => {
    const coordinate = (value: unknown) => {
      const number = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : Number.NaN
      return Number.isFinite(number) && number >= 0 && number <= 100_000
        ? number
        : undefined
    }
    const floor = typeof search.z === 'number'
      ? search.z
      : typeof search.z === 'string' && search.z.trim() !== ''
        ? Number(search.z)
        : Number.NaN
    const x = coordinate(search.x)
    const y = coordinate(search.y)
    const z = Number.isInteger(floor) && floor >= -128 && floor <= 128 ? floor : undefined
    const zoomValue = Number(search.zoom)
    const zoom = search.zoom !== undefined && Number.isFinite(zoomValue) && zoomValue >= 2 && zoomValue <= 12 ? zoomValue : undefined
    return {
      ...(zoom === undefined ? {} : { zoom }),
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      ...(z === undefined ? {} : { z }),
    }
  },
  component: () => <FeatureRoute featureName="nav.items.worldMap" Component={WorldMap} />,
})

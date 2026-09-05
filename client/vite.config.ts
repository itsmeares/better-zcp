import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

/// <reference types="vitest" />

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'))

function resolveBuildSha() {
  const configured = process.env.PANEL_BUILD_SHA?.trim()
  if (configured) return configured
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const basePath = env.VITE_BASE_PATH || '/'
  const buildSha = resolveBuildSha()
  const parsedApiContractVersion = Number(process.env.PANEL_API_CONTRACT_VERSION)
  const apiContractVersion = Number.isInteger(parsedApiContractVersion) && parsedApiContractVersion > 0
    ? parsedApiContractVersion
    : 1

  return {
    base: basePath,
    define: {
      __PANEL_VERSION__: JSON.stringify(rootPkg.version),
      __PANEL_BUILD_SHA__: JSON.stringify(buildSha),
      __PANEL_API_CONTRACT_VERSION__: JSON.stringify(apiContractVersion),
    },
    plugins: [
      react(),
      {
        name: 'panel-build-info',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'build-info.json',
            source: JSON.stringify({
              panelVersion: rootPkg.version,
              buildSha,
              apiContractVersion,
            }, null, 2),
          })
        },
      },
    ],
    esbuild: {
      drop: ['console', 'debugger'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined

            // Heavy charting library - only loaded on Dashboard/Debug
            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-')) return 'charts'
            // Real-time socket - loaded on connect
            if (id.includes('socket.io-client') || id.includes('engine.io')) return 'socket'
            // Radix UI primitives - loaded as components use them
            if (id.includes('@radix-ui')) return 'radix-vendor'
            // Icons - separate chunk for tree-shaken icon set
            if (id.includes('lucide-react')) return 'icons'
            // React Router - needed on first load but separate from core React
            if (id.includes('react-router')) return 'router'

            // Core: react, react-dom, clsx, tailwind-merge, cva
            return 'vendor'
          },
        },
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
        '/socket.io': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test-setup.ts',
      // The client suite waits on real browser-like async work. Keep the
      // timeout aligned with the server suite so busy runners do not fail it
      // before the assertion can run.
      testTimeout: 60000,
    },
  }
})

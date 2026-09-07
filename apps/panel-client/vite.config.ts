import { defineConfig, loadEnv } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

/// <reference types="vitest" />

const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8'))

function resolveBuildSha() {
  const configured = process.env.PANEL_BUILD_SHA?.trim()
  if (configured) return configured
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const basePath = env.VITE_BASE_PATH || '/'
  const isStaticClientBuild = mode === 'static-client'
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
      ...(!isStaticClientBuild
        ? [
            tanstackStart({
              spa: { enabled: false },
              prerender: { enabled: false },
            }),
          ]
        : []),
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
    ...(isStaticClientBuild
      ? {}
      : {
          environments: {
            client: {
              build: { outDir: 'dist' },
            },
            ssr: {
              build: { outDir: 'dist-start-server' },
            },
          },
        }),
    esbuild: {
      drop: ['console', 'debugger'],
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined

            if (id.includes('recharts') || id.includes('d3-') || id.includes('victory-')) return 'charts'
            if (id.includes('socket.io-client') || id.includes('engine.io')) return 'socket'
            if (id.includes('@radix-ui')) return 'radix-vendor'
            if (id.includes('lucide-react')) return 'icons'
            if (id.includes('react-router')) return 'router'

            return 'vendor'
          },
        },
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        'react-router-dom': path.resolve(__dirname, './src/lib/router.tsx'),
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
      testTimeout: 60000,
    },
  }
})

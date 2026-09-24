import { defineConfig, loadEnv, lazyPlugins } from 'vite-plus'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

const rootPkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf-8'))

function resolveBuildSha() {
  const configured = process.env.PANEL_BUILD_SHA?.trim()
  if (configured) return configured
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
    }).trim()
  } catch {
    return 'unknown'
  }
}

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
    plugins: lazyPlugins(() => [
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
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
    ]),
    build: {
      outDir: 'dist',
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
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
    preview: {
      host: '127.0.0.1',
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './src/test-setup.ts',
      testTimeout: 60000,
    },
  }
})

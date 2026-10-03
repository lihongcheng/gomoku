import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const api = env.VITE_API_ORIGIN
  const siteMode = env.VITE_SITE_MODE || 'live'
  if (!['live', 'preview'].includes(siteMode)) {
    throw new Error('VITE_SITE_MODE 只能是 live 或 preview')
  }
  if (siteMode === 'preview' && api) {
    throw new Error('preview 模式不连接后端，请清空 VITE_API_ORIGIN')
  }
  if (api) {
    const url = new URL(api)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== api || url.username) {
      throw new Error('VITE_API_ORIGIN 必须是完整 http(s) Origin，不带路径或末尾斜杠')
    }
  }
  return {
    plugins: [
      react(),
      {
        name: 'gomoku-build-metadata',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'gomoku-build.json',
            source: JSON.stringify({
              siteMode,
              apiOrigin: siteMode === 'preview' ? null : api || 'http://localhost:8000',
              base: env.VITE_BASE_PATH || '/',
            }),
          })
        },
      },
    ],
    base: env.VITE_BASE_PATH || '/',
    test: { include: ['src/**/*.test.ts'] },
  }
})

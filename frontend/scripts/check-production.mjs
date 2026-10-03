import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const api = process.env.VITE_API_ORIGIN
const base = process.env.VITE_BASE_PATH
const siteMode = process.env.VITE_SITE_MODE || 'live'
assert(['live', 'preview'].includes(siteMode), 'VITE_SITE_MODE 只能是 live 或 preview')
assert(base, '生产检查需要显式设置 VITE_BASE_PATH')
if (siteMode === 'preview') {
  assert(!api, 'preview 模式不可配置后端 API')
} else {
  assert(api, '在线对战发布需要显式设置 VITE_API_ORIGIN')
  const origin = new URL(api)
  assert(
    origin.protocol === 'https:' && origin.origin === api,
    '线上 API 必须为 HTTPS Origin，无路径或末尾斜杠',
  )
  assert(
    !/localhost|127\.0\.0\.1|\[::1\]|\.example$/.test(origin.hostname),
    '请配置实际生产后端地址',
  )
}
assert(/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(base), 'Pages 路径必须以 / 开头和结尾')
const metadata = JSON.parse(await readFile('dist/gomoku-build.json', 'utf8'))
assert.deepEqual(
  metadata,
  { siteMode, apiOrigin: siteMode === 'preview' ? null : api, base },
  '产物环境与发布配置不一致，请重新构建',
)
const html = await readFile('dist/index.html', 'utf8')
const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
assert(assets.length >= 3, '产物缺少脚本、样式或站点图标')
for (const asset of assets) {
  assert(asset.startsWith(base), `静态资源路径不匹配 Pages 子路径：${asset}`)
  await readFile(path.join('dist', asset.slice(base.length)))
}
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name)
    if (entry.isDirectory()) await checkDirectory(name)
    else if (/\.(js|html|json)$/.test(entry.name)) {
      const content = await readFile(name, 'utf8')
      assert(
        !/https?:\/\/(?:localhost|127\.0\.0\.1)|wss?:\/\/(?:localhost|127\.0\.0\.1)/.test(content),
        `产物含本地服务地址：${name}`,
      )
    }
  }
}
await checkDirectory('dist')
console.log(`生产产物检查通过：${siteMode} 模式、构建环境、静态资源和 Pages 子路径。`)

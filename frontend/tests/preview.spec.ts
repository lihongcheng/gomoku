import { expect, test } from '@playwright/test'

test('Pages 子路径支持刷新；未开放服务时禁用对战且不发起 API 或 WebSocket', async ({ page }) => {
  const unexpected: string[] = []
  const errors: string[] = []
  page.on('request', (request) => {
    if (['fetch', 'xhr', 'websocket'].includes(request.resourceType()))
      unexpected.push(request.url())
  })
  page.on('websocket', (socket) => unexpected.push(socket.url()))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('./')
  await expect(page.getByRole('status')).toContainText('对战服务尚未开放')
  await expect(page.getByRole('button', { name: '开一间棋室' })).toBeDisabled()
  await page.getByRole('tab', { name: '加入房间' }).click()
  await expect(page.getByRole('button', { name: '前往房间' })).toBeDisabled()
  await page.goto('./#/room/ABCDEFGH?invite=abcdefghijklmnop')
  await expect(page.getByRole('heading', { name: '对战服务尚未开放' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '对战服务尚未开放' })).toBeVisible()
  await page.getByRole('button', { name: '返回首页' }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(unexpected).toEqual([])
  expect(errors).toEqual([])
})

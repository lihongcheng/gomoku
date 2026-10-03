import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'

async function create(page: Page, nickname = '青山') {
  await page.goto('/')
  await page.getByLabel('你的昵称').fill(nickname)
  await page.getByRole('button', { name: '开一间棋室' }).click()
  await expect(page.getByTestId('room')).toHaveAttribute('data-connection', 'online')
  await page.getByRole('button', { name: '邀请好友' }).click()
  const invite = await page.getByLabel('对战邀请链接', { exact: true }).inputValue()
  const watch = await page.getByLabel('仅观战链接', { exact: true }).inputValue()
  await page.getByRole('button', { name: '关闭弹窗' }).click()
  return { invite, watch }
}
async function enter(page: Page, link: string, name: string, watch = false) {
  await page.goto(link)
  await page.getByLabel('你的昵称').fill(name)
  await page.getByRole('button', { name: watch ? '进入观战' : '确认加入', exact: true }).click()
  await expect(page.getByTestId('room')).toHaveAttribute('data-connection', 'online')
}
async function ready(black: Page, white: Page) {
  await black.getByRole('button', { name: '准备好了' }).click()
  await expect(white.getByText('已准备', { exact: true })).toBeVisible()
  await white.getByRole('button', { name: '准备好了' }).click()
  await expect(black.getByTestId('room')).toHaveAttribute('data-phase', 'PLAYING')
  await expect(white.getByTestId('room')).toHaveAttribute('data-phase', 'PLAYING')
}
async function play(page: Page, row: number, col: number, count: number) {
  await expect(page.getByTestId(`cell-${row}-${col}`)).toHaveAttribute('aria-disabled', 'false')
  await page.getByTestId(`cell-${row}-${col}`).click()
  await page.getByRole('button', { name: '确认落子' }).click()
  await expect(page.getByTestId('move-count')).toHaveText(`${String(count).padStart(2, '0')}手`)
}
async function friend(
  browser: Browser,
  contexts: BrowserContext[],
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext({ viewport })
  contexts.push(context)
  return context.newPage()
}
let contexts: BrowserContext[]
test.beforeEach(() => {
  contexts = []
})
test.afterEach(async () => {
  for (const context of contexts) await context.close()
})

test('三端同步：只读不占座、准备、悔棋审批、五连胜与刷新恢复', async ({ page, browser }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const { invite, watch } = await create(page)
  const observer = await friend(browser, contexts)
  await enter(observer, watch, '听雨', true)
  await expect(page.getByText('等待好友', { exact: true })).toBeVisible()
  await expect(observer.getByRole('button', { name: '准备好了' })).toHaveCount(0)
  const white = await friend(browser, contexts)
  // Viewing an invitation is not a join.
  await white.goto(invite)
  await expect(page.getByText('等待好友', { exact: true })).toBeVisible()
  await white.getByLabel('你的昵称').fill('远山')
  await white.getByRole('button', { name: '确认加入', exact: true }).click()
  await expect(white.getByTestId('room')).toHaveAttribute('data-connection', 'online')
  await expect(page.getByTestId('spectator-count')).toHaveText('1')
  await ready(page, white)
  await play(page, 7, 7, 1)
  await play(white, 8, 7, 2)
  await page.getByRole('button', { name: '申请悔棋' }).click()
  await expect(white.getByRole('button', { name: '同意悔棋' })).toBeVisible()
  await expect(observer.getByRole('button', { name: '同意悔棋' })).toHaveCount(0)
  await white.getByRole('button', { name: '同意悔棋' }).click()
  await expect(observer.getByTestId('move-count')).toHaveText('00手')
  await expect(page.getByTestId('move-count')).toHaveText('00手')
  for (let index = 0; index < 5; index++) {
    await play(page, 7, 3 + index, index * 2 + 1)
    if (index < 4) await play(white, 8, 3 + index, index * 2 + 2)
  }
  for (const tab of [page, white, observer]) {
    await expect(tab.getByTestId('game-status')).toHaveText('黑方获胜')
    await expect(tab.getByTestId('move-count')).toHaveText('09手')
  }
  await page.reload()
  await expect(page.getByTestId('room')).toHaveAttribute('data-connection', 'online')
  await expect(page.getByTestId('game-status')).toHaveText('黑方获胜')
  await expect(page.getByText('你是黑方')).toBeVisible()
  await expect(page.getByTestId('cell-7-7')).toHaveAccessibleName('H8 黑子')
  expect(errors).toEqual([])
})

test('悔棋拒绝与超时不改棋盘；第三位持对战邀请只能观战；认输确认', async ({ page, browser }) => {
  const { invite } = await create(page)
  const white = await friend(browser, contexts)
  await enter(white, invite, '白露')
  const observer = await friend(browser, contexts)
  await enter(observer, invite, '松风')
  await expect(observer.getByText('观战中', { exact: true })).toBeVisible()
  await ready(page, white)
  await play(page, 7, 7, 1)
  await page.getByRole('button', { name: '申请悔棋' }).click()
  await white.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(page.getByTestId('move-count')).toHaveText('01手')
  await expect(page.getByRole('button', { name: '申请悔棋' })).toBeDisabled()
  await play(white, 8, 7, 2)
  await white.getByRole('button', { name: '申请悔棋' }).click()
  await expect(page.getByRole('button', { name: '同意悔棋' })).toBeVisible()
  await expect(page.getByRole('button', { name: '同意悔棋' })).toHaveCount(0, { timeout: 7000 })
  await expect(page.getByTestId('move-count')).toHaveText('02手')
  await page.getByRole('button', { name: '认输', exact: true }).click()
  await page.getByRole('button', { name: '再想想' }).click()
  await expect(page.getByTestId('room')).toHaveAttribute('data-phase', 'PLAYING')
  await page.getByRole('button', { name: '认输', exact: true }).click()
  await page.getByRole('button', { name: '确认认输' }).click()
  await expect(observer.getByTestId('game-status')).toHaveText('白方获胜')
})

test('断线恢复原席位，多标签接管后旧页停止重连', async ({ page, browser }) => {
  const { invite } = await create(page)
  const white = await friend(browser, contexts)
  await enter(white, invite, '白露')
  await ready(page, white)
  await play(page, 7, 7, 1)
  // Navigating away closes the socket, without sending a voluntary leave command.
  await white.goto('about:blank')
  await expect(page.getByTestId('game-status')).toHaveText('暂歇片刻，等待重连')
  await white.goto(invite)
  await expect(white.getByTestId('room')).toHaveAttribute('data-connection', 'online')
  await expect(white.getByText('你是白方')).toBeVisible()
  await play(white, 8, 7, 2)
  const takeover = await page.context().newPage()
  await takeover.goto(invite)
  await expect(takeover.getByTestId('room')).toHaveAttribute('data-connection', 'online')
  await expect(page.getByTestId('room')).toHaveAttribute('data-connection', 'stopped')
  await expect(page.getByRole('alert')).toContainText('另一个标签页')
  await play(takeover, 7, 8, 3)
  await takeover.close()
})

test('移动布局、键盘选点、关闭房间和无效链接提示', async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/room/invalid')
  await expect(page.getByRole('heading', { name: '这封邀请似乎不完整' })).toBeVisible()
  await page.getByRole('button', { name: '返回首页' }).click()
  const { invite } = await create(page)
  const white = await friend(browser, contexts)
  await enter(white, invite, '白露')
  await ready(page, white)
  const cell = page.getByTestId('cell-7-7')
  await cell.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '确认落子' })).toBeEnabled()
  await expect(page.getByTestId('move-count')).toHaveText('00手')
  await page.getByRole('button', { name: '确认落子' }).click()
  await expect(white.getByTestId('cell-7-8')).toHaveAccessibleName('I8 黑子')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.getByRole('button', { name: '离开房间', exact: true }).click()
  await page.getByRole('button', { name: '确认离开' }).click()
  await expect(page.getByRole('button', { name: '开一间棋室' })).toBeVisible()
  await expect(white.getByTestId('game-status')).toHaveText('白方获胜')
  await create(page)
  await page.getByRole('button', { name: '关闭房间', exact: true }).click()
  await page.getByRole('button', { name: '确认关闭' }).click()
  await expect(page.getByRole('button', { name: '开一间棋室' })).toBeVisible()
})

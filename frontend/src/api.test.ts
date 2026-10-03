import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoom, parseRoomLink, readSaved, save } from './api'

beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key),
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())
it('parses hash routes and preserves watch-only permission', () => {
  expect(
    parseRoomLink('https://example.com/gomoku/#/room/ABCDEFGH?watch=abcdefghijklmnop'),
  ).toEqual({ roomId: 'ABCDEFGH', watchToken: 'abcdefghijklmnop' })
  expect(parseRoomLink('#/room/ABCDEFGH?invite=abcdefghijklmnop')).toEqual({
    roomId: 'ABCDEFGH',
    inviteToken: 'abcdefghijklmnop',
  })
})
it.each([
  'ABCDEFGH',
  '#/room/../../',
  '#/room/ABCDEFGH?invite=bad',
  '#/room/ABCDEFGH?invite=abcdefghijklmnop&watch=abcdefghijklmnop',
])('rejects malformed or ambiguous links: %s', (link) => {
  expect(parseRoomLink(link)).toBeNull()
})
it('reuses persisted creation body and key after response loss', async () => {
  const session = {
    protocolVersion: 1,
    serverEpoch: 'epoch',
    memberId: 'member',
    sessionToken: 'secret',
  }
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => session })
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/rooms')) throw new Error('response lost')
    return { ok: true, json: async () => session }
  })
  await expect(createRoom('原昵称')).rejects.toThrow('连接不上')
  const original = readSaved('create')
  expect(readSaved('session')).toEqual(session)
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/rooms')
        ? {
            protocolVersion: 1,
            serverEpoch: 'epoch',
            roomId: 'ABCDEFGH',
            inviteToken: 'invite',
            watchToken: 'watch',
          }
        : session,
  }))
  const room = await createRoom('修改昵称')
  const requests = fetchMock.mock.calls.filter(([url]) => url.endsWith('/rooms'))
  expect(requests[1][1].body).toBe(requests[0][1].body)
  expect(requests[1][1].headers['Idempotency-Key']).toBe(requests[0][1].headers['Idempotency-Key'])
  expect(original).toBeTruthy()
  expect(room.nickname).toBe('原昵称')
  expect(readSaved('create')).toBeNull()
})
it('refuses to create a room when session cannot be persisted', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('denied')
    },
  })
  const mock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ protocolVersion: 1, serverEpoch: 'epoch' }),
  })
  vi.stubGlobal('fetch', mock)
  await expect(createRoom('棋友')).rejects.toThrow('无法保存匿名身份')
  expect(mock.mock.calls.some(([url]) => url.endsWith('/rooms'))).toBe(false)
})
it('new server epoch does not reuse an old creation key', async () => {
  save('session', { serverEpoch: 'old', memberId: 'old-member' })
  save('create', { key: 'old-key', memberId: 'old-member', nickname: '旧' })
  const mock = vi.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.endsWith('/rooms')
        ? { protocolVersion: 1, serverEpoch: 'new', roomId: 'ABCDEFGH' }
        : {
            protocolVersion: 1,
            serverEpoch: 'new',
            memberId: 'new-member',
            sessionToken: 'new-token',
          },
  }))
  vi.stubGlobal('fetch', mock)
  await createRoom('新')
  const request = mock.mock.calls.find(([url]) => url.endsWith('/rooms'))!
  expect(request[1].headers['Idempotency-Key']).not.toBe('old-key')
  expect(JSON.parse(request[1].body).nickname).toBe('新')
})

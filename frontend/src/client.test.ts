import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomClient } from './client'
import type { RoomState } from './types'

class Socket {
  static OPEN = 1
  static CLOSED = 3
  static instances: Socket[] = []
  readyState = 0
  sent: Record<string, unknown>[] = []
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { reason: string }) => void
  onerror?: () => void
  constructor() {
    Socket.instances.push(this)
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  receive(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  close(reason = '') {
    this.readyState = 3
    this.onclose?.({ reason })
  }
}
const session = { memberId: 'me', sessionToken: 'token', serverEpoch: 'epoch', protocolVersion: 1 }
function snapshot(overrides: Partial<RoomState> = {}): RoomState {
  return {
    type: 'room.state',
    roomId: 'ABCDEFGH',
    serverEpoch: 'epoch',
    protocolVersion: 1,
    seq: 1,
    revision: 1,
    phase: 'PLAYING',
    players: [],
    moves: [],
    currentTurn: 'BLACK',
    result: null,
    closeReason: null,
    pendingUndo: null,
    spectatorCount: 0,
    serverTime: new Date().toISOString(),
    maintenance: false,
    deadlines: { waiting: null, idle: null, idleWarning: null, finished: null, empty: null },
    ...overrides,
  }
}
function join(socket: Socket, room = snapshot()) {
  socket.open()
  socket.receive({
    type: 'room.joined',
    roomId: 'ABCDEFGH',
    serverEpoch: 'epoch',
    protocolVersion: 1,
    self: {
      memberId: 'me',
      nickname: '我',
      color: 'BLACK',
      role: 'PLAYER',
      isOwner: true,
      generation: 1,
    },
  })
  socket.receive(room)
}
let client: RoomClient
beforeEach(() => {
  vi.useFakeTimers()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('localStorage', { removeItem: vi.fn() })
  client = new RoomClient({ roomId: 'ABCDEFGH' }, session, '我')
  client.start()
})
afterEach(() => {
  client.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('authoritative room synchronization', () => {
  it('accepts skipped sequences, ignores older snapshots, and never rolls back', () => {
    const socket = Socket.instances[0]
    join(socket, snapshot({ seq: 8, revision: 4 }))
    socket.receive(snapshot({ seq: 3, revision: 2 }))
    expect(client.getSnapshot().room?.revision).toBe(4)
    socket.receive(snapshot({ seq: 15, revision: 5 }))
    expect(client.getSnapshot().room?.seq).toBe(15)
  })
  it('does not open controls until both identity and snapshot arrive', async () => {
    Socket.instances[0].open()
    await expect(client.command('move.play', { row: 0, col: 0 })).rejects.toThrow()
    expect(client.getSnapshot().connection).toBe('syncing')
  })
  it('retries the exact original command after lost ACK and locks until snapshot arrives', async () => {
    const socket = Socket.instances[0]
    join(socket)
    const promise = client.command('move.play', { row: 7, col: 7 })
    const command = socket.sent.at(-1)!
    await expect(client.command('move.play', { row: 8, col: 8 })).rejects.toThrow()
    vi.advanceTimersByTime(4000)
    expect(socket.sent.at(-1)).toEqual(command)
    socket.receive({ type: 'command.ack', requestId: command.requestId, revision: 2 })
    expect(client.getSnapshot().busy).toBe(true)
    socket.receive(snapshot({ seq: 2, revision: 2 }))
    await promise
    expect(client.getSnapshot().busy).toBe(false)
  })
  it('an old receipt cannot overwrite a newer board', async () => {
    const socket = Socket.instances[0]
    join(socket)
    const promise = client.command('game.ready', { ready: true })
    const command = socket.sent.at(-1)!
    socket.receive(snapshot({ seq: 9, revision: 7 }))
    socket.receive({ type: 'command.ack', requestId: command.requestId, revision: 2 })
    await promise
    expect(client.getSnapshot().room?.revision).toBe(7)
  })
  it('disconnect discards unacknowledged action; reconnect only joins and synchronizes', async () => {
    const socket = Socket.instances[0]
    join(socket)
    const promise = client.command('move.play', { row: 7, col: 7 }).catch((error) => error)
    socket.close()
    expect(await promise).toBeInstanceOf(Error)
    vi.advanceTimersByTime(1500)
    const next = Socket.instances[1]
    next.open()
    expect(next.sent.map((message) => message.type)).toEqual(['room.join'])
    expect(client.getSnapshot().connection).toBe('syncing')
    join(next, snapshot({ seq: 1 }))
    expect(client.getSnapshot().connection).toBe('online')
  })
  it.each(['SESSION_REPLACED', 'ROOM_GONE', 'AUTH_REQUIRED'])(
    'stops reconnecting on %s',
    (code) => {
      const socket = Socket.instances[0]
      join(socket)
      socket.receive({ type: 'error', code })
      vi.advanceTimersByTime(60_000)
      expect(Socket.instances).toHaveLength(1)
      expect(client.getSnapshot().terminalCode).toBe(code)
    },
  )
  it('stops old commands when the server epoch changes', () => {
    const socket = Socket.instances[0]
    join(socket)
    socket.receive(snapshot({ serverEpoch: 'new-epoch', seq: 90 }))
    expect(client.getSnapshot().terminalCode).toBe('SERVER_CHANGED')
    expect(client.getSnapshot().room?.serverEpoch).toBe('epoch')
  })
  it('stale revision rejects the command and requires synchronization', async () => {
    const socket = Socket.instances[0]
    join(socket)
    const result = client.command('move.play', { row: 7, col: 7 }).catch((error) => error)
    socket.receive({
      type: 'error',
      code: 'STALE_REVISION',
      requestId: socket.sent.at(-1)!.requestId,
    })
    expect(await result).toBeInstanceOf(Error)
    expect(socket.sent.at(-1)?.type).toBe('room.sync')
    expect(client.getSnapshot().connection).toBe('syncing')
    socket.receive(snapshot({ seq: 2, revision: 2 }))
    expect(client.getSnapshot().connection).toBe('online')
  })
  it('does not retry an unacknowledged action after a terminal snapshot', async () => {
    const socket = Socket.instances[0]
    join(socket)
    const result = client.command('move.play', { row: 7, col: 7 }).catch((error) => error)
    socket.receive(snapshot({ seq: 2, phase: 'FINISHED' }))
    expect(await result).toBeInstanceOf(Error)
    const count = socket.sent.length
    vi.advanceTimersByTime(5000)
    expect(socket.sent).toHaveLength(count)
  })
})

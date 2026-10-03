import { AppError, WS_URL, forget } from './api'
import type { Command, CommandType, RoomAccess, RoomState, Self, Session } from './types'

export type Connection = 'connecting' | 'syncing' | 'online' | 'reconnecting' | 'stopped'
export interface ClientState {
  connection: Connection
  room: RoomState | null
  self: Self | null
  busy: boolean
  error: string | null
  terminalCode: string | null
  clockOffset: number
}
interface Pending {
  command: Command
  attempts: number
  acknowledgedRevision?: number
  resolve: () => void
  reject: (error: Error) => void
}
const terminal = new Set([
  'AUTH_REQUIRED',
  'INVITE_INVALID',
  'ROOM_GONE',
  'SESSION_REPLACED',
  'PROTOCOL_UNSUPPORTED',
  'SERVER_CHANGED',
  'ROOM_FULL',
  'CAPACITY_REACHED',
])

/** One controller per room. Snapshots are authoritative; clicks are never queued offline. */
export class RoomClient {
  private state: ClientState = {
    connection: 'connecting',
    room: null,
    self: null,
    busy: false,
    error: null,
    terminalCode: null,
    clockOffset: 0,
  }
  private listeners = new Set<() => void>()
  private socket: WebSocket | null = null
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private retryTimer?: ReturnType<typeof setTimeout>
  private joinTimer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private stopped = false
  private attempts = 0
  private lastReceived = 0
  private pending: Pending | null = null
  constructor(
    private access: RoomAccess,
    private session: Session,
    private nickname: string,
  ) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  clearError = () => this.update({ error: null })
  start = () => {
    this.stopped = false
    if (this.access.serverEpoch && this.access.serverEpoch !== this.session.serverEpoch) {
      this.fail('SERVER_CHANGED')
      return
    }
    this.connect()
    window.addEventListener('online', this.wake)
    document.addEventListener('visibilitychange', this.wake)
  }
  stop = () => {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.clearConnectionTimers()
    this.cancelPending()
    const socket = this.socket
    this.socket = null
    socket?.close()
    window.removeEventListener('online', this.wake)
    document.removeEventListener('visibilitychange', this.wake)
  }
  private clearConnectionTimers() {
    clearTimeout(this.joinTimer)
    clearTimeout(this.retryTimer)
    clearInterval(this.heartbeat)
  }
  private cancelPending(error: Error = new AppError('DISCONNECTED')) {
    clearTimeout(this.retryTimer)
    const pending = this.pending
    this.pending = null
    pending?.reject(error)
    this.update({ busy: false })
  }
  private fail(code: string) {
    this.stop()
    if (code === 'AUTH_REQUIRED') forget('session')
    this.update({ connection: 'stopped', terminalCode: code, error: new AppError(code).message })
  }
  private wake = () => {
    if (this.stopped || document.visibilityState === 'hidden') return
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastReceived > 45_000) this.socket.close()
      else this.send({ type: 'room.sync' })
    } else if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      clearTimeout(this.reconnectTimer)
      this.connect()
    }
  }
  private connect() {
    if (this.stopped) return
    this.update({ connection: this.state.room ? 'reconnecting' : 'connecting', self: null })
    const socket = new WebSocket(WS_URL)
    this.socket = socket
    // Includes the opening handshake; a cold or unreachable service cannot hang forever.
    this.joinTimer = setTimeout(() => socket.close(), 75_000)
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return
      this.lastReceived = Date.now()
      this.update({ connection: 'syncing' })
      this.send({
        type: 'room.join',
        protocolVersion: 1,
        roomId: this.access.roomId,
        sessionToken: this.session.sessionToken,
        inviteToken: this.access.inviteToken || this.access.watchToken || null,
        nickname: this.nickname,
      })
      clearTimeout(this.joinTimer)
      this.joinTimer = setTimeout(() => socket.close(), 12_000)
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastReceived > 45_000) socket.close()
        else this.send({ type: 'heartbeat' })
      }, 20_000)
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.stopped) return
      try {
        this.receive(JSON.parse(event.data))
      } catch {
        this.fail('PROTOCOL_UNSUPPORTED')
      }
    }
    socket.onclose = (event) => {
      if (this.socket !== socket || this.stopped) return
      this.clearConnectionTimers()
      this.socket = null
      this.cancelPending()
      if (terminal.has(event.reason)) {
        this.fail(event.reason)
        return
      }
      if (this.state.room?.phase === 'CLOSED') {
        this.fail('ROOM_GONE')
        return
      }
      this.update({ connection: 'reconnecting' })
      const delay = Math.min(1000 * 2 ** this.attempts++, 10_000) * (0.8 + Math.random() * 0.4)
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }
    socket.onerror = () => {
      /* close event owns retries, preventing duplicate reconnects. */
    }
  }
  private send(value: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value))
  }
  private receive(message: Record<string, unknown>) {
    this.lastReceived = Date.now()
    if (message.serverEpoch && message.serverEpoch !== this.session.serverEpoch) {
      this.fail('SERVER_CHANGED')
      return
    }
    if (message.protocolVersion !== undefined && message.protocolVersion !== 1) {
      this.fail('PROTOCOL_UNSUPPORTED')
      return
    }
    if (message.type === 'room.joined') {
      if (message.roomId !== this.access.roomId) {
        this.fail('PROTOCOL_UNSUPPORTED')
        return
      }
      this.update({ self: message.self as Self })
    } else if (message.type === 'room.state') {
      const room = message as unknown as RoomState
      if (room.roomId !== this.access.roomId || !this.state.self) return
      const newer = !this.state.room || room.seq > this.state.room.seq
      clearTimeout(this.joinTimer)
      this.attempts = 0
      this.update({
        ...(newer ? { room } : {}),
        connection: 'online',
        clockOffset: Date.parse(room.serverTime) - Date.now(),
      })
      this.finishAcknowledged()
      if (room.phase === 'CLOSED') this.fail('ROOM_GONE')
      else if (
        room.phase === 'FINISHED' &&
        this.pending &&
        this.pending.acknowledgedRevision === undefined
      ) {
        // Do not blindly replay commands after a terminal snapshot.
        this.cancelPending(new Error('对局已结束，请查看最新结果。'))
      }
    } else if (message.type === 'command.ack') {
      if (message.requestId !== this.pending?.command.requestId) return
      this.pending!.acknowledgedRevision = message.revision as number
      clearTimeout(this.retryTimer)
      if (['room.leave', 'room.close'].includes(this.pending!.command.type)) {
        const pending = this.pending!
        this.pending = null
        this.update({ busy: false })
        pending.resolve()
      } else {
        this.finishAcknowledged()
        // ACK and snapshot are separate frames. Keep controls locked until both arrive.
        if (this.pending) this.retryTimer = setTimeout(() => this.socket?.close(), 6000)
      }
    } else if (message.type === 'error') {
      const code = String(message.code)
      if (terminal.has(code)) {
        this.fail(code)
        return
      }
      const error = new AppError(code)
      this.update({ error: error.message })
      if (message.requestId === this.pending?.command.requestId) this.cancelPending(error)
      if (code === 'STALE_REVISION') {
        this.update({ connection: 'syncing' })
        this.send({ type: 'room.sync' })
      }
    }
  }
  private finishAcknowledged() {
    const pending = this.pending
    if (
      !pending ||
      pending.acknowledgedRevision === undefined ||
      !this.state.room ||
      this.state.room.revision < pending.acknowledgedRevision
    )
      return
    clearTimeout(this.retryTimer)
    this.pending = null
    this.update({ busy: false })
    pending.resolve()
  }
  command(type: CommandType, payload: Record<string, unknown> = {}): Promise<void> {
    if (this.state.connection !== 'online' || !this.state.room || this.pending) {
      return Promise.reject(new Error('请等待状态同步完成后再操作。'))
    }
    const command: Command = {
      type,
      payload,
      expectedRevision: this.state.room.revision,
      requestId: crypto.randomUUID(),
    }
    this.update({ busy: true, error: null })
    return new Promise((resolve, reject) => {
      this.pending = { command, attempts: 0, resolve, reject }
      this.retry()
    })
  }
  private retry() {
    if (!this.pending || this.stopped) return
    if (this.pending.attempts >= 3) {
      this.socket?.close()
      return
    }
    this.pending.attempts++
    this.send(this.pending.command)
    this.retryTimer = setTimeout(() => this.retry(), 4000)
  }
}

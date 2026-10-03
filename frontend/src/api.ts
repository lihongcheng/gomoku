import type { RoomAccess, Session } from './types'

export const SITE_PREVIEW = import.meta.env.VITE_SITE_MODE === 'preview'
export const API_ORIGIN = SITE_PREVIEW
  ? ''
  : import.meta.env.VITE_API_ORIGIN || 'http://localhost:8000'
export const WS_URL = API_ORIGIN.replace(/^http/, 'ws') + '/ws'
const prefix = `gomoku:v1:${API_ORIGIN}:`

export const messages: Record<string, string> = {
  SERVICE_UNAVAILABLE: '对战服务尚未开放，暂时无法创建或加入房间。',
  AUTH_REQUIRED: '匿名身份已过期或服务已更新。请返回首页重新进入。',
  INVITE_INVALID: '邀请链接无效，请向房主获取新的完整链接。',
  ROOM_GONE: '房间已结束或服务已更新，请重新创建房间。',
  SERVER_CHANGED: '服务已更新，原房间无法恢复。请返回首页重新创建。',
  SESSION_REPLACED: '已在另一个标签页打开此房间，请在那个页面继续。',
  PROTOCOL_UNSUPPORTED: '页面版本已更新，请刷新后重试。',
  STALE_REVISION: '对局状态已更新，请查看棋盘后重新操作。',
  NOT_YOUR_TURN: '还没轮到你，请等待对方落子。',
  CELL_OCCUPIED: '这里已有棋子，请选择其他交点。',
  UNDO_PENDING: '正在等待悔棋答复，请稍候。',
  UNDO_EXPIRED: '悔棋请求已结束，棋盘以最新状态为准。',
  UNDO_COOLDOWN: '申请过于频繁，请稍后再试。',
  UNDO_REPEATED: '当前棋谱已申请过悔棋，请在新落子后再试。',
  UNDO_UNAVAILABLE: '当前没有可以撤销的落子。',
  PLAYER_OFFLINE: '有玩家断线，对局已暂停。',
  INVALID_PHASE: '对局阶段已变化，请查看最新状态后操作。',
  USE_RESIGN: '对局中请通过认输或离开结束自己的参与。',
  NOT_OWNER: '只有房主可以关闭房间。',
  UNDO_SELF_APPROVAL: '请等待对方审批，不能同意自己的悔棋申请。',
  REQUEST_ID_CONFLICT: '操作编号冲突，请刷新并同步状态后重试。',
  INVALID_MESSAGE: '操作格式有误，请刷新页面重试。',
  NOT_PLAYER: '你正在观战，不能操作对局。',
  ROOM_FULL: '观战席暂时已满，请稍后再试。',
  CAPACITY_REACHED: '棋室暂时已满，请稍后再来。',
  CREATE_LIMIT: '创建房间已达上限，请先结束已有房间。',
  RATE_LIMITED: '操作过于频繁，请稍后再试。',
  SERVER_DRAINING: '服务即将维护，暂时不能创建房间。',
  STORAGE_UNAVAILABLE: '浏览器无法保存匿名身份，请允许本站使用本地存储后重试。',
  NETWORK: '暂时连接不上棋室，请检查网络后重试。',
  DISCONNECTED: '连接中断，正在恢复。刚才的操作请以恢复后的棋盘为准。',
}
export class AppError extends Error {
  constructor(public code: string) {
    super(messages[code] || '操作未完成，请同步最新状态后重试。')
  }
}
export function readSaved<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(prefix + key) || 'null')
  } catch {
    return null
  }
}
export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(prefix + key, JSON.stringify(value))
  } catch {
    throw new AppError('STORAGE_UNAVAILABLE')
  }
}
export function forget(key: string) {
  try {
    localStorage.removeItem(prefix + key)
  } catch {
    /* Reads still work without storage. */
  }
}
export function savedRoom(roomId: string): RoomAccess | null {
  return readSaved(`room:${roomId}`)
}
export function saveRoom(room: RoomAccess) {
  save(`room:${room.roomId}`, room)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (SITE_PREVIEW) throw new AppError('SERVICE_UNAVAILABLE')
  let response: Response
  try {
    response = await fetch(API_ORIGIN + path, {
      ...init,
      signal: AbortSignal.timeout(70_000),
      cache: 'no-store',
    })
  } catch {
    throw new AppError('NETWORK')
  }
  let body
  try {
    body = await response.json()
  } catch {
    throw new AppError('NETWORK')
  }
  if (!response.ok) throw new AppError(body.code || 'NETWORK')
  if (body.protocolVersion !== 1) throw new AppError('PROTOCOL_UNSUPPORTED')
  return body as T
}
let sessionPromise: Promise<Session> | null = null
export function ensureSession(): Promise<Session> {
  if (sessionPromise) return sessionPromise
  sessionPromise = (async () => {
    const health = await request<{ serverEpoch: string }>('/health')
    const previous = readSaved<Session>('session')
    if (previous?.serverEpoch === health.serverEpoch) return previous
    const session = await request<Session>('/sessions', { method: 'POST' })
    save('session', session)
    return session
  })().finally(() => {
    sessionPromise = null
  })
  return sessionPromise
}
export async function createRoom(nickname: string): Promise<RoomAccess> {
  const session = await ensureSession()
  let pending = readSaved<{ key: string; nickname: string; memberId: string }>('create')
  if (!pending || pending.memberId !== session.memberId) {
    pending = { key: crypto.randomUUID(), nickname, memberId: session.memberId }
    save('create', pending)
  }
  // Persist the original body and key so a lost response can be retried after reload.
  try {
    const room = await request<RoomAccess>('/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.sessionToken}`,
        'Idempotency-Key': pending.key,
      },
      body: JSON.stringify({ nickname: pending.nickname }),
    })
    const access = { ...room, nickname: pending.nickname, memberId: session.memberId }
    saveRoom(access)
    forget('create')
    return access
  } catch (error) {
    if (error instanceof AppError && !['NETWORK', 'STORAGE_UNAVAILABLE'].includes(error.code)) {
      forget('create')
      if (error.code === 'AUTH_REQUIRED') forget('session')
    }
    throw error
  }
}
export function parseRoomLink(value: string): RoomAccess | null {
  try {
    const hash = value.startsWith('#') ? value : new URL(value).hash
    const match = /^#\/room\/([A-Z0-9]{6,12})(?:\?(.*))?$/.exec(hash)
    if (!match) return null
    const params = new URLSearchParams(match[2])
    const invite = params.get('invite'),
      watch = params.get('watch')
    if (invite && watch) return null
    const token = invite || watch
    if (token && !/^[A-Za-z0-9_-]{16,256}$/.test(token)) return null
    return {
      roomId: match[1],
      ...(invite ? { inviteToken: invite } : {}),
      ...(watch ? { watchToken: watch } : {}),
    }
  } catch {
    return null
  }
}
export function roomHash(room: RoomAccess, watch = false) {
  const token = watch ? room.watchToken : room.inviteToken || room.watchToken
  const key = watch || !room.inviteToken ? 'watch' : 'invite'
  return `#/room/${room.roomId}${token ? `?${key}=${encodeURIComponent(token)}` : ''}`
}
export function roomLink(room: RoomAccess, watch = false) {
  return location.href.split('#')[0] + roomHash(room, watch)
}

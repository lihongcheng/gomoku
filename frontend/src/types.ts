export type Color = 'BLACK' | 'WHITE'
export type Phase = 'WAITING' | 'PLAYING' | 'FINISHED' | 'CLOSED'
export interface Move {
  row: number
  col: number
  color: Color
}
export interface Player {
  memberId: string
  nickname: string
  color: Color
  isOwner: boolean
  connected: boolean
  ready: boolean
  reconnectDeadline: string | null
}
export interface Self {
  memberId: string
  nickname: string
  role: 'PLAYER' | 'SPECTATOR'
  color: Color | null
  isOwner: boolean
  generation: number
}
export interface RoomState {
  type: 'room.state'
  protocolVersion: number
  serverEpoch: string
  roomId: string
  seq: number
  revision: number
  phase: Phase
  players: Player[]
  spectatorCount: number
  moves: Move[]
  currentTurn: Color | null
  result: {
    winner: Color | null
    reason: 'FIVE_IN_ROW' | 'DRAW' | 'RESIGNED' | 'PLAYER_LEFT' | 'DISCONNECT_TIMEOUT' | 'ABANDONED'
    winningLine: { row: number; col: number }[]
  } | null
  closeReason: string | null
  pendingUndo: {
    undoId: string
    requesterId: string
    requestedRevision: number
    targetLength: number
    removeCount: number
    expiresAt: string
  } | null
  serverTime: string
  deadlines: Record<'waiting' | 'idle' | 'idleWarning' | 'finished' | 'empty', string | null>
  maintenance: boolean
}
export interface Session {
  sessionToken: string
  memberId: string
  serverEpoch: string
  protocolVersion: number
}
export interface RoomAccess {
  roomId: string
  serverEpoch?: string
  memberId?: string
  nickname?: string
  inviteToken?: string
  watchToken?: string
}
export type CommandType =
  | 'game.ready'
  | 'move.play'
  | 'undo.request'
  | 'undo.respond'
  | 'game.resign'
  | 'room.leave'
  | 'room.close'
export interface Command {
  type: CommandType
  requestId: string
  expectedRevision: number
  payload: Record<string, unknown>
}
export const colorName = (color: Color | null) =>
  color === 'BLACK' ? '黑方' : color === 'WHITE' ? '白方' : '观战'
export const coordinate = (move: { row: number; col: number }) =>
  `${String.fromCharCode(65 + move.col)}${15 - move.row}`

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Copy,
  Eye,
  Flag,
  Link2,
  LoaderCircle,
  Plus,
  Radio,
  RotateCcw,
  Sprout,
  Users,
  X,
} from 'lucide-react'
import {
  AppError,
  SITE_PREVIEW,
  createRoom,
  ensureSession,
  parseRoomLink,
  readSaved,
  roomHash,
  roomLink,
  save,
  savedRoom,
  saveRoom,
} from './api'
import { RoomClient } from './client'
import type { CommandType, Move, RoomAccess, RoomState, Session } from './types'
import { colorName, coordinate } from './types'
import { Board } from './Board'

const demo: Move[] = [
  { row: 7, col: 7, color: 'BLACK' },
  { row: 7, col: 8, color: 'WHITE' },
  { row: 8, col: 8, color: 'BLACK' },
  { row: 6, col: 6, color: 'WHITE' },
  { row: 9, col: 9, color: 'BLACK' },
  { row: 6, col: 8, color: 'WHITE' },
  { row: 10, col: 10, color: 'BLACK' },
  { row: 6, col: 7, color: 'WHITE' },
]
function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。'
}
function goHome() {
  location.hash = '/'
}
function useHash() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const handler = () => setHash(location.hash)
    window.addEventListener('hashchange', handler)
    return () => window.removeEventListener('hashchange', handler)
  }, [])
  return hash
}
function NameInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <label className="field">
      你的昵称
      <input
        name="nickname"
        autoComplete="nickname"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={20}
        required
        placeholder="怎么称呼你？"
        disabled={disabled}
      />
    </label>
  )
}
function validName(name: string) {
  const value = name.trim()
  if (!value || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new Error('请输入 1–20 个字符的昵称。')
  save('nickname', value)
  return value
}
function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' }) {
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}
function Rules() {
  return (
    <details className="rules">
      <summary>
        <CircleHelp size={16} /> 玩法与房间规则
      </summary>
      <div>
        <p>15 × 15 自由五子棋，黑方先行，无禁手。横、竖或斜向连成五颗及以上即获胜。</p>
        <p>双方准备后开局。悔棋需要对方同意，30 秒未答复则自动拒绝。每个房间只进行一局。</p>
        <p>
          断线后保留席位 60
          秒，期间暂停落子。服务更新后房间可能失效，请重新创建。长时间无落子会中止对局。
        </p>
        <p>同一浏览器使用同一个匿名身份。与好友对战时，请使用各自的设备或独立浏览器。</p>
      </div>
    </details>
  )
}
function Home() {
  const [nickname, setNickname] = useState(readSaved<string>('nickname') || '')
  const [link, setLink] = useState('')
  const [tab, setTab] = useState<'create' | 'join'>('create')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || SITE_PREVIEW) return
    setError('')
    try {
      const name = validName(nickname)
      if (tab === 'join') {
        const access = parseRoomLink(link.trim())
        if (!access || !(access.inviteToken || access.watchToken))
          throw new Error('请粘贴完整的对战邀请或观战链接，仅房间号无法加入。')
        location.hash = roomHash(access)
      } else {
        setBusy(true)
        const room = await createRoom(name)
        location.hash = roomHash(room)
      }
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="home">
      <section className="hero">
        <div className="eyebrow">
          <span /> 随时相约，从容落子
        </div>
        <h1>
          好久不见，
          <br />
          下局<span>五子棋。</span>
        </h1>
        <p className="hero-description">
          一张棋盘，两位好友。
          <br />
          把忙碌放一边，在黑白之间见个面。
        </p>
        <div className="hero-tags">
          <span>
            <Users size={16} /> 好友对弈
          </span>
          <span>
            <Eye size={16} /> 实时观战
          </span>
          <span>
            <Sprout size={16} /> 轻松开局
          </span>
        </div>
        <div className="entry-card">
          <div className="tabs" role="tablist" aria-label="进入棋室方式">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'create'}
              onClick={() => {
                setTab('create')
                setError('')
              }}
              disabled={busy}
            >
              <Plus size={17} /> 创建房间
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'join'}
              onClick={() => {
                setTab('join')
                setError('')
              }}
              disabled={busy}
            >
              <Link2 size={17} /> 加入房间
            </button>
          </div>
          <form onSubmit={submit}>
            {SITE_PREVIEW && (
              <Notice>对战服务尚未开放，暂时无法创建或加入房间。欢迎先看看棋室与玩法。</Notice>
            )}
            <NameInput value={nickname} onChange={setNickname} disabled={busy || SITE_PREVIEW} />
            {tab === 'join' && (
              <label className="field">
                好友的邀请链接
                <input
                  type="text"
                  inputMode="url"
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  placeholder="粘贴完整邀请或观战链接"
                  disabled={SITE_PREVIEW}
                  required
                />
              </label>
            )}
            {error && <Notice tone="error">{error}</Notice>}
            <button className="button primary full" disabled={busy || SITE_PREVIEW}>
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={18} /> 正在连接棋室…
                </>
              ) : (
                <>
                  {tab === 'create' ? '开一间棋室' : '前往房间'}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
            <p className="form-note">
              {SITE_PREVIEW
                ? '对战服务开放后，即可邀请好友入座'
                : busy
                  ? '首次唤醒服务可能需要约一分钟，请稍候。'
                  : tab === 'create'
                    ? '无需注册 · 创建后即可邀请好友'
                    : '进入前会再次确认，满员房间可观战'}
            </p>
          </form>
        </div>
      </section>
      <section className="hero-visual" aria-label="五子棋示意棋盘">
        <div className="visual-top">
          <span>THE QUIET GAME</span>
          <span>黑 / 白 / 之间</span>
        </div>
        <Board moves={demo} decorative />
        <div className="visual-caption">
          <span className="caption-mark">弈</span>
          <div>
            胜负有时，落子有趣。<small>A LITTLE PAUSE. A GOOD GAME.</small>
          </div>
          <span className="caption-line" />
        </div>
      </section>
      <div className="home-bottom">
        <span>
          01 <b>创建棋室</b>
        </span>
        <ChevronRight size={15} />
        <span>
          02 <b>分享邀请</b>
        </span>
        <ChevronRight size={15} />
        <span>
          03 <b>准备开局</b>
        </span>
      </div>
      <Rules />
    </main>
  )
}
function JoinGate({ access }: { access: RoomAccess }) {
  const known = savedRoom(access.roomId)
  const session = readSaved<Session>('session')
  const canRestore = !!known?.memberId && known.memberId === session?.memberId
  const [joined, setJoined] = useState(canRestore)
  const [nickname, setNickname] = useState(known?.nickname || readSaved<string>('nickname') || '')
  const [error, setError] = useState('')
  const merged = { ...known, ...access }
  if (joined) return <RoomLoader access={merged} nickname={nickname || '棋友'} />
  return (
    <main className="join-page">
      <button className="text-button" onClick={goHome}>
        <ArrowLeft size={16} /> 返回首页
      </button>
      <section className="join-card">
        <div className="join-symbol">
          {access.watchToken ? <Eye size={32} /> : <Users size={32} />}
        </div>
        <div className="eyebrow">好友的棋室邀请</div>
        <h1>{access.watchToken ? '来观一局好棋。' : '棋盘已备，等你入座。'}</h1>
        <p>
          房间 <strong className="room-code">{access.roomId}</strong>
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            try {
              validName(nickname)
              setJoined(true)
            } catch (error) {
              setError(errorText(error))
            }
          }}
        >
          <NameInput value={nickname} onChange={setNickname} />
          {error && <Notice tone="error">{error}</Notice>}
          <button className="button primary full">
            {access.watchToken ? '进入观战' : '确认加入'}
            <ArrowRight size={18} />
          </button>
        </form>
        <p className="form-note">
          {access.watchToken
            ? '只读观战链接，不占用对战席位。'
            : '首位好友执白入座，满员后自动进入观战。'}
        </p>
      </section>
    </main>
  )
}
function RoomLoader({ access, nickname }: { access: RoomAccess; nickname: string }) {
  const [client, setClient] = useState<RoomClient | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let canceled = false
    let active: RoomClient | undefined
    setError('')
    ensureSession()
      .then((session) => {
        if (canceled) return
        if (access.serverEpoch && access.serverEpoch !== session.serverEpoch)
          throw new AppError('SERVER_CHANGED')
        active = new RoomClient(access, session, nickname.trim())
        active.start()
        setClient(active)
      })
      .catch((error) => {
        if (!canceled) setError(errorText(error))
      })
    return () => {
      canceled = true
      active?.stop()
    }
  }, [access.roomId, attempt]) // Access and nickname are fixed for this mounted room.
  if (client) return <RoomView client={client} access={access} />
  return (
    <main className="loading-page">
      {error ? (
        <>
          <Notice tone="error">{error}</Notice>
          <button className="button" onClick={() => setAttempt((value) => value + 1)}>
            重试连接
          </button>
          <button className="text-button" onClick={goHome}>
            返回首页
          </button>
        </>
      ) : (
        <>
          <LoaderCircle size={30} className="spin" />
          <h1>正在打开棋室</h1>
          <p>首次唤醒服务可能需要约一分钟，请稍候。</p>
        </>
      )}
    </main>
  )
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
    return () => ref.current?.close()
  }, [])
  return (
    <dialog ref={ref} onCancel={onClose} className="modal">
      <button className="icon-button modal-close" aria-label="关闭弹窗" onClick={onClose}>
        <X size={20} />
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  )
}
function seconds(deadline: string | null | undefined, now: number) {
  return deadline ? Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000)) : 0
}
const resultReason: Record<string, string> = {
  FIVE_IN_ROW: '五子连珠',
  RESIGNED: '对手认输',
  PLAYER_LEFT: '对手离开',
  DISCONNECT_TIMEOUT: '对手重连超时',
  DRAW: '棋盘已满',
  ABANDONED: '对局因断线或长时间无落子中止',
}
function statusTitle(room: RoomState, color: string | null, spectator: boolean) {
  if (room.phase === 'CLOSED') return '棋室已关闭'
  if (room.phase === 'FINISHED')
    return room.result?.winner
      ? `${colorName(room.result.winner)}获胜`
      : room.result?.reason === 'DRAW'
        ? '平局，旗鼓相当'
        : '本局已中止'
  if (room.players.some((player) => !player.connected)) return '暂歇片刻，等待重连'
  if (room.pendingUndo) return '等待悔棋答复'
  if (room.phase === 'WAITING')
    return room.players.length < 2 ? '虚位以待，邀友入座' : '双方准备，即可开局'
  return spectator
    ? `${colorName(room.currentTurn)}落子中`
    : room.currentTurn === color
      ? '轮到你了，从容落子'
      : '对方正在思考'
}
function RoomView({ client, access }: { client: RoomClient; access: RoomAccess }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const { room, self, connection, busy } = state
  const [now, setNow] = useState(Date.now())
  const [selected, setSelected] = useState<{ row: number; col: number; revision: number } | null>(
    null,
  )
  const [numbers, setNumbers] = useState(false)
  const [modal, setModal] = useState<'share' | 'resign' | 'leave' | 'close' | null>(null)
  const [copied, setCopied] = useState('')
  const [localError, setLocalError] = useState('')
  const [undoUntil, setUndoUntil] = useState(0)
  const [undoBoard, setUndoBoard] = useState('')
  const moveLog = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    setSelected(null)
  }, [connection, room?.revision])
  useEffect(() => {
    moveLog.current?.scrollTo({ top: moveLog.current.scrollHeight })
  }, [room?.moves.length])
  useEffect(() => {
    if (self && room) {
      try {
        saveRoom({
          ...access,
          memberId: self.memberId,
          nickname: self.nickname,
          serverEpoch: room.serverEpoch,
        })
      } catch (error) {
        setLocalError(errorText(error))
      }
    }
  }, [self?.memberId, room?.serverEpoch])
  const online = connection === 'online'
  const spectator = self?.role === 'SPECTATOR'
  const myPlayer = room?.players.find((player) => player.memberId === self?.memberId)
  const bothOnline = room?.players.length === 2 && room.players.every((player) => player.connected)
  const playable =
    online &&
    !busy &&
    room?.phase === 'PLAYING' &&
    bothOnline &&
    !room.pendingUndo &&
    !spectator &&
    room.currentTurn === self?.color
  const selection = playable && selected?.revision === room?.revision ? selected : null
  const clock = now + state.clockOffset
  const boardKey = JSON.stringify(room?.moves)
  useEffect(() => {
    // A new move or approved undo allows a fresh request, even if later moves
    // recreate a previously seen board. The server still owns the cooldown.
    setUndoBoard('')
  }, [boardKey])
  const canUndo =
    online &&
    !busy &&
    room?.phase === 'PLAYING' &&
    bothOnline &&
    !room.pendingUndo &&
    !spectator &&
    room.moves.some((move) => move.color === self?.color) &&
    clock >= undoUntil &&
    boardKey !== undoBoard
  async function act(type: CommandType, payload: Record<string, unknown> = {}) {
    setLocalError('')
    try {
      await client.command(type, payload)
      if (type === 'undo.request') {
        setUndoUntil(clock + 30_000)
        setUndoBoard(boardKey)
      }
      if (type === 'room.leave' || type === 'room.close') {
        client.stop()
        goHome()
      }
      setSelected(null)
      return true
    } catch (error) {
      setLocalError(errorText(error))
      return false
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
    } catch {
      setCopied('复制未成功，请选中下方链接手动复制。')
    }
  }
  const error = state.error || localError
  return (
    <main
      className="room-page"
      data-testid="room"
      data-phase={room?.phase || 'CONNECTING'}
      data-connection={connection}
    >
      <div className="room-toolbar">
        <div>
          <span className="eyebrow">此刻，相聚于此</span>
          <h1>
            好友棋室 <span className="room-code">{access.roomId}</span>
          </h1>
        </div>
        <div className="room-toolbar-actions">
          <span className={`connection ${online ? 'connected' : ''}`}>
            <span />
            {online ? '实时连接' : connection === 'stopped' ? '连接已停止' : '正在恢复连接'}
          </span>
          <button className="button small" onClick={() => setModal('share')}>
            <Link2 size={16} /> 邀请好友
          </button>
        </div>
      </div>
      {error && (
        <Notice tone="error">
          {error}
          <button
            className="text-button"
            onClick={() => {
              client.clearError()
              setLocalError('')
            }}
            aria-label="收起提示"
          >
            <X size={16} />
          </button>
        </Notice>
      )}
      {connection === 'stopped' && (
        <div className="recovery-actions">
          <button className="button primary" onClick={goHome}>
            返回首页
          </button>
        </div>
      )}
      {!online && connection !== 'stopped' && (
        <Notice>
          <LoaderCircle size={17} className="spin" />{' '}
          正在连接并同步棋盘；连接恢复后才可操作。关闭页面不会立即退出席位。
          <button className="text-button" onClick={goHome}>
            返回首页
          </button>
        </Notice>
      )}
      {room?.maintenance && <Notice>棋室即将维护，本局可继续，暂时不能创建新房间。</Notice>}
      {room?.phase === 'PLAYING' &&
        room.deadlines.idle &&
        seconds(room.deadlines.idle, clock) <= 60 && (
          <Notice>
            本局长时间没有落子，将在约 {seconds(room.deadlines.idle, clock)} 秒后中止。
          </Notice>
        )}
      <div className="room-layout">
        <section className="play-area">
          <div className="turn-heading" aria-live="polite">
            <div className={`turn-stone ${room?.currentTurn === 'WHITE' ? 'white' : ''}`} />
            <div>
              <h2 data-testid="game-status">
                {room ? statusTitle(room, self?.color || null, !!spectator) : '棋室正在连接'}
              </h2>
              <p>
                {room?.phase === 'FINISHED'
                  ? resultReason[room.result?.reason || '']
                  : spectator
                    ? '你正在观战 · 安静欣赏每一步'
                    : room?.phase === 'WAITING'
                      ? '落子之前，先与好友说声准备好了'
                      : `你执${self?.color === 'BLACK' ? '黑' : '白'} · 黑方先行 · 自由五子棋`}
              </p>
            </div>
            <span className="move-counter" data-testid="move-count">
              {String(room?.moves.length || 0).padStart(2, '0')}
              <small>手</small>
            </span>
          </div>
          <Board
            moves={room?.moves || []}
            playable={!!playable}
            color={self?.color}
            selected={selection}
            onSelect={(row, col) => setSelected({ row, col, revision: room!.revision })}
            showNumbers={numbers}
            winningLine={room?.result?.winningLine}
          />
          <div className="board-bottom">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={numbers}
                onChange={(event) => setNumbers(event.target.checked)}
              />{' '}
              显示手数
            </label>
            <span>
              15 × 15 <i /> 无禁手
            </span>
          </div>
          {!spectator && room?.phase === 'PLAYING' && (
            <div className="move-confirm">
              <span>
                {selection ? (
                  <>
                    已选 <strong>{coordinate(selection)}</strong>，确认后落子
                  </>
                ) : playable ? (
                  '点击交点选位，再确认落子'
                ) : busy ? (
                  '正在确认操作…'
                ) : (
                  '棋盘随对局实时同步'
                )}
              </span>
              <button
                className="button primary"
                disabled={!selection}
                onClick={() => {
                  if (selection) void act('move.play', { row: selection.row, col: selection.col })
                }}
              >
                <Check size={17} /> 确认落子
              </button>
            </div>
          )}
          {room?.phase === 'FINISHED' && (
            <div className="result-banner">
              <div>
                <b>
                  {room.result?.winner
                    ? `${colorName(room.result.winner)}，好棋！`
                    : '感谢这局相伴'}
                </b>
                <p>本房间一局一会。返回首页，邀请好友再来一局。</p>
              </div>
              <button
                className="button primary"
                onClick={() => void act('room.leave')}
                disabled={!online || busy}
              >
                返回首页
              </button>
            </div>
          )}
        </section>
        <aside className="room-sidebar">
          <section className="panel players-panel">
            <div className="panel-title">
              <h2>对弈席</h2>
              <span>
                {spectator ? '观战中' : self ? `你是${colorName(self.color)}` : '正在入座'}
              </span>
            </div>
            {(['BLACK', 'WHITE'] as const).map((color) => {
              const player = room?.players.find((player) => player.color === color)
              return (
                <div
                  className={`player-row ${player?.memberId === self?.memberId ? 'is-self' : ''}`}
                  key={color}
                >
                  <div className={`player-stone ${color === 'WHITE' ? 'white' : ''}`} />
                  <div className="player-info">
                    <strong>
                      {player?.nickname || '等待好友'}
                      {player?.memberId === self?.memberId && <small>你</small>}
                    </strong>
                    <span>
                      {colorName(color)}
                      {color === 'BLACK' ? ' · 先行' : ''}
                      {player?.isOwner ? ' · 房主' : ''}
                    </span>
                  </div>
                  <span className={`player-status ${player?.ready ? 'ready' : ''}`}>
                    {!player
                      ? '待入座'
                      : !player.connected
                        ? `${seconds(player.reconnectDeadline, clock)}s 重连`
                        : room?.phase === 'WAITING'
                          ? player.ready
                            ? '已准备'
                            : '未准备'
                          : room?.currentTurn === color
                            ? '思考中'
                            : '在线'}
                  </span>
                </div>
              )
            })}
            {room?.phase === 'WAITING' && !spectator && (
              <button
                className="button primary full"
                disabled={!online || busy || !bothOnline}
                onClick={() => void act('game.ready', { ready: !myPlayer?.ready })}
              >
                <CheckCheck size={18} />
                {myPlayer?.ready ? '取消准备' : '准备好了'}
              </button>
            )}
            {room?.phase === 'WAITING' && (
              <p className="form-note">
                {room.players.length < 2
                  ? '分享邀请链接，让好友执白入座'
                  : spectator
                    ? '双方准备后开局'
                    : myPlayer?.ready
                      ? '已准备，等待好友'
                      : '双方点击准备后，黑方先行'}{' '}
                · 约 {Math.ceil(seconds(room.deadlines.waiting, clock) / 60)} 分钟后关闭未开局房间
              </p>
            )}
            {room?.phase === 'PLAYING' && !spectator && (
              <div className="game-actions">
                <button
                  className="button"
                  disabled={!canUndo}
                  onClick={() => void act('undo.request')}
                  title={clock < undoUntil ? '申请间隔至少 30 秒' : '需对手同意'}
                >
                  <RotateCcw size={16} /> 申请悔棋
                </button>
                <button
                  className="button subtle"
                  disabled={!online || busy}
                  onClick={() => setModal('resign')}
                >
                  <Flag size={16} /> 认输
                </button>
              </div>
            )}
            <div className="spectators">
              <Eye size={15} />
              <span>
                <b data-testid="spectator-count">{room?.spectatorCount || 0}</b> 位棋友正在观战
              </span>
              <span className="live-dot" />
            </div>
          </section>
          {room?.pendingUndo && (
            <section className="panel undo-panel" role="status">
              <div className="panel-title">
                <h2>
                  <RotateCcw size={17} /> 悔棋申请
                </h2>
                <span>{seconds(room.pendingUndo.expiresAt, clock)}s</span>
              </div>
              <p>
                {room.pendingUndo.requesterId === self?.memberId
                  ? '你申请'
                  : `${room.players.find((player) => player.memberId === room.pendingUndo!.requesterId)?.nickname || '对方'}申请`}
                撤回最近 {room.pendingUndo.removeCount} 手。
              </p>
              <p className="muted">
                撤销：
                {room.moves
                  .slice(room.pendingUndo.targetLength)
                  .map(
                    (move, index) =>
                      `${room.pendingUndo!.targetLength + index + 1}. ${colorName(move.color)} ${coordinate(move)}`,
                  )
                  .join('、')}
                。同意后由申请方落子。
              </p>
              {!spectator && room.pendingUndo.requesterId !== self?.memberId ? (
                <div className="game-actions">
                  <button
                    className="button primary"
                    disabled={!online || busy || seconds(room.pendingUndo.expiresAt, clock) === 0}
                    onClick={() =>
                      void act('undo.respond', { undoId: room.pendingUndo!.undoId, accept: true })
                    }
                  >
                    同意悔棋
                  </button>
                  <button
                    className="button"
                    disabled={!online || busy || seconds(room.pendingUndo.expiresAt, clock) === 0}
                    onClick={() =>
                      void act('undo.respond', { undoId: room.pendingUndo!.undoId, accept: false })
                    }
                  >
                    拒绝
                  </button>
                </div>
              ) : (
                <small>等待对方答复，超时自动拒绝。</small>
              )}
            </section>
          )}
          <section className="panel history-panel">
            <div className="panel-title">
              <h2>本局棋谱</h2>
              <span>共 {room?.moves.length || 0} 手</span>
            </div>
            {room?.moves.length ? (
              <ol className="move-log" ref={moveLog} aria-label="本局棋谱">
                {room.moves.map((move, index) => (
                  <li key={index}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <i className={move.color.toLowerCase()} />
                    <b>{coordinate(move)}</b>
                    {index === room.moves.length - 1 && <small>最新</small>}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="empty-history">
                <span>· · ·</span>
                <p>棋盘尚静，故事待续</p>
                <small>第一手落下后，棋谱会出现在这里。</small>
              </div>
            )}
          </section>
          <Rules />
          <div className="exit-actions">
            <button
              className="text-button"
              onClick={() => (connection === 'stopped' ? goHome() : setModal('leave'))}
            >
              <ArrowLeft size={15} />
              {spectator ? '退出观战' : '离开房间'}
            </button>
            {self?.isOwner && room?.phase !== 'PLAYING' && room?.phase !== 'CLOSED' && (
              <button
                className="text-button danger"
                disabled={!online || busy}
                onClick={() => setModal('close')}
              >
                关闭房间
              </button>
            )}
          </div>
        </aside>
      </div>
      {modal === 'share' && (
        <Modal
          title="好棋，邀好友一起。"
          onClose={() => {
            setModal(null)
            setCopied('')
          }}
        >
          <p className="muted">对战邀请的首位新好友执白入座，满员后自动观战。</p>
          {access.inviteToken && (
            <ShareField
              label="对战邀请链接"
              value={roomLink(access)}
              onCopy={() => void copy(roomLink(access), '对战邀请已复制')}
            />
          )}
          {access.watchToken && (
            <ShareField
              label="仅观战链接"
              value={roomLink(access, true)}
              onCopy={() => void copy(roomLink(access, true), '观战链接已复制')}
            />
          )}
          {!access.inviteToken && !access.watchToken && <p>请向房主获取邀请链接。</p>}
          {!access.watchToken && access.inviteToken && (
            <p className="form-note">独立的仅观战链接可向房主获取。</p>
          )}
          {copied && (
            <Notice>
              <Check size={16} /> {copied}
            </Notice>
          )}
        </Modal>
      )}
      {modal && modal !== 'share' && (
        <Modal
          title={
            modal === 'resign'
              ? '确定认输吗？'
              : modal === 'close'
                ? '关闭这间棋室？'
                : '准备离开棋室？'
          }
          onClose={() => setModal(null)}
        >
          <p className="muted">
            {modal === 'close'
              ? '所有人将离开，邀请链接随即失效。'
              : modal === 'resign' || (!spectator && room?.phase === 'PLAYING')
                ? '确认后本局判对方获胜，无法撤销。'
                : !spectator && room?.phase === 'WAITING'
                  ? '开局前玩家离开会关闭房间，请确认好友已知晓。'
                  : '退出后仍可用原邀请链接回来查看未关闭的房间。'}
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setModal(null)}>
              再想想
            </button>
            <button
              className="button danger-fill"
              disabled={!online || busy}
              onClick={async () => {
                const success = await act(
                  modal === 'resign'
                    ? 'game.resign'
                    : modal === 'close'
                      ? 'room.close'
                      : 'room.leave',
                )
                if (success) setModal(null)
              }}
            >
              {modal === 'resign' ? '确认认输' : modal === 'close' ? '确认关闭' : '确认离开'}
            </button>
          </div>
          {error && <Notice tone="error">{error}</Notice>}
        </Modal>
      )}
    </main>
  )
}
function ShareField({
  label,
  value,
  onCopy,
}: {
  label: string
  value: string
  onCopy: () => void
}) {
  return (
    <label className="field share-field">
      {label}
      <div>
        <input value={value} readOnly onFocus={(event) => event.currentTarget.select()} />
        <button className="button" onClick={onCopy} aria-label={`复制${label}`}>
          <Copy size={17} />
        </button>
      </div>
    </label>
  )
}
export default function App() {
  const hash = useHash()
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 })
  }, [hash])
  const access = parseRoomLink(hash)
  const isHome = !hash || hash === '#' || hash === '#/'
  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand" aria-label="对弈在线棋室">
          <div className="brand-icon">
            <i />
            <i />
          </div>
          <strong>对弈</strong>
          <span>一间在线棋室</span>
        </div>
        <span className="header-note">
          <Radio size={15} /> 与好友，共一局
        </span>
      </header>
      {isHome ? (
        <Home />
      ) : access && SITE_PREVIEW ? (
        <main className="loading-page">
          <h1>对战服务尚未开放</h1>
          <p>暂时无法加入房间，请在服务开放后使用新的邀请链接。</p>
          <button className="button primary" onClick={goHome}>
            返回首页
          </button>
        </main>
      ) : access ? (
        <JoinGate key={access.roomId} access={access} />
      ) : (
        <main className="loading-page">
          <h1>这封邀请似乎不完整</h1>
          <p>请向好友获取完整链接，再来相聚。</p>
          <button className="button primary" onClick={goHome}>
            返回首页
          </button>
        </main>
      )}
      <footer className="site-footer">
        <span>
          对弈 <i /> 落子之间，自有天地。
        </span>
        <span>自由五子棋 · 邀请制棋室</span>
      </footer>
    </div>
  )
}

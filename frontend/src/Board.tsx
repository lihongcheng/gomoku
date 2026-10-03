import { useId, useRef, useState } from 'react'
import type { Color, Move } from './types'
import { coordinate } from './types'

interface Props {
  moves: Move[]
  playable?: boolean
  color?: Color | null
  selected?: { row: number; col: number } | null
  onSelect?: (row: number, col: number) => void
  showNumbers?: boolean
  winningLine?: { row: number; col: number }[]
  decorative?: boolean
}
export function Board({
  moves,
  playable,
  color,
  selected,
  onSelect,
  showNumbers,
  winningLine = [],
  decorative,
}: Props) {
  const id = useId().replace(/:/g, '')
  const cells = useRef<(HTMLButtonElement | null)[]>([])
  const [focus, setFocus] = useState(112)
  return (
    <div className={`board ${decorative ? 'board-demo' : ''}`}>
      <svg viewBox="0 0 600 600" className="board-svg" aria-hidden="true">
        <defs>
          <radialGradient id={`${id}-black`} cx="32%" cy="25%" r="75%">
            <stop stopColor="#556057" />
            <stop offset="0.55" stopColor="#28312b" />
            <stop offset="1" stopColor="#171e1a" />
          </radialGradient>
          <radialGradient id={`${id}-white`} cx="30%" cy="22%" r="80%">
            <stop stopColor="#fff" />
            <stop offset="0.7" stopColor="#f5f4ec" />
            <stop offset="1" stopColor="#d9d8ca" />
          </radialGradient>
        </defs>
        {Array.from({ length: 15 }, (_, index) => (
          <g key={index}>
            <path
              d={`M 48 ${48 + index * 36} H 552 M ${48 + index * 36} 48 V 552`}
              className="grid-line"
            />
            <text x={48 + index * 36} y="581" className="board-coordinate">
              {String.fromCharCode(65 + index)}
            </text>
            <text x="23" y={52 + index * 36} className="board-coordinate">
              {15 - index}
            </text>
          </g>
        ))}
        {[3, 7, 11].flatMap((row) =>
          [3, 7, 11].map((col) =>
            (row === 7) !== (col === 7) ? null : (
              <circle
                key={`${row}-${col}`}
                cx={48 + col * 36}
                cy={48 + row * 36}
                r="3.5"
                fill="#978b69"
              />
            ),
          ),
        )}
        {moves.map((move, index) => {
          const x = 48 + move.col * 36,
            y = 48 + move.row * 36
          const winning = winningLine.some(
            (point) => point.row === move.row && point.col === move.col,
          )
          return (
            <g key={`${move.row}-${move.col}`} className="stone">
              <circle cx={x + 1} cy={y + 2} r="16" fill="#3a321e" opacity=".17" />
              <circle
                cx={x}
                cy={y}
                r="15.5"
                fill={`url(#${id}-${move.color.toLowerCase()})`}
                stroke={move.color === 'WHITE' ? '#bcbcae' : '#17251d'}
                strokeWidth=".6"
              />
              {winning && (
                <circle cx={x} cy={y} r="18" stroke="#bc684d" fill="none" strokeWidth="2.5" />
              )}
              {showNumbers ? (
                <text
                  x={x}
                  y={y + 4}
                  textAnchor="middle"
                  fontSize="12"
                  fill={move.color === 'BLACK' ? '#fff' : '#273c30'}
                >
                  {index + 1}
                </text>
              ) : (
                index === moves.length - 1 && (
                  <rect
                    x={x - 3}
                    y={y - 3}
                    width="6"
                    height="6"
                    rx="1"
                    fill={move.color === 'BLACK' ? '#e8bd84' : '#ae674d'}
                  />
                )
              )}
            </g>
          )
        })}
        {selected && (
          <g className="selected-stone">
            <circle
              cx={48 + selected.col * 36}
              cy={48 + selected.row * 36}
              r="15"
              fill={color === 'WHITE' ? '#fff' : '#234d40'}
              opacity=".4"
            />
            <circle
              cx={48 + selected.col * 36}
              cy={48 + selected.row * 36}
              r="18"
              stroke="#234d40"
              strokeWidth="2"
              strokeDasharray="4 3"
              fill="none"
            />
          </g>
        )}
      </svg>
      {!decorative && (
        <div className="board-hit-grid" role="group" aria-label="15乘15棋盘，方向键选点，回车选择">
          {Array.from({ length: 225 }, (_, index) => {
            const row = Math.floor(index / 15),
              col = index % 15
            const stone = moves.find((move) => move.row === row && move.col === col)
            return (
              <button
                key={index}
                ref={(node) => {
                  cells.current[index] = node
                }}
                className="intersection"
                data-testid={`cell-${row}-${col}`}
                tabIndex={focus === index ? 0 : -1}
                aria-label={`${coordinate({ row, col })}${stone ? ` ${stone.color === 'BLACK' ? '黑子' : '白子'}` : ' 空位'}`}
                aria-disabled={!playable || !!stone}
                aria-pressed={selected?.row === row && selected.col === col}
                onFocus={() => setFocus(index)}
                onClick={() => {
                  if (playable && !stone) onSelect?.(row, col)
                }}
                onKeyDown={(event) => {
                  const next =
                    event.key === 'ArrowLeft'
                      ? row * 15 + Math.max(0, col - 1)
                      : event.key === 'ArrowRight'
                        ? row * 15 + Math.min(14, col + 1)
                        : event.key === 'ArrowUp'
                          ? Math.max(0, row - 1) * 15 + col
                          : event.key === 'ArrowDown'
                            ? Math.min(14, row + 1) * 15 + col
                            : null
                  if (next !== null) {
                    event.preventDefault()
                    cells.current[next]?.focus()
                  }
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

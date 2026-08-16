import type { Board, Stop } from './types'

const LAST_BOARD_KEY = 'njt.lastBoard.v1'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function fetchBoard(stopId: string, signal?: AbortSignal): Promise<Board> {
  const res = await fetch(`/api/departures?stop=${encodeURIComponent(stopId)}`, {
    signal,
    headers: { Accept: 'application/json' },
  })

  const body = await res.json().catch(() => null)

  if (!res.ok) {
    throw new ApiError(body?.error ?? `Board request failed (${res.status})`, res.status)
  }
  return body as Board
}

export async function fetchStops(): Promise<{ stops: Stop[]; defaultStopId: string }> {
  const res = await fetch('/api/stops', { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new ApiError('Could not load stops', res.status)
  return res.json()
}

/**
 * Last board that rendered, kept so a cold start with no connection shows the
 * previous departures instead of an empty screen. The service worker caches the
 * HTTP response too; this covers the case where the app opens before the worker
 * can answer, and survives cache eviction.
 */
export function saveLastBoard(board: Board): void {
  try {
    localStorage.setItem(LAST_BOARD_KEY, JSON.stringify(board))
  } catch {
    // Private mode or a full quota — the app works without this.
  }
}

export function loadLastBoard(): Board | null {
  try {
    const raw = localStorage.getItem(LAST_BOARD_KEY)
    if (!raw) return null
    const board = JSON.parse(raw) as Board
    return Array.isArray(board?.departures) ? board : null
  } catch {
    return null
  }
}

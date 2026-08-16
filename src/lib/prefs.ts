import type { SortMode } from './types'

const KEY = 'njt.prefs.v1'

export interface Prefs {
  stopId: string
  sort: SortMode
  /** Routes the rider actually takes; empty means show everything. */
  pinnedRoutes: string[]
  /** When true, only pinned routes appear on the board. */
  onlyPinned: boolean
}

const DEFAULTS: Prefs = {
  stopId: '',
  sort: 'time',
  pinnedRoutes: [],
  onlyPinned: false,
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Prefs>
    return {
      ...DEFAULTS,
      ...parsed,
      pinnedRoutes: Array.isArray(parsed.pinnedRoutes) ? parsed.pinnedRoutes : [],
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Preferences are a convenience; losing them shouldn't break the board.
  }
}

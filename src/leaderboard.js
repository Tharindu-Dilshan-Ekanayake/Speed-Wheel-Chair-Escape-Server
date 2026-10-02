import { db } from './db.js'

/**
 * Global leaderboards. Every pod reads the same Mongo database, so these are shared
 * across all lobbies. Refreshed on a timer and cached; rooms push the cache to clients.
 */

const REFRESH_MS = 20_000

let cache = { level: [], rebirths: [], wins: [], at: 0 }
const listeners = new Set()

async function refresh() {
  try {
    const [level, rebirths, wins] = await Promise.all([
      db.top('totalLevel'),
      db.top('rebirths'),
      db.top('wins'),
    ])
    const map = (rows, field) => rows.map((r) => ({ name: r.name || 'Player', value: r[field] || 0 }))
    cache = {
      level: map(level, 'totalLevel'),
      rebirths: map(rebirths, 'rebirths'),
      wins: map(wins, 'wins'),
      at: Date.now(),
    }
    for (const fn of listeners) fn(cache)
  } catch (err) {
    console.warn('[lb] refresh failed:', err.message)
  }
}

let timer = null
export function startLeaderboards() {
  if (timer) return
  refresh()
  timer = setInterval(refresh, REFRESH_MS)
  timer.unref?.()
}

export const getLeaderboards = () => cache

export function onLeaderboards(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

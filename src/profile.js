import crypto from 'node:crypto'

import {
  AURAS,
  CHAIRS,
  DAILY_COOLDOWN_MS,
  DAILY_REWARDS,
  DAILY_STREAK_RESET_MS,
  EGGS,
  MAX_LEVEL,
  MAX_PETS,
  PETS,
  TRAILS,
  TREADMILLS,
  X2_BOOST,
  maxWalkSpeed,
  petSlots,
  xpForLevel,
} from './shared/gameData.js'

/**
 * Profile = everything we persist for a player. All the economy rules live here as
 * plain functions that mutate a profile and return `{ ok, error?, ... }`, so the room
 * stays a thin message router.
 */

export function newProfile(uid, name) {
  const now = Date.now()
  return {
    _id: uid,
    name,
    level: 1,
    xp: 0,
    speed: 0,
    totalSpeed: 0,
    wins: 0,
    rebirths: 0,
    totalLevel: 1,
    chair: 'classic',
    chairs: ['classic'],
    treadmills: ['t1'],
    pets: [],
    equippedPets: [],
    trail: 'none',
    trails: ['none'],
    aura: 'none',
    auras: ['none'],
    customSpeed: 0,
    maxStage: 1,
    stagesCleared: 0,
    daily: { last: 0, streak: 0 },
    boostUntil: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/** Fills any fields added since the profile was first saved. */
export function migrate(p, uid, name) {
  const base = newProfile(uid, name)
  const out = { ...base, ...p, _id: uid }
  for (const key of ['chairs', 'treadmills', 'pets', 'equippedPets', 'trails', 'auras']) {
    if (!Array.isArray(out[key])) out[key] = base[key]
  }
  if (!out.daily || typeof out.daily !== 'object') out.daily = base.daily
  if (name) out.name = name
  return out
}

const fail = (error) => ({ ok: false, error })

function pay(p, price, reb = 0) {
  if ((p.rebirths || 0) < reb) return fail(`Needs ${reb} rebirth${reb === 1 ? '' : 's'}!`)
  if (p.wins < price) return fail('Not enough wins!')
  p.wins -= price
  return { ok: true }
}

/**
 * Adds speed (and the same amount of XP). Returns the level-up, if any.
 * At MAX_LEVEL the XP bar just fills up and waits for a rebirth.
 */
export function addSpeed(p, amount) {
  amount = Math.max(0, Math.floor(amount))
  if (!amount) return null
  p.speed += amount
  p.totalSpeed += amount
  const before = { level: p.level, walk: maxWalkSpeed(p) }
  p.xp += amount
  while (p.level < MAX_LEVEL && p.xp >= xpForLevel(p.level)) {
    p.xp -= xpForLevel(p.level)
    p.level += 1
  }
  if (p.level >= MAX_LEVEL) p.xp = Math.min(p.xp, xpForLevel(MAX_LEVEL))
  p.totalLevel = p.rebirths * MAX_LEVEL + p.level
  if (p.level !== before.level) {
    return { from: before.level, to: p.level, walkFrom: before.walk, walkTo: maxWalkSpeed(p) }
  }
  return null
}

export function rebirth(p) {
  if (p.level < MAX_LEVEL) return fail(`Reach level ${MAX_LEVEL} to rebirth!`)
  p.rebirths += 1
  p.level = 1
  p.xp = 0
  p.speed = 0
  p.customSpeed = 0
  p.totalLevel = p.rebirths * MAX_LEVEL + p.level
  return { ok: true }
}

export function chairAction(p, id) {
  const c = CHAIRS.find((x) => x.id === id)
  if (!c) return fail('Unknown chair')
  if (!p.chairs.includes(id)) {
    const r = pay(p, c.price, c.reb)
    if (!r.ok) return r
    p.chairs.push(id)
  }
  p.chair = id
  return { ok: true, bought: true }
}

export function buyTreadmill(p, id) {
  const t = TREADMILLS.find((x) => x.id === id)
  if (!t) return fail('Unknown treadmill')
  if (p.treadmills.includes(id)) return fail('Already owned')
  const r = pay(p, t.price, t.reb)
  if (!r.ok) return r
  p.treadmills.push(id)
  return { ok: true }
}

function rollPet(egg) {
  const total = egg.pets.reduce((s, [, w]) => s + w, 0)
  let roll = Math.random() * total
  for (const [type, w] of egg.pets) {
    roll -= w
    if (roll <= 0) return type
  }
  return egg.pets[0][0]
}

export function hatch(p, eggId) {
  const egg = EGGS.find((e) => e.id === eggId)
  if (!egg) return fail('Unknown egg')
  if (p.pets.length >= MAX_PETS) return fail('Pet inventory full! Delete some pets.')
  const r = pay(p, egg.price, egg.reb)
  if (!r.ok) return r
  const pet = { uid: crypto.randomBytes(5).toString('hex'), type: rollPet(egg) }
  p.pets.push(pet)
  if (p.equippedPets.length < petSlots(p.rebirths)) p.equippedPets.push(pet.uid)
  return { ok: true, pet }
}

export function equipPet(p, uid, on) {
  if (!p.pets.some((x) => x.uid === uid)) return fail('Unknown pet')
  const i = p.equippedPets.indexOf(uid)
  if (on) {
    if (i >= 0) return { ok: true }
    if (p.equippedPets.length >= petSlots(p.rebirths)) return fail('All pet slots are full!')
    p.equippedPets.push(uid)
  } else if (i >= 0) {
    p.equippedPets.splice(i, 1)
  }
  return { ok: true }
}

export function equipBest(p) {
  const sorted = [...p.pets].sort((a, b) => (PETS[b.type]?.mult || 0) - (PETS[a.type]?.mult || 0))
  p.equippedPets = sorted.slice(0, petSlots(p.rebirths)).map((x) => x.uid)
  return { ok: true }
}

export function deletePet(p, uid) {
  const i = p.pets.findIndex((x) => x.uid === uid)
  if (i < 0) return fail('Unknown pet')
  p.pets.splice(i, 1)
  p.equippedPets = p.equippedPets.filter((x) => x !== uid)
  return { ok: true }
}

export function cosmetic(p, kind, id) {
  const list = kind === 'trail' ? TRAILS : kind === 'aura' ? AURAS : null
  if (!list) return fail('Unknown item')
  const item = list.find((x) => x.id === id)
  if (!item) return fail('Unknown item')
  const owned = kind === 'trail' ? p.trails : p.auras
  if (!owned.includes(id)) {
    const r = pay(p, item.price, item.reb)
    if (!r.ok) return r
    owned.push(id)
  }
  p[kind] = id
  return { ok: true }
}

export function claimDaily(p, now = Date.now()) {
  const since = now - (p.daily.last || 0)
  if (since < DAILY_COOLDOWN_MS) return fail('Come back later for your next gift!')
  const streak = since > DAILY_STREAK_RESET_MS ? 1 : (p.daily.streak % DAILY_REWARDS.length) + 1
  const wins = DAILY_REWARDS[streak - 1]
  p.daily = { last: now, streak }
  p.wins += wins
  return { ok: true, wins, streak }
}

export function buyX2(p, now = Date.now()) {
  const r = pay(p, X2_BOOST.price)
  if (!r.ok) return r
  p.boostUntil = Math.max(now, p.boostUntil || 0) + X2_BOOST.minutes * 60 * 1000
  return { ok: true }
}

export function setCustomSpeed(p, n) {
  const v = Math.floor(Number(n) || 0)
  p.customSpeed = v <= 0 ? 0 : Math.min(v, maxWalkSpeed(p))
  return { ok: true }
}

/** What the owning client sees. */
export function privateView(p) {
  const { _id, ...rest } = p
  return rest
}

/** What everyone else in the lobby sees. */
export function publicView(p) {
  return {
    name: p.name,
    level: p.level,
    rebirths: p.rebirths,
    chair: p.chair,
    trail: p.trail,
    aura: p.aura,
    pets: p.equippedPets
      .map((uid) => p.pets.find((x) => x.uid === uid)?.type)
      .filter(Boolean),
  }
}

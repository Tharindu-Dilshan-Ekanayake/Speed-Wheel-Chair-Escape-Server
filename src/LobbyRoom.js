import { Room } from 'colyseus'

import { db } from './db.js'
import { resolveIdentity } from './identity.js'
import { getLeaderboards, onLeaderboards } from './leaderboard.js'
import {
  addSpeed,
  buyTreadmill,
  buyX2,
  chairAction,
  claimDaily,
  cosmetic,
  deletePet,
  equipBest,
  equipPet,
  hatch,
  migrate,
  newProfile,
  privateView,
  publicView,
  rebirth,
  setCustomSpeed,
} from './profile.js'
import {
  BONUS_PAD_MIN_REBIRTHS,
  DEV_TOOLS,
  LOBBY,
  LOBBY_SPAWN,
  MAX_LEVEL,
  MAX_PLAYERS_PER_LOBBY,
  REBIRTH_SPEED_BONUS,
  REBIRTH_WIN_BONUS,
  SPEED_PACKS,
  STAGES,
  STAGE_COUNT,
  STEP_DISTANCE,
  TREADMILLS,
  TREADMILL_STEPS_PER_SEC,
  WALK_TO_WORLD,
  newExpedition, expeditionAction, excavationComplete, blockedExcavation, stageAccess, stageStartZ,
  canPush, stageCenterX,
  allStages,
  chairById,
  inPad,
  maxWalkSpeed,
  onTreadmill,
  regionAtZ,
  speedMultiplier,
  stageSpawn,
} from './shared/gameData.js'

const TICK_MS = 100
const GAIN_FLUSH_MS = 300
const SAVE_EVERY_MS = 15_000

/** uid -> { room, client } so a second tab/device takes over the session cleanly. */
const activeSessions = new Map()

const round2 = (v) => Math.round(v * 100) / 100

export class LobbyRoom extends Room {
  maxClients = MAX_PLAYERS_PER_LOBBY

  onCreate() {
    this.autoDispose = true
    /** sessionId -> runtime player */
    this.players = new Map()
    this.stages = allStages()
    this.gainTimer = 0
    this.saveTimer = 0

    this.setSimulationInterval((dt) => this.tick(dt), TICK_MS)
    this.unsubLb = onLeaderboards((lb) => this.broadcast('lb', lb))

    const on = (type, fn) =>
      this.onMessage(type, (client, msg) => {
        const p = this.players.get(client.sessionId)
        if (!p) return
        try {
          fn(p, msg ?? {})
        } catch (err) {
          console.warn(`[room] ${type} failed`, err)
        }
      })

    on('expedition', (p, m) => {
      const error = expeditionAction(p.expedition, p.pos, m.action, m.id)
      if (error) return this.error(p, error)
      p.client.send('expedition', p.expedition)
    })
    on('push', (p, m) => {
      const target = this.players.get(String(m.sid))
      const now = Date.now()
      if (!canPush(p, target, now)) return this.error(p, 'Move within 3m of a player on the course. Push cooldown: 3s.')
      const dx = target.pos.x - p.pos.x, dz = target.pos.z - p.pos.z
      const distance = Math.hypot(dx, dz)
      const x = distance > 0.05 ? dx / distance : Math.sin(p.pos.yaw)
      const z = distance > 0.05 ? dz / distance : Math.cos(p.pos.yaw)
      p.pushReadyAt = now + 3000
      target.pushImmuneUntil = now + 1500
      target.budget += 9
      target.client.send('push', { x: x * 12, z: z * 12, up: 3.5, duration: 0.65 })
      p.client.send('pushReady', { at: p.pushReadyAt })
    })
    on('pos', (p, m) => this.onPos(p, m))
    on('ping', (p, m) => p.client.send('pong', { t: m.t, now: Date.now() }))
    on('respawn', (p) => this.respawn(p))
    on('teleport', (p, m) => this.teleport(p, Number(m.stage) || 0))
    on('gate', (p, m) => this.claimGate(p, Number(m.stage), Number(m.idx)))
    on('claimReturn', (p, m) => this.claimReturn(p, Number(m.stage), Boolean(m.bonus)))

    on('rebirth', (p) => {
      const r = rebirth(p.profile)
      if (!r.ok) return this.error(p, r.error)
      p.client.send('fx', { kind: 'rebirth', rebirths: p.profile.rebirths })
      this.broadcast('fx', { sid: p.sid, kind: 'rebirth' }, { except: p.client })
      this.changed(p, true)
    })
    on('chair', (p, m) => this.result(p, chairAction(p.profile, String(m.id)), true, 'chair'))
    on('treadmill', (p, m) => this.result(p, buyTreadmill(p.profile, String(m.id)), false, 'buy'))
    on('hatch', (p, m) => {
      const r = hatch(p.profile, String(m.id))
      if (!r.ok) return this.error(p, r.error)
      p.client.send('hatch', { egg: String(m.id), pet: r.pet })
      this.changed(p, true)
    })
    on('equipPet', (p, m) => this.result(p, equipPet(p.profile, String(m.uid), Boolean(m.on)), true))
    on('equipBest', (p) => this.result(p, equipBest(p.profile), true))
    on('deletePet', (p, m) => this.result(p, deletePet(p.profile, String(m.uid)), true))
    on('cosmetic', (p, m) => this.result(p, cosmetic(p.profile, String(m.kind), String(m.id)), true, 'buy'))
    on('daily', (p) => {
      const r = claimDaily(p.profile)
      if (!r.ok) return this.error(p, r.error)
      p.client.send('reward', { wins: r.wins, kind: 'daily', streak: r.streak })
      this.changed(p)
    })
    on('x2', (p) => this.result(p, buyX2(p.profile), false, 'buy'))
    on('pack', (p, m) => {
      const pack = SPEED_PACKS.find((x) => x.id === m.id)
      if (!pack) return
      if (p.profile.wins < pack.price) return this.error(p, 'Not enough wins!')
      p.profile.wins -= pack.price
      this.giveSpeed(p, pack.amount, 'pack')
      this.changed(p)
    })
    on('customSpeed', (p, m) => this.result(p, setCustomSpeed(p.profile, m.value), false))
    on('dev', (p, m) => this.dev(p, m))
  }

  async onAuth(_client, options) {
    return resolveIdentity(options)
  }

  async onJoin(client, options, auth) {
    // Same account already playing (another tab / device): take its live profile over.
    let profile = null
    const prev = activeSessions.get(auth.uid)
    if (prev) {
      const prevPlayer = prev.room.players.get(prev.client.sessionId)
      if (prevPlayer) {
        profile = prevPlayer.profile
        prevPlayer.transferred = true
      }
      try {
        prev.client.leave(4001)
      } catch {
        /* already gone */
      }
    }

    if (!profile) {
      const stored = await db.load(auth.uid)
      profile = stored ? migrate(stored, auth.uid, auth.name) : newProfile(auth.uid, auth.name)
    }

    const spawn = { ...LOBBY_SPAWN }
    const p = {
      sid: client.sessionId,
      client,
      uid: auth.uid,
      profile,
      avatar: sanitizeAvatar(options.avatar),
      proportions: sanitizeProportions(options.proportions),
      pos: { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw },
      flags: 0,
      lastPosAt: Date.now(),
      budget: 6,
      distAcc: 0,
      pendingGain: 0,
      pendingSrc: 'step',
      expedition: newExpedition(),
      run: { stage: 0, enteredAt: 0, gates: new Set() },
      dirty: true,
      lastSave: Date.now(),
      transferred: false,
    }
    this.players.set(client.sessionId, p)
    activeSessions.set(auth.uid, { room: this, client })

    client.send('init', {
      expedition: p.expedition,
      sid: client.sessionId,
      roomId: this.roomId,
      now: Date.now(),
      profile: this.privateProfile(p),
      spawn,
      players: [...this.players.values()]
        .filter((o) => o !== p)
        .map((o) => this.publicPlayer(o)),
      lb: getLeaderboards(),
      dev: DEV_TOOLS,
    })
    this.broadcast('join', this.publicPlayer(p), { except: client })
    this.sendFriendBoost()
  }

  async onLeave(client) {
    const p = this.players.get(client.sessionId)
    if (!p) return
    this.players.delete(client.sessionId)
    this.broadcast('leave', { sid: p.sid })
    if (activeSessions.get(p.uid)?.client === client) activeSessions.delete(p.uid)
    if (!p.transferred) await this.save(p)
    this.sendFriendBoost()
  }

  async onBeforeShutdown() {
    await Promise.all([...this.players.values()].map((p) => this.save(p)))
    this.disconnect()
  }

  async onDispose() {
    this.unsubLb?.()
    await Promise.all([...this.players.values()].map((p) => this.save(p)))
  }

  /* ---------------------------------------------------------------- */

  async save(p) {
    if (p.transferred) return
    p.profile.updatedAt = Date.now()
    p.dirty = false
    p.lastSave = Date.now()
    try {
      await db.save(p.profile)
    } catch (err) {
      p.dirty = true
      console.warn('[room] save failed', err.message)
    }
  }

  friends() {
    return Math.max(0, this.players.size - 1)
  }

  sendFriendBoost() {
    this.broadcast('friends', { count: this.friends() })
  }

  privateProfile(p) {
    return { ...privateView(p.profile), maxWalk: maxWalkSpeed(p.profile) }
  }

  publicPlayer(p) {
    return {
      sid: p.sid,
      ...publicView(p.profile),
      avatar: p.avatar,
      proportions: p.proportions,
      pos: p.pos,
    }
  }

  error(p, text) {
    p.client.send('toast', { text, kind: 'error' })
  }

  result(p, r, appearance = false, sfx = null) {
    if (!r.ok) return this.error(p, r.error)
    if (sfx) p.client.send('sfx', { name: sfx })
    this.changed(p, appearance)
  }

  /** Push the new profile to its owner; optionally tell the lobby how they look now. */
  changed(p, appearance = false) {
    p.dirty = true
    p.client.send('profile', this.privateProfile(p))
    if (appearance) {
      this.broadcast('appearance', { sid: p.sid, ...publicView(p.profile) }, { except: p.client })
    }
  }

  giveSpeed(p, amount, src) {
    const lv = addSpeed(p.profile, amount)
    p.client.send('gain', { amount: Math.floor(amount), src })
    if (lv) {
      p.client.send('levelUp', lv)
      this.broadcast('fx', { sid: p.sid, kind: 'levelUp', level: lv.to }, { except: p.client })
      this.changed(p, true)
    } else {
      p.dirty = true
    }
  }

  setPos(p, spawn) {
    p.pos = { x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw ?? Math.PI }
    if (regionAtZ(spawn.z).stage === 0) {
      p.expedition = newExpedition()
      p.client.send('expedition', p.expedition)
    }
    p.budget = 6
    p.lastPosAt = Date.now()
    p.client.send('teleport', p.pos)
  }

  /* ---------------------------------------------------------------- */

  onPos(p, m) {
    if (!Array.isArray(m) || m.length < 5) return
    const [x, y, z, yaw, flags] = m.map(Number)
    if (![x, y, z, yaw].every(Number.isFinite)) return

    const now = Date.now()
    const dt = Math.min(1, (now - p.lastPosAt) / 1000)
    p.lastPosAt = now

    // Movement budget: generous enough for network jitter, tight enough that you
    // can't teleport to a reward pad by sending a fake position.
    const maxSpeed = maxWalkSpeed(p.profile) * WALK_TO_WORLD
    p.budget = Math.min(p.budget + (maxSpeed * 1.5 + 4) * dt, maxSpeed * 3 + 12)
    const dx = x - p.pos.x
    const dz = z - p.pos.z
    const dist = Math.hypot(dx, dz)
    if (dist > p.budget + 2 || y > 60) {
      this.setPos(p, p.pos)
      return
    }
    p.budget -= dist

    const destination = regionAtZ(z)
    const denied = destination.inCourse && p.expedition.devStage !== destination.stage && stageAccess(p.profile, destination.stage)
    if (denied) {
      this.error(p, denied)
      return this.setPos(p, { x: stageCenterX(destination.stage), y: 1.5, z: stageStartZ(destination.stage) + 4, yaw: Math.PI })
    }
    if (blockedExcavation(p.expedition, { x, y, z })) return this.setPos(p, p.pos)
    p.pos = { x, y, z, yaw }
    p.flags = flags | 0

    // Speed for distance travelled on the ground.
    const grounded = (p.flags & 2) !== 0
    if (grounded && dist > 0.01) {
      p.distAcc += dist
      if (p.distAcc >= STEP_DISTANCE) {
        const steps = Math.floor(p.distAcc / STEP_DISTANCE)
        p.distAcc -= steps * STEP_DISTANCE
        const chair = chairById(p.profile.chair)
        p.pendingGain += steps * chair.perStep * speedMultiplier(p.profile, { friends: this.friends() })
        p.pendingSrc = 'step'
      }
    }

    // Stage tracking.
    const region = regionAtZ(z)
    if (region.stage === 0) {
      if (p.run.stage !== 0) p.run = { stage: 0, enteredAt: 0, gates: new Set() }
    } else if (region.inCourse && p.run.stage !== region.stage) {
      p.run = { stage: region.stage, enteredAt: now, gates: new Set(), claimed: false }
      if (region.stage > p.profile.maxStage) {
        p.profile.maxStage = region.stage
        this.changed(p)
      }
    }
  }

  tick(dtMs) {
    const dt = dtMs / 1000
    const friends = this.friends()

    for (const p of this.players.values()) {
      // Treadmills: sit on an owned one and speed flows in.
      if (p.run.stage === 0 && p.pos.y < 4) {
        for (const t of LOBBY.treadmills) {
          if (!onTreadmill(t, p.pos.x, p.pos.z)) continue
          if (!p.profile.treadmills.includes(t.id)) break
          const def = TREADMILLS.find((x) => x.id === t.id)
          const chair = chairById(p.profile.chair)
          p.pendingGain +=
            chair.perStep * TREADMILL_STEPS_PER_SEC * def.mult * speedMultiplier(p.profile, { friends }) * dt
          p.pendingSrc = 'tread'
          break
        }
      }
    }

    this.gainTimer += dtMs
    if (this.gainTimer >= GAIN_FLUSH_MS) {
      this.gainTimer = 0
      for (const p of this.players.values()) {
        if (p.pendingGain >= 1) {
          const amount = Math.floor(p.pendingGain)
          p.pendingGain -= amount
          this.giveSpeed(p, amount, p.pendingSrc)
          // Keep the HUD numbers fresh without spamming full profiles.
          p.client.send('stats', {
            speed: p.profile.speed,
            xp: p.profile.xp,
            level: p.profile.level,
          })
        }
      }
    }

    // Snapshot of everyone's transform.
    if (this.players.size > 1) {
      const snap = []
      for (const p of this.players.values()) {
        snap.push([p.sid, round2(p.pos.x), round2(p.pos.y), round2(p.pos.z), round2(p.pos.yaw), p.flags])
      }
      this.broadcast('snap', snap)
    }

    this.saveTimer += dtMs
    if (this.saveTimer >= 1000) {
      this.saveTimer = 0
      const now = Date.now()
      for (const p of this.players.values()) {
        if (p.dirty && now - p.lastSave > SAVE_EVERY_MS) this.save(p)
      }
    }
  }

  /* ---------------------------------------------------------------- */

  respawn(p) {
    // A death in any adventure sends the player back to the lobby. This keeps
    // failed runs from restarting inside a stage or its safe-room checkpoint.
    p.run = { stage: 0, enteredAt: 0, gates: new Set() }
    this.setPos(p, LOBBY_SPAWN)
  }

  teleport(p, stage) {
    if (stage <= 0) {
      p.run = { stage: 0, enteredAt: 0, gates: new Set() }
      return this.setPos(p, LOBBY_SPAWN)
    }
    if (stage > STAGE_COUNT) return
    if (stage > p.profile.maxStage) return this.error(p, `Reach stage ${stage} first!`)
    const denied = stageAccess(p.profile, stage)
    if (denied) return this.error(p, denied)
    p.expedition.devStage = 0
    p.client.send('expedition', p.expedition)
    const cost = STAGES[stage].tp
    if (p.profile.wins < cost) return this.error(p, 'Not enough wins!')
    p.profile.wins -= cost
    this.changed(p)
    p.client.send('sfx', { name: 'teleport' })
    const rack = this.stages[stage - 1]?.toolRack
    this.setPos(p, rack && !p.expedition.tool ? { x: rack.x, y: 1.5, z: rack.z + 2, yaw: Math.PI } : stageSpawn(stage))
  }

  claimGate(p, stage, idx) {
    if (!excavationComplete(p.expedition, stage) || (p.expedition.devStage !== stage && stageAccess(p.profile, stage))) return
    if (p.run.stage !== stage || p.run.gates.has(idx)) return
    const gate = this.stages[stage]?.gates[idx]
    if (!gate) return
    if (Math.hypot(p.pos.x - gate.x, p.pos.z - gate.z) > (gate.w || 10) / 2 + 5) return
    p.run.gates.add(idx)
    const bonus = 1 + p.profile.rebirths * REBIRTH_SPEED_BONUS
    this.giveSpeed(p, gate.amount * bonus, 'gate')
    this.changed(p)
  }

  claimReturn(p, stage, bonus) {
    if (!excavationComplete(p.expedition, stage)) return this.error(p, 'Complete the stage excavation first.')
    if (p.expedition.devStage !== stage && stageAccess(p.profile, stage)) return this.error(p, 'This stage is locked.')
    const st = this.stages[stage]
    // The server position and safe-room check below are authoritative. Do not make
    // claiming depend on the best-effort run-stage tracker: a player can legitimately
    // reach the safe room while that transient flag is still 0 after a reconnect.
    if (!st || p.run.claimed) return this.error(p, 'This wins pad is not ready yet.')
    const region = regionAtZ(p.pos.z)
    if (region.stage !== stage || !region.inSafe) return this.error(p, 'Move onto the safe-room wins pad.')
    const pad = bonus ? st.bonusPad : st.returnPad
    if (!inPad(pad, p.pos.x, p.pos.z, 1.5)) return this.error(p, 'Stand on the wins pad and press E.')
    if (bonus && p.profile.rebirths < BONUS_PAD_MIN_REBIRTHS) return this.error(p, `Need ${BONUS_PAD_MIN_REBIRTHS} rebirths to unlock this pad!`)
    p.run.claimed = true
    const wins = Math.round(pad.wins * (1 + p.profile.rebirths * REBIRTH_WIN_BONUS))
    p.profile.wins += wins
    p.profile.stagesCleared += 1
    if (stage + 1 <= STAGE_COUNT && stage + 1 > p.profile.maxStage) p.profile.maxStage = stage + 1
    p.client.send('reward', { wins, kind: 'stage', stage, bonus })
    this.changed(p)
    p.run = { stage: 0, enteredAt: 0, gates: new Set() }
    this.setPos(p, LOBBY_SPAWN)
  }

  dev(p, m) {
    if (!DEV_TOOLS) return
    const prof = p.profile
    switch (m.action) {
      case 'tp': {
        const s = Math.max(0, Math.min(STAGE_COUNT, Math.floor(Number(m.stage) || 0)))
        p.expedition = newExpedition(s)
        if (this.stages[s]?.digSites.length) p.expedition.tool = 'pickaxe'
        p.client.send('expedition', p.expedition)
        p.run = { stage: 0, enteredAt: 0, gates: new Set() }
        if (s > prof.maxStage) prof.maxStage = s
        this.setPos(p, s === 0 ? LOBBY_SPAWN : stageSpawn(s))
        break
      }
      case 'wins':
        prof.wins += Math.max(0, Math.min(1e7, Number(m.amount) || 0))
        break
      case 'level':
        this.giveSpeed(p, 1e9, 'pack')
        break
      case 'rebirths':
        prof.rebirths += 1
        prof.totalLevel = prof.rebirths * MAX_LEVEL + prof.level
        break
      case 'reset': {
        const fresh = newProfile(prof._id, prof.name)
        Object.keys(prof).forEach((k) => delete prof[k])
        Object.assign(prof, fresh)
        this.setPos(p, LOBBY_SPAWN)
        break
      }
      default:
        return
    }
    this.changed(p, true)
  }
}

/* ------------------------------------------------------------------ */

const AVATAR_KEYS = ['hatId', 'backId', 'skinId', 'headId', 'armLId', 'armRId', 'legLId', 'legRId', 'torsoId']
function sanitizeAvatar(a) {
  if (!a || typeof a !== 'object') return null
  const out = {}
  for (const k of AVATAR_KEYS) {
    if (a[k] !== undefined && a[k] !== null) out[k] = String(a[k]).slice(0, 40)
  }
  return out
}

const PROPORTION_KEYS = ['height', 'shoulderWidth', 'armLength', 'legOffsetX', 'torsoScaleX', 'neckHeight', 'headScale']
function sanitizeProportions(pr) {
  if (!pr || typeof pr !== 'object') return null
  const out = {}
  for (const k of PROPORTION_KEYS) {
    const v = Number(pr[k])
    if (Number.isFinite(v)) out[k] = Math.max(0.5, Math.min(1.6, v))
  }
  return out
}

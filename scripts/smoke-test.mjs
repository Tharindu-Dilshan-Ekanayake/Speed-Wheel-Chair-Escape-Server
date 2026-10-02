// End-to-end smoke test against a running server (default ws://localhost:2567).
//   npm start            (terminal 1)
//   npm run check        (terminal 2)
import { Client } from 'colyseus.js'

const URL = process.env.SERVER_URL || 'ws://localhost:2567'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function collect(room) {
  const log = {}
  room.onMessage('*', (type, msg) => {
    ;(log[type] ||= []).push(msg)
  })
  return log
}

const fails = []
const check = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) fails.push(label)
}

const client = new Client(URL)
const id = Math.random().toString(36).slice(2, 12)
const a = await client.joinOrCreate('lobby', { deviceId: `smoke-a-${id}`, name: 'SmokeA' })
const la = collect(a)
await wait(400)
check(la.init?.[0]?.profile?.level === 1, 'player A gets init with a fresh profile')

const b = await client.joinOrCreate('lobby', { deviceId: `smoke-b-${id}`, name: 'SmokeB' })
const lb = collect(b)
await wait(400)
check(a.roomId === b.roomId, 'second player lands in the same lobby')
check(la.join?.some((j) => j.name === 'SmokeB'), 'A is told B joined')

// Walk forward on the ground for a while -> speed payouts.
let z = 22
for (let i = 0; i < 20; i += 1) {
  z -= 0.5
  a.send('pos', [0, 1.5, z, Math.PI, 3])
  await wait(100)
}
await wait(500)
check((la.gain || []).some((g) => g.src === 'step' && g.amount > 0), 'walking pays out speed')
check((lb.snap || []).length > 0, 'B receives position snapshots')

// Economy via dev tools.
a.send('dev', { action: 'wins', amount: 1000 })
await wait(200)
a.send('chair', { id: 'blaze' })
a.send('hatch', { id: 'basic' })
a.send('cosmetic', { kind: 'trail', id: 'fire' })
a.send('treadmill', { id: 't3' })
await wait(400)
const prof = la.profile.at(-1)
check(prof.chair === 'blaze', 'bought + equipped Blaze chair')
check(prof.pets.length === 1 && prof.equippedPets.length === 1, 'hatched and auto-equipped a pet')
check(prof.trail === 'fire', 'bought fire trail')
check(prof.treadmills.includes('t3'), 'bought 3x treadmill')
check(prof.wins === 1000 - 15 - 25 - 80 - 50, 'wins were charged correctly')
check(lb.appearance?.some((x) => x.chair === 'blaze'), 'B sees A change chair')

// Rebirth gate.
a.send('rebirth')
await wait(200)
check(la.toast?.some((t) => t.kind === 'error'), 'rebirth refused below max level')
a.send('dev', { action: 'level' })
await wait(200)
a.send('rebirth')
await wait(300)
check(la.profile.at(-1).rebirths === 1 && la.profile.at(-1).level === 1, 'rebirth works at max level')

// Teleporting and anti-cheat.
a.send('dev', { action: 'tp', stage: 3 })
await wait(200)
check(la.teleport?.length > 0, 'dev teleport moves the player')
a.send('pos', [0, 1.5, -2000, 0, 3])
await wait(200)
check(la.teleport.length >= 2, 'impossible jump is corrected by the server')

// Legit run through stage 1 -> return pad pays wins.
const { stageSpawn, stageStartZ, allStages, maxWalkSpeed, WALK_TO_WORLD } = await import('../src/shared/gameData.js')
a.send('dev', { action: 'tp', stage: 1 })
await wait(300)
const st1 = allStages()[1]
const speed = maxWalkSpeed(la.profile.at(-1)) * WALK_TO_WORLD * 0.95
let pz = stageSpawn(1).z
let px = 0
const pad = st1.returnPad
const winsBefore = la.profile.at(-1).wins
while (pz > pad.z) {
  pz = Math.max(pad.z, pz - speed * 0.1)
  if (pz < stageStartZ(1) - 10) px = Math.max(pad.x, px - speed * 0.05)
  a.send('pos', [px, 1.0, pz, Math.PI, 3])
  await wait(100)
}
for (let i = 0; i < 3; i += 1) {
  a.send('pos', [pad.x, 1.0, pad.z, Math.PI, 3])
  await wait(100)
}
a.send('claimReturn', { stage: 1, bonus: false })
await wait(400)
const stageReward = la.reward?.find((r) => r.kind === 'stage')
check(stageReward && stageReward.wins > 0, `stage 1 return pad pays wins (${stageReward?.wins})`)
check(la.profile.at(-1).wins > winsBefore && la.profile.at(-1).maxStage >= 2, 'wins added and stage 2 unlocked')
a.send('claimReturn', { stage: 1, bonus: false })
await wait(200)
check(la.reward.filter((r) => r.kind === 'stage').length === 1, 'cannot claim the same run twice')

a.send('daily')
await wait(200)
check(la.reward?.some((r) => r.kind === 'daily'), 'daily gift claimed')
a.send('daily')
await wait(200)
check(la.toast.filter((t) => t.kind === 'error').length >= 2, 'second daily claim refused')

await a.leave()
await wait(300)
check(lb.leave?.length === 1, 'B is told A left')
await b.leave()

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED')
process.exit(fails.length ? 1 : 0)

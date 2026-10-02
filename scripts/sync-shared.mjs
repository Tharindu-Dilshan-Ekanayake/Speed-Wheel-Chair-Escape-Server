// Copies the canonical shared game data from the client repo into this repo.
// Run after editing Speed-Wheel-Chair-Escape-Client/src/shared/gameData.js.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.resolve(here, '../../Speed-Wheel-Chair-Escape-Client/src/shared/gameData.js')
const dst = path.resolve(here, '../src/shared/gameData.js')
fs.copyFileSync(src, dst)
console.log(`synced ${src} -> ${dst}`)

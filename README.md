# +1 Speed Wheel Chair Escape — game server

Colyseus 0.16 server for the Bloxity Legion platform. One `lobby` room = up to 8 players;
the 9th player automatically gets a new lobby. Leaderboards are global (shared Mongo).

## Run locally

```bash
npm install
npm start            # ws://localhost:2567 (no Mongo needed: uses ./data/dev-db.json)
npm run check        # end-to-end smoke test against the running server
```

## Layout

| File | What it does |
| --- | --- |
| `src/index.js` | HTTP + WebSocket server, `/health`, CORS, graceful shutdown |
| `src/LobbyRoom.js` | Room: movement relay, speed payouts, treadmills, gates, stage rewards, shop messages, dev tool |
| `src/profile.js` | All economy rules (levels, rebirths, chairs, pets, eggs, trails, auras, daily gift) |
| `src/db.js` | Mongo (`MONGODB_URI`) or local JSON fallback |
| `src/identity.js` | Verifies Bloxity login tokens; guests use a device id |
| `src/shared/gameData.js` | **Copy** of the client's shared data — edit the client one, then `npm run sync-shared` |

## Deploy (GitHub Actions → Legion)

`.github/workflows/deploy.yml` builds the Docker image, pushes it to GHCR and calls the
Legion deploy API. `dev` branch → dev channel, `main` → prod.

1. Add repo secret **`LEGION_DEPLOY_TOKEN`** (Settings → Secrets and variables → Actions).
2. Push to `dev`.
3. After the first push: repo → Packages → `speed-wheel-chair-escape-server` → Package
   settings → Change visibility → **Public** (Legion has to be able to pull it).

`seatCap` is 8 (= `maxClients`), `maxReplicas` 10.

## Before launch

Set `DEV_TOOLS = false` in `src/shared/gameData.js` (client + server) to remove the
stage-jumper / free-wins dev tool.

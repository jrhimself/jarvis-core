# Jarvis FUI desk prototype (`/v2`)

Parallel visual prototype of the desk HUD: cyan digital-brain orb, floating glass
panels, dark navy perspective floor grid. Served alongside the production HUD.

## URLs

| Path | What you get |
| --- | --- |
| `/` | Production default HUD (unchanged by this work) |
| `/v2/` | This FUI prototype (`index.html` under `hud/public/v2/`) |

Prefer the trailing slash (`/v2/`). Asset links are absolute (`/v2/styles.css`,
`/v2/app.js`) so `/v2` without a slash still loads styles and script.

### Query params

| Param | Effect |
| --- | --- |
| (default) | Freeze-friendly still frame at `t=4.2` (good for screenshots) |
| `?t=6.0` | Freeze at a different animation time |
| `?live=1` | Idle breathing animation + live clock |

## Files

- `index.html` — layout + Dutch mock desk content
- `styles.css` — glass panels, perspective grid, chrome
- `app.js` — Canvas 2D orb (neural connectome + horizontal ripples)

## Data

**Mock data only.** Panels (weather, agenda, mail, PRs, system) are fictional NL
copy. No live WebSocket `/ws` wire-up yet — that is a follow-up. No household PII.

## Rollback

Additive only: the default HUD at `/` is untouched. To remove this prototype from
a deployment:

1. Redeploy the previous ref (`jarvis-deploy <previous-sha-or-tag>`), or
2. Delete `hud/public/v2/` and redeploy.

Nothing under `/v2` is required for the production HUD to keep working.
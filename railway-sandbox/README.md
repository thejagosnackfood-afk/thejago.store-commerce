# railway-sandbox

A [Railway sandbox](https://railway.com) quickstart — ephemeral compute via the `railway` SDK.

## Getting started

```bash
npm install
cp .env.example .env   # then fill in RAILWAY_API_TOKEN + RAILWAY_ENVIRONMENT_ID
npm start
```

`npm start` runs `index.ts`: it creates a sandbox, runs a command in it, and tears it down
automatically.

## Credentials

| Variable                 | Where to get it                                       |
| ------------------------ | ----------------------------------------------------- |
| `RAILWAY_API_TOKEN`      | https://railway.com/account/tokens                    |
| `RAILWAY_ENVIRONMENT_ID` | Railway project → Settings → copy the environment ID  |

## Learn more

- SDK docs: https://github.com/railwayapp/railway-ts-sdk#readme
- `AGENTS.md` has an API cheat sheet (also symlinked as `CLAUDE.md` for coding agents).

# whatsapp-rig — Cloudflare Worker

A thin HTTPS shim that mounts the `b3nd-send/whatsapp` client and
exposes its `receive` surface. Built to satisfy the "node up to dream
against" goal of the [whatsapp network deployment umbrella][umbrella] —
later iterations will layer the move-side webhook ingress and storage
on top.

[umbrella]: https://github.com/bandeira-tech/b3nd-send/pull/5

## Routes

| Method | Path                       | Behaviour                                                                                                  |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET`  | `/healthz`                 | Returns `sink.status()` — the mount manifest (basePath, schema patterns).                                  |
| `GET`  | `/smoke[?to=+E164]`        | Sends the `hello_world` template to `to` (or `WA_TO_DEFAULT`). Returns the `ReceiveResult` as JSON.        |
| `GET`  | `/whatsapp`                | Meta webhook GET handshake — verifies `hub.verify_token` and echoes back `hub.challenge`.                  |
| `POST` | `/whatsapp`                | Meta webhook POST — HMAC-verifies the signature, decodes the payload, dispatches inbound tuples.           |
| `*`    | other                      | 404 with a small route listing.                                                                            |

## Bindings

Set via wrangler vars (non-sensitive) and wrangler secrets (sensitive).

| Name                  | Kind   | Required | Notes                                                                       |
| --------------------- | ------ | -------- | --------------------------------------------------------------------------- |
| `WA_PHONE_NUMBER_ID`  | var    | yes      | Meta phone-number-id used as the API path segment.                          |
| `WA_TO_DEFAULT`       | var    | no       | Default recipient for `/smoke` when no `?to=` is given.                     |
| `WA_ACCESS_TOKEN`     | secret | yes      | Graph API token. 24h temporary tokens work; rotate via `secret put`.        |
| `WA_APP_SECRET`       | secret | yes*     | Required for `POST /whatsapp` — HMAC signature verification.                |
| `WA_VERIFY_TOKEN`     | secret | yes*     | Required for `GET /whatsapp` — Meta webhook handshake.                      |

\* Required if you use the `/whatsapp` webhook routes. Without them, GET/POST `/whatsapp` return 500.

## Deploy

From the worktree root:

```sh
# Run from a shell where CLOUDFLARE_API_TOKEN is unset, so wrangler
# falls back to its OAuth session. The user's tested workflow:
unset CLOUDFLARE_API_TOKEN

# First deploy — pass vars on the CLI so they don't live in the toml.
npx wrangler deploy \
  --config worker/wrangler.toml \
  --var "WA_PHONE_NUMBER_ID:<phone-number-id>" \
  --var "WA_TO_DEFAULT:+<E164>"

# Then add the secrets. wrangler prompts interactively; pipe to automate.
echo "<fresh-access-token>" | \
  npx wrangler secret put WA_ACCESS_TOKEN --config worker/wrangler.toml

# Add webhook secrets (required for GET/POST /whatsapp):
echo "<app-secret>" | \
  npx wrangler secret put WA_APP_SECRET --config worker/wrangler.toml
echo "<verify-token>" | \
  npx wrangler secret put WA_VERIFY_TOKEN --config worker/wrangler.toml

# Verify:
curl https://whatsapp-rig.<account>.workers.dev/healthz
curl https://whatsapp-rig.<account>.workers.dev/smoke
```

If `wrangler` errors with `Failed to automatically retrieve account
IDs`, that usually means `CLOUDFLARE_API_TOKEN` is set in the
environment but lacks `account:read`. Unset it and let the OAuth
session take over.

## Local dev

```sh
unset CLOUDFLARE_API_TOKEN
# Stash WA_ACCESS_TOKEN in worker/.dev.vars (gitignored):
echo "WA_ACCESS_TOKEN=<token>" > worker/.dev.vars
npx wrangler dev --config worker/wrangler.toml
```

## Why a separate `package.json` at the worktree root?

The sink itself ships as a Deno/JSR project (see `deno.json`). The
Worker needs `wrangler` and an npm-resolvable `@bandeira-tech/b3nd-core`
— so the root carries a *sidecar* `package.json` whose only job is to
make the npm bundler happy. The Deno toolchain ignores it; npm
toolchains ignore `deno.json`. The library tests still run under Deno.

When the sink is published to JSR and consumers can `jsr add` it
directly, this sidecar will probably move into `worker/` proper. Until
then, keeping it at the root means the relative import `../src/whatsapp/mod.ts`
inside the Worker resolves `@bandeira-tech/b3nd-core` through the same
`node_modules/` the bundler walks up to.

## What's deferred

- **A real rig.** This Worker builds the sink per-request and calls
  `receive` directly. No rig, no observers, no storage. Add when M3's
  move-side webhook transport lands and we have inbound traffic worth
  routing.
- **Per-tenant basePath routing.** The Worker uses the sink's default
  `whatsapp://`. Multi-tenant deploys would wire per-tenant
  `WhatsAppSink` instances under different basePaths from a single
  rig — supported by the sink, not exercised here.
- **CI/CD.** The `wrangler deploy` step is run by hand. A
  `.github/workflows/deploy.yml` is the natural next iteration once
  more than one developer touches the Worker.

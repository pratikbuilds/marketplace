# Local Docker Stack Skill

Use this guide when onboarding an engineer or agent to run the Marketplace
Docker Compose stack locally.

## Purpose

This stack runs a production-like local Marketplace environment:

- Postgres
- control-plane API
- discovery API
- control-plane UI
- two local OpenResty API nodes
- marketplace sidecar wrapper
- real Faremeter sidecar package
- real Faremeter facilitator app
- local publisher mock

## Required Setup

Initialize submodules before using the local Make targets:

```bash
git submodule update --init --recursive
```

Create or provide the local payment keypair:

```bash
mkdir -p keypairs
solana-keygen new --outfile keypairs/facilitator.json
```

`LOCAL_SERVICE_SOLANA_ADDRESS` is optional. If unset, the seed script derives
the receiver wallet address from `keypairs/facilitator.json`.

## Required Repository Paths

The Compose file mounts this checkout directly as `/workspace/marketplace`, so
the local marketplace directory can have any name. It also mounts the Faremeter
checkout as `/workspace/faremeter`.

By default, Compose looks for Faremeter one directory above this checkout:

```text
${PWD}/../faremeter
```

If a user's machine keeps the Faremeter repo somewhere else, pass an explicit
host path:

```bash
FAREMETER_REPO_PATH=/absolute/path/to/faremeter make local-up
FAREMETER_REPO_PATH=/absolute/path/to/faremeter make local-check
```

Use a real checkout path for `FAREMETER_REPO_PATH`; Docker Desktop on macOS may
not resolve symlinks that point outside a bind mount.

From this repo, verify:

```bash
pwd
test -f package.json
test -d "${FAREMETER_REPO_PATH:-../faremeter}/apps/facilitator"
test -d "${FAREMETER_REPO_PATH:-../faremeter}/apps/sidecar"
git -C "${FAREMETER_REPO_PATH:-../faremeter}" remote -v
```

The expected upstream for the sibling repo is:

```text
https://github.com/faremeter/faremeter.git
```

## What Runs From Where

The facilitator service runs the real app from the Faremeter checkout selected
by `FAREMETER_REPO_PATH` or `../faremeter`:

```text
${FAREMETER_REPO_PATH:-../faremeter}/apps/facilitator
```

Inside Compose, it runs at:

```text
http://facilitator:4021
```

The sidecar service entrypoint is the Marketplace wrapper:

```text
apps/api-node-stack/sidecar/src/main.ts
```

That wrapper imports the reusable sidecar implementation from the Faremeter
checkout through `@faremeter/sidecar`.

```text
${FAREMETER_REPO_PATH:-../faremeter}/apps/sidecar
```

Inside Compose, OpenResty talks to the sidecar at:

```text
http://api-node-sidecar:4002
```

The local check does not submit paid Solana transactions. It verifies that paid
routes return `402` with USDC requirements for the selected Solana network,
then exercises free proxy routing through both local API nodes.

## Solana Network Selection

The stack supports both Solana devnet and mainnet-beta. Docker Compose
explicitly defaults local services to devnet when `SOLANA_NETWORK` is unset:

```bash
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
```

Run the stack against mainnet-beta by setting both the network and RPC URL:

```bash
SOLANA_NETWORK=mainnet-beta \
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
make local-up
```

Use `mainnet-beta`, not `mainnet`, because that is the cluster name accepted by
the Faremeter Solana packages. The local seed script and local check use the
selected network to look up the correct USDC mint and x402 network IDs.

Mainnet-beta mode is useful for local smoke testing against mainnet token
metadata and payment requirements. Do not treat this Compose stack as a
production settlement environment without reviewing the Faremeter facilitator
timing configuration.

## Run The Stack

From this checkout:

```bash
make local-up
```

Equivalent raw Compose command:

```bash
docker compose up --build -d
```

The first run installs dependencies in the mounted Marketplace and Faremeter
workspaces, builds the Faremeter workspace, migrates the control-plane
database, and starts the services. The facilitator, control-plane, seed script,
and local check all use the selected Solana network.

`make local-up` also seeds local data through the `seed-local-dev` service.

Use `make local-seed` only when reseeding an already-running stack during
debugging.

## Run Local Checks

Run the local stack checks:

```bash
make local-check
```

The local check:

- waits for control-plane, discovery, UI, and both API nodes
- logs in as the local admin
- finds the seeded demo tenant
- creates a new free endpoint through the control plane
- verifies unpaid requests return `402` with USDC payment requirements for the
  selected Solana network
- routes the free endpoint through both API nodes
- verifies control-plane transaction and analytics records

Local admin credentials:

```text
admin@local.faremeter.test
localdev123
```

## Useful URLs

```text
Control plane API: http://localhost:11337
Control plane UI:  http://localhost:11338
Discovery API:     http://localhost:11339
API node A:        http://localhost:18080
API node B:        http://localhost:18081
```

Seeded demo proxy URLs:

```text
http://demo-api.local.proxy.localhost:18080/v1/chat/completions
http://demo-api.local.proxy.localhost:18081/v1/chat/completions
```

## Logs And Lifecycle

Follow logs:

```bash
make local-logs
```

Show service status:

```bash
make local-ps
```

Rebuild and recreate services:

```bash
make local-restart
```

Stop and remove local volumes:

```bash
make local-down
```

Reinstall workspace dependencies in the Docker volumes:

```bash
make local-reinstall
```

## Port Overrides

If default ports collide with another local stack:

```bash
MARKETPLACE_CONTROL_PLANE_PORT=1337 \
MARKETPLACE_UI_PORT=1338 \
MARKETPLACE_DISCOVERY_PORT=1339 \
MARKETPLACE_PROXY_PORT=8080 \
MARKETPLACE_PROXY_PORT_B=8081 \
MARKETPLACE_POSTGRES_PORT=5433 \
docker compose up --build -d
```

Proxy port overrides affect browser-facing URLs and the advertised proxy
resource URLs. The local check runs inside Compose and reaches API nodes by
service name while sending the seeded proxy host in the `Host` header.

## Troubleshooting

If `workspace-init` fails with a missing Faremeter checkout error, clone or
place the `faremeter` repo at `../faremeter`, or set `FAREMETER_REPO_PATH` to
the checkout path.

If the UI build does not pick up changed public env vars, recreate the UI
service:

```bash
docker compose up --build --force-recreate control-plane-ui
```

If API nodes do not pick up tenant config, reseed and inspect node logs:

```bash
make local-seed
docker compose logs api-node-a api-node-b api-node-sidecar
```

## Agent Checklist

Before declaring the local Docker stack ready:

1. Verify the `infra-toolbox` submodule is initialized.
2. Verify the Faremeter checkout exists at `../faremeter` or
   `FAREMETER_REPO_PATH`.
3. Verify `keypairs/facilitator.json` exists or
   `LOCAL_SERVICE_SOLANA_ADDRESS` is set.
4. Run `make local-up`.
5. Run `make local-check`.
6. If either command fails, report the failing command and relevant service logs.

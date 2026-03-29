# Canton MPC PoC

MPC-based ERC-20 custody on Canton. Daml smart contracts manage vault state (deposits, withdrawals, holdings) while a TypeScript MPC service signs EVM transactions using threshold-derived keys via [signet.js](https://github.com/aspect-build/signet.js).

## Prerequisites

| Tool           | Version | Install                                                           |
| -------------- | ------- | ----------------------------------------------------------------- |
| Java           | 21+     | [Temurin](https://adoptium.net/)                                  |
| Daml SDK (DPM) | 3.4.11  | `curl -sSL https://get.digitalasset.com/install/install.sh \| sh` |
| Node.js        | 24+     | [nodejs.org](https://nodejs.org/)                                 |
| pnpm           | 10+     | `corepack enable && corepack prepare pnpm@latest --activate`      |

After installing DPM, make sure `~/.dpm/bin` is on your `PATH`.

## Configuration

The MPC service reads `CANTON_JSON_API_URL` from `test/.env` and passes it to the `CantonClient` constructor. Defaults to `http://localhost:7575` if unset. Tests always use the default.

```bash
# In test/.env — point to a remote or non-default sandbox
CANTON_JSON_API_URL=http://my-canton-node:7575
```

See `test/.env.example` for all available variables.

## Quick Start

### 1. Build the DAR and generate codegen

```bash
dpm build --all
cd test
pnpm run codegen:daml
pnpm install
```

### 2. Start the Canton sandbox

In a separate terminal (keep it running):

```bash
cd test
pnpm daml:sandbox
```

Wait until you see the JSON API listening on port 7575. You can verify with:

```bash
curl -sf http://localhost:7575/docs/openapi > /dev/null && echo "Ready"
```

### 3. Run tests

```bash
cd test
pnpm test          # single run (unit + integration)
```

### One-liner rebuild

If you change Daml sources and need a full clean rebuild (requires sandbox running for OpenAPI codegen):

```bash
cd test && pnpm generate
```

This runs `clean -> daml:build -> codegen:daml -> codegen:api -> install`.

## Daml Unit Tests

These don't need the sandbox:

```bash
dpm build --all
dpm test --all
```

## Sepolia E2E Tests

End-to-end tests that exercise the full deposit/withdrawal lifecycle against a live Sepolia RPC and the Canton sandbox.

### Setup

```bash
cd test
cp .env.example .env
```

Fill in the required values:

| Variable               | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `CANTON_JSON_API_URL`  | (optional) Canton JSON API base URL (default `http://localhost:7575`) |
| `SEPOLIA_RPC_URL`      | Sepolia JSON-RPC endpoint (Infura, Alchemy, etc.)                     |
| `MPC_ROOT_PRIVATE_KEY` | `0x`-prefixed secp256k1 private key (64 hex chars)                    |
| `MPC_ROOT_PUBLIC_KEY`  | Uncompressed SEC1 public key (`04` + x + y, no `0x` prefix)           |
| `VAULT_ID`             | Vault discriminator for MPC key derivation                            |
| `FAUCET_PRIVATE_KEY`   | (optional) Defaults to `MPC_ROOT_PRIVATE_KEY`                         |
| `ERC20_ADDRESS`        | (optional) Defaults to test USDC on Sepolia                           |

### Fund the faucet

```bash
pnpm sepolia:preflight    # prints faucet address + current balances
```

Send to the faucet address:

- ~0.002 ETH for gas per test run
- ERC-20 tokens for the deposit amount

### Run

```bash
# Start sandbox in a separate terminal first, then:
pnpm test          # runs all tests including Sepolia e2e when env is set
```

## Design

- [Deposit flow](proposals/E2E_DEPOSIT_PLAN_COMPACT.md) — end-to-end deposit lifecycle: auth cards, MPC signing, Sepolia submission, and Canton claim
- [Withdrawal flow](proposals/E2E_WITHDRAWAL_PLAN_COMPACT.md) — end-to-end withdrawal lifecycle: holding burn, MPC signing, Sepolia submission, and refund-on-failure

## Available Scripts

From `test/`:

| Script                   | Description                                                   |
| ------------------------ | ------------------------------------------------------------- |
| `pnpm test`              | Run all tests (unit + integration, Sepolia e2e if env is set) |
| `pnpm daml:build`        | Build the DAR                                                 |
| `pnpm daml:test`         | Run Daml Script tests                                         |
| `pnpm daml:sandbox`      | Start Canton sandbox with JSON API on :7575                   |
| `pnpm codegen:daml`      | Regenerate Daml JS codegen from built DAR                     |
| `pnpm codegen:api`       | Regenerate OpenAPI types (requires running sandbox)           |
| `pnpm generate`          | Full clean rebuild: DAR + codegen + install                   |
| `pnpm sepolia:preflight` | Check faucet balances and print deposit addresses             |

From root:

| Script       | Description                            |
| ------------ | -------------------------------------- |
| `pnpm check` | Typecheck + lint + knip + format check |
| `pnpm fix`   | Auto-fix lint + format                 |

# canton-mpc

MPC-based ERC-20 custody service for [Canton](https://docs.digitalasset.com/). Watches for `PendingEvmTx` contracts on the Canton ledger, signs EVM transactions using threshold-derived keys via [signet.js](https://github.com/sig-net/signet.js), submits them to Sepolia, and reports outcomes back to Canton.

## Prerequisites

| Tool           | Version                                             |
| -------------- | --------------------------------------------------- |
| Java           | 17+                                                 |
| Canton sandbox | Via [Daml SDK (DPM)](https://get.digitalasset.com/) |
| Node.js        | 20+                                                 |

## Install

```bash
npm install canton-mpc viem
```

## Quick Start

```typescript
import { MpcServer, CantonClient, VaultOrchestrator, DAR_PATH, toSpkiPublicKey } from "canton-mpc";

// 1. Connect to Canton and upload the bundled DAR
const canton = new CantonClient("http://localhost:7575");
await canton.uploadDar(DAR_PATH);

// 2. Set up parties and user
const issuer = await canton.allocateParty("Issuer");
const mpc = await canton.allocateParty("Mpc");
await canton.createUser("mpc-service", issuer, [mpc]);

// 3. Create (or find) the VaultOrchestrator contract
const orchResult = await canton.createContract(
  "mpc-service",
  [issuer],
  VaultOrchestrator.templateId,
  {
    issuer,
    mpc,
    mpcPublicKey: toSpkiPublicKey(MPC_ROOT_PUBLIC_KEY),
    vaultAddress: "...", // padded vault address
    vaultId: "my-vault",
  },
);
const orchCid = orchResult.transaction.events.find((e) => "CreatedEvent" in e)!.CreatedEvent
  .contractId;

// 4. Start the MPC service
const server = new MpcServer({
  canton,
  orchCid,
  userId: "mpc-service",
  parties: [issuer],
  rootPrivateKey: "0x...", // secp256k1 private key
  rpcUrl: "https://sepolia.infura.io/v3/...",
});

await server.start();
await server.waitUntilReady();
// Server is now watching for PendingEvmTx contracts

// Graceful shutdown
process.on("SIGTERM", () => server.shutdown());
```

## How It Works

1. **Watch** — `MpcServer` opens a WebSocket stream to the Canton ledger, listening for `PendingEvmTx` contracts
2. **Sign** — When a pending tx is detected, it derives a child key from the MPC root key, signs the EVM transaction, and exercises `SignEvmTx` on Canton
3. **Monitor** — Polls the Sepolia RPC for the transaction receipt
4. **Report** — Once confirmed (or failed), signs the MPC response and exercises `ProvideEvmOutcomeSig` on Canton

## API

### `MpcServer`

The main service class. Watches for pending transactions, signs them, and reports outcomes.

```typescript
new MpcServer(config: MpcServerConfig)
```

| Config field     | Type           | Description                            |
| ---------------- | -------------- | -------------------------------------- |
| `canton`         | `CantonClient` | Connected Canton client instance       |
| `orchCid`        | `string`       | Contract ID of the `VaultOrchestrator` |
| `userId`         | `string`       | Canton user ID for ledger commands     |
| `parties`        | `string[]`     | Parties to act as                      |
| `rootPrivateKey` | `Hex`          | `0x`-prefixed secp256k1 private key    |
| `rpcUrl`         | `string`       | Sepolia JSON-RPC endpoint              |

**Methods:**

- `start()` — Begin watching for `PendingEvmTx` events
- `waitUntilReady(timeoutMs?)` — Wait until the stream is connected (default 5s)
- `shutdown()` — Stop watching and clean up

### `CantonClient`

Type-safe wrapper around the Canton JSON Ledger API v2.

```typescript
new CantonClient(baseUrl?: string) // defaults to http://localhost:7575
```

**Methods:**

- `uploadDar(filePath)` — Upload a DAR file to the participant
- `allocateParty(hint)` — Allocate a new party
- `createUser(userId, primaryParty, additionalParties?)` — Create a ledger user
- `createContract(userId, actAs, templateId, payload, ...)` — Create a contract
- `exerciseChoice(userId, actAs, templateId, contractId, choice, args, ...)` — Exercise a choice
- `getActiveContracts(parties, templateId)` — Query active contracts
- `getLedgerEnd()` — Get current ledger offset

### `DAR_PATH`

Absolute path to the bundled `canton-mpc-poc-0.0.1.dar`. Pass to `canton.uploadDar()`.

### Utilities

| Export                                                   | Description                                      |
| -------------------------------------------------------- | ------------------------------------------------ |
| `deriveDepositAddress(pubKey, predecessorId, path)`      | Derive an EVM deposit address from MPC root key  |
| `computeRequestId(...)`                                  | Compute the EIP-712 request ID for a transaction |
| `toSpkiPublicKey(uncompressedKey)`                       | Convert uncompressed public key to SPKI format   |
| `deriveChildPrivateKey(rootKey, predecessorId, path)`    | Derive a child signing key                       |
| `reconstructSignedTx(evmParams, sig)`                    | Reconstruct a signed EVM transaction             |
| `submitRawTransaction(rpcUrl, raw)`                      | Submit a raw transaction to an EVM RPC           |
| `findCreated(events, templateFragment)`                  | Find a created event by template name            |
| `VaultOrchestrator`, `PendingEvmTx`, `Erc20Holding`, ... | Daml template types                              |

## Limitations

- **Sepolia only** — EVM chain is hardcoded to Sepolia (chain ID 11155111)
- **Single instance** — `MpcServer` is stateful; don't run multiple instances against the same Canton party

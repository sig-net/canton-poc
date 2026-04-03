# canton-sig

Sig Network MPC service for [Canton](https://docs.digitalasset.com/). Watches for `PendingEvmTx` contracts on the Canton ledger, derives child keys and signs EVM transactions using [signet.js](https://github.com/sig-net/signet.js), records signatures on Canton, and monitors EVM receipts to report outcomes back to the ledger.

## Prerequisites

| Tool           | Version                                             |
| -------------- | --------------------------------------------------- |
| Java           | 21+                                                 |
| Canton sandbox | Via [Daml SDK (DPM)](https://get.digitalasset.com/) |
| Node.js        | 20+                                                 |

## Install

```bash
npm install canton-sig viem
```

## Quick Start

```typescript
import {
  MpcServer,
  CantonClient,
  VaultOrchestrator,
  DAR_PATH,
  toSpkiPublicKey,
  deriveDepositAddress,
  findCreated,
} from "canton-sig";

// 1. Connect to Canton and upload the bundled DAR
const canton = new CantonClient("http://localhost:7575");
await canton.uploadDar(DAR_PATH);

// 2. Set up parties and user
const issuer = await canton.allocateParty("Issuer");
const requester = await canton.allocateParty("Requester");
const mpc = await canton.allocateParty("Mpc");
await canton.createUser("mpc-service", issuer, [requester, mpc]);

// 3. Derive the vault address from the MPC root public key
const VAULT_ID = "my-vault";
const MPC_ROOT_PUBLIC_KEY = "04..."; // uncompressed secp256k1 public key (no 0x)
const vaultAddress = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, `${VAULT_ID}${issuer}`, "root");
const vaultAddressPadded = vaultAddress.slice(2).padStart(64, "0");

// 4. Create the VaultOrchestrator contract
const orchResult = await canton.createContract(
  "mpc-service",
  [issuer],
  VaultOrchestrator.templateId,
  {
    issuer,
    mpc,
    mpcPublicKey: toSpkiPublicKey(MPC_ROOT_PUBLIC_KEY),
    vaultAddress: vaultAddressPadded,
    vaultId: VAULT_ID,
  },
);
const orchCid = findCreated(orchResult.transaction.events, "VaultOrchestrator").contractId;

// 5. Start the MPC service
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

1. **Watch** — `MpcServer` opens a WebSocket stream to the Canton ledger, listening for `PendingEvmTx` contracts. If the WebSocket connection is lost, it reconnects with exponential backoff; if reconnection is exhausted, it falls back to HTTP polling automatically.
2. **Sign** — Derives a child key from the MPC root key, signs the EVM transaction hash, and exercises `SignEvmTx` on Canton (recording the ECDSA signature on-ledger)
3. **Monitor** — Polls the EVM RPC for the transaction receipt with adaptive backoff (the signed transaction must be broadcast externally). Also detects nonce consumption to handle replaced or front-run transactions.
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
| `rpcUrl`         | `string`       | EVM JSON-RPC endpoint                  |

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

- `uploadDar(darPath)` — Upload a DAR file to the participant
- `allocateParty(hint)` — Allocate a new party
- `createUser(userId, primaryParty, additionalParties?)` — Create a ledger user with `CanActAs` + `CanReadAs` rights for each party
- `createUserWithRights(userId, primaryParty, rights)` — Create a user with explicit `UserRight[]`
- `listUserRights(userId)` — List all rights granted to a user
- `createContract(userId, actAs, templateId, payload)` — Create a contract
- `exerciseChoice(userId, actAs, templateId, contractId, choice, choiceArgument, readAs?, disclosedContracts?)` — Exercise a choice
- `getActiveContracts(parties, templateId, includeCreatedEventBlob?)` — Query active contracts
- `getDisclosedContract(parties, templateId, contractId)` — Get a disclosed contract (needed for cross-party choice exercises)
- `getLedgerEnd()` — Get current ledger offset
- `getUpdates(beginExclusive, parties, idleTimeoutMs?)` — Fetch ledger updates since a given offset

### `DAR_PATH`

Absolute path to the bundled `daml-vault-0.0.1.dar`. Pass to `canton.uploadDar()`.

### Utilities

| Export                                                                                    | Description                                                 |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `deriveDepositAddress(rootPubKey, predecessorId, path, keyVersion?)`                      | Derive an EVM deposit address from MPC root key             |
| `computeRequestId(sender, evmParams, caip2Id, keyVersion, path, algo, dest, authCidText)` | Compute the EIP-712 request ID for a transaction            |
| `computeResponseHash(requestId, mpcOutput)`                                               | Compute the EIP-712 response hash for an MPC outcome        |
| `toSpkiPublicKey(uncompressedPubKey)`                                                     | Convert uncompressed public key to SPKI format              |
| `derivePublicKey(privateKey)`                                                             | Derive the uncompressed public key from a private key       |
| `deriveChildPrivateKey(rootPrivateKey, predecessorId, path)`                              | Derive a child signing key                                  |
| `signEvmTxHash(privateKey, txHash)`                                                       | Sign an EVM transaction hash (ECDSA, returns `{ r, s, v }`) |
| `signMpcResponse(rootPrivateKey, requestId, mpcOutput)`                                   | Sign an MPC response hash (compact 64-byte signature)       |
| `reconstructSignedTx(evmParams, signature)`                                               | Reconstruct a signed EVM transaction                        |
| `submitRawTransaction(rpcUrl, raw)`                                                       | Submit a raw transaction to an EVM RPC                      |
| `buildCalldata(functionSignature, args)`                                                   | Build EVM calldata from function signature and hex args     |
| `buildTxRequest(evmParams)`                                                               | Build a viem transaction request from Canton EVM params     |
| `serializeUnsignedTx(evmParams)`                                                          | Serialize an unsigned EVM transaction                       |
| `findCreated(events, templateFragment)`                                                   | Find a created event by template name                       |
| `firstCreated(events)`                                                                    | Get the first created event from a list                     |
| `getCreatedEvent(event)`                                                                  | Extract the `CreatedEvent` from an event envelope           |
| `createLedgerStream(options)`                                                             | Create a WebSocket ledger update stream with auto-reconnect |
| `canActAsRight(party)`                                                                    | Build a `CanActAs` user right payload                       |
| `canReadAsRight(party)`                                                                   | Build a `CanReadAs` user right payload                      |
| `chainIdHexToCaip2(chainIdHex)`                                                           | Convert a hex chain ID to a CAIP-2 identifier               |
| `KEY_VERSION`                                                                             | Default key derivation version constant (`1`)               |
| `eip712Types`                                                                             | EIP-712 type definitions used for request signing           |
| `eip712Domain`                                                                            | EIP-712 domain used for request signing                     |

### Daml Templates

Re-exported from the bundled DAR for consumer convenience:

`VaultOrchestrator`, `PendingEvmTx`, `EcdsaSignature`, `EvmTxOutcomeSignature`, `Erc20Holding`, `DepositAuthorization`, `DepositAuthProposal`

### Types

`MpcServerConfig`, `CreatedEvent`, `Event`, `UserRight`, `DisclosedContract`, `TransactionResponse`, `JsGetUpdatesResponse`, `StreamHandle`, `EvmTransactionParams`, `CantonEvmParams`

## Limitations

- **Sepolia RPC defaults** — The viem `PublicClient` used for transaction submission and receipt monitoring is hardcoded to Sepolia. Transaction payloads use the chain ID from the Canton contract's EVM params.
- **Single instance** — `MpcServer` is stateful; don't run multiple instances against the same Canton party

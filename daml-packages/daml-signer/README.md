# daml-signer

Generic MPC signing infrastructure for Canton. Chain-agnostic, vault-agnostic, and reusable across multiple vault implementations. The Signer layer defines the primitives that let a trusted MPC service (the `sigNetwork` party) produce signatures for transactions on any downstream chain (currently EVM; extensible to BTC, Solana, etc.).

The Vault layer — e.g. [`daml-vault`](../daml-vault/README.md) — is the domain-specific consumer that creates signing requests and interprets outcomes. The end-to-end ERC-20 flows are documented in [`proposals/E2E_DEPOSIT_PLAN_COMPACT.md`](../../proposals/E2E_DEPOSIT_PLAN_COMPACT.md) and [`proposals/E2E_WITHDRAWAL_PLAN_COMPACT.md`](../../proposals/E2E_WITHDRAWAL_PLAN_COMPACT.md).

## Architecture

### Parties

| Party        | Role                               | Owns                                         |
| ------------ | ---------------------------------- | -------------------------------------------- |
| `sigNetwork` | MPC infrastructure (single party)  | `Signer`, `SigningNonce`, evidence contracts |
| `operators`  | Vault operator multi-sig `[Party]` | Vault templates (in downstream packages)     |
| `requester`  | End user (depositor/holder)        | —                                            |

`sigNetwork` is both the MPC party identity AND the Signer operator — no separate `mpc` party. A vault can have one or more operator parties (e.g., `[dex1, dex2, dex3]`); all operators must agree at Vault creation time via the `VaultProposal` multi-party agreement.

### Layer overview

```
Signer (singleton)                    ← sigNetwork deploys, shares blob via disclosed contracts
  │
  ├── SignBidirectional               ← requester exercises (via Vault);
  │     controller: requester           delegates to SignRequest.Execute
  │
  ├── Respond                         ← sigNetwork publishes ECDSA signature for the underlying tx
  │     controller: sigNetwork
  │
  └── RespondBidirectional            ← sigNetwork publishes outcome signature after confirmation
        controller: sigNetwork

SignRequest (transient)               ← created by Vault body, consumed via Execute in same tx
                                        Execute computes `sender = computeOperatorsHash(operators)`
                                        from the on-ledger signatory set (NOT user-supplied)
SignBidirectionalEvent                ← what the MPC watches (signatory: operators, requester)
SignatureRespondedEvent               ← ECDSA signature evidence (signatory: sigNetwork)
RespondBidirectionalEvent             ← outcome signature evidence (signatory: sigNetwork)
```

The Signer layer no longer enforces signing uniqueness via a Canton-side nonce.
Replay protection is the **Vault's** responsibility — implemented via single-use
`Pending*` archives (Canton side) and the EVM transaction nonce (chain side).
The Signer's only job is to enforce that distinct operator sets cannot share a
key namespace.

## Templates

### `Signer`

Singleton identity contract. Shared off-chain via disclosed contracts — any party with the blob can exercise choices on it. `sigNetwork` is the sole signatory. **No public key is stored here** — that's per-vault on the domain layer (e.g., `Vault.evmMpcPublicKey` in `daml-vault`).

```daml
template Signer
  with
    sigNetwork : Party
  where
    signatory sigNetwork

    nonconsuming choice SignBidirectional : ContractId SignBidirectionalEvent
      with
        signRequestCid : ContractId SignRequest
        requester      : Party
      controller requester
      do
        exercise signRequestCid Execute

    nonconsuming choice Respond : ContractId SignatureRespondedEvent
      with
        operators : [Party]
        requester : Party
        requestId : BytesHex
        signature : Signature
      controller sigNetwork
      do
        create SignatureRespondedEvent with
          sigNetwork; operators; requester; requestId
          responder = sigNetwork; signature

    nonconsuming choice RespondBidirectional : ContractId RespondBidirectionalEvent
      with
        operators        : [Party]
        requester        : Party
        requestId        : BytesHex
        serializedOutput : BytesHex
        signature        : Signature
      controller sigNetwork
      do
        create RespondBidirectionalEvent with
          sigNetwork; operators; requester; requestId
          responder = sigNetwork; serializedOutput; signature
```

### `SignRequest` (transient)

Transient authority bridge (Vault → Signer, the Daml equivalent of Solana CPI). Created inside a Vault choice body — where operator authority is available as a signatory — and consumed in the same transaction by `Signer.SignBidirectional` → `Execute`.

The MPC never sees this template. The `Execute` choice is the authority bridge: its body runs with `operators` (signatory) + `requester` (controller) — exactly the authority needed to create `SignBidirectionalEvent`.

`sender` (the KDF predecessorId) is **not** an argument — it is computed inside `Execute` from the on-ledger `operators` signatory list as `computeOperatorsHash (map partyToText operators)`. This guarantees that a Vault cannot supply a forged `sender` to claim another operator set's key namespace, since the Daml authorization model only allows the Vault to sign with its own operator set.

```daml
template SignRequest
  with
    operators                   : [Party]
    requester                   : Party
    sigNetwork                  : Party
    txParams                    : TxParams
    caip2Id                     : Text
    keyVersion                  : Int
    path                        : Text   -- Vault namespaces here; e.g. prefix with vaultId
    algo                        : Text
    dest                        : Text
    params                      : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators, requester
    observer sigNetwork
    ensure not (null operators) && unique operators

    choice Execute : ContractId SignBidirectionalEvent
      controller requester
      do
        let sender = computeOperatorsHash (map partyToText operators)
        create SignBidirectionalEvent with
          operators; requester; sigNetwork; sender
          txParams; caip2Id; keyVersion; path; algo; dest; params
          outputDeserializationSchema; respondSerializationSchema
```

### `SignBidirectionalEvent`

The sign-request template. Created by `SignRequest.Execute` (delegated from `Signer.SignBidirectional`). **This is what the MPC watches.**

Signatories are `operators, requester` — **NOT** `sigNetwork`. This is the central security invariant of the split: a compromised SigNetwork cannot unilaterally forge sign requests at the ledger level. See [Security Model](#security-model).

```daml
template SignBidirectionalEvent
  with
    operators                   : [Party]
    requester                   : Party
    sigNetwork                  : Party
    sender                      : BytesHex   -- operatorsHash, set by SignRequest.Execute
    txParams                    : TxParams
    caip2Id                     : Text
    keyVersion                  : Int
    path                        : Text
    algo                        : Text
    dest                        : Text
    params                      : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators, requester
    observer sigNetwork
    ensure not (null operators) && unique operators

    choice Consume_SignBidirectional : ()
      with actor : Party
      controller actor
      do
        assertMsg "Not authorized"
          (actor `elem` operators || actor == requester)
        pure ()
```

### `SignatureRespondedEvent`

MPC publishes the ECDSA signature for the underlying transaction. The Vault claim path archives this via `Consume_SignatureResponded` — direct `archive` isn't possible because the Vault body lacks `sigNetwork` authority.

```daml
template SignatureRespondedEvent
  with
    sigNetwork : Party
    operators  : [Party]
    requester  : Party
    requestId  : BytesHex
    responder  : Party
    signature  : Signature
  where
    signatory sigNetwork
    observer operators, requester

    choice Consume_SignatureResponded : ()
      with actor : Party
      controller actor
      do
        assertMsg "Not authorized"
          (actor `elem` operators || actor == requester)
        pure ()
```

### `RespondBidirectionalEvent`

MPC publishes the outcome signature after EVM execution confirmation. `serializedOutput` carries ABI-encoded return data (success) or `0xdeadbeef` + error payload (failure). Same `Consume_*` cleanup pattern as `SignatureRespondedEvent`.

```daml
template RespondBidirectionalEvent
  with
    sigNetwork       : Party
    operators        : [Party]
    requester        : Party
    requestId        : BytesHex
    responder        : Party
    serializedOutput : BytesHex
    signature        : Signature
  where
    signatory sigNetwork
    observer operators, requester

    choice Consume_RespondBidirectional : ()
      with actor : Party
      controller actor
      do
        assertMsg "Not authorized"
          (actor `elem` operators || actor == requester)
        pure ()
```

### `EvmType2TransactionParams`

Generic EIP-1559 transaction parameters (`EvmTypes.daml`). The MPC is transaction-type agnostic and signs the exact Type 2 payload represented by these fields. The contract stores raw calldata as inspectable bytes, so domain packages can authorize EVM calls by checking the selector and ABI slots with `abiSelector`, `abiStripSelector`, `abiSlot`, and `abiHasExactSlotCount` from `daml-abi`.

```daml
data EvmAccessListEntry = EvmAccessListEntry
  with
    address     : BytesHex
    storageKeys : [BytesHex]
  deriving (Eq, Show)

data EvmType2TransactionParams = EvmType2TransactionParams
  with
    chainId              : BytesHex
    nonce                : BytesHex
    maxPriorityFeePerGas : BytesHex
    maxFeePerGas         : BytesHex
    gasLimit             : BytesHex
    to                   : Optional BytesHex
    value                : BytesHex
    calldata             : BytesHex
    accessList           : [EvmAccessListEntry]
  deriving (Eq, Show)
```

`to = None` represents contract creation. `calldata = ""` represents an empty data field, which covers plain ETH transfers and contract `receive()` calls. Access lists are included in the signed payload instead of being hardcoded empty.

The MPC does not reconstruct calldata from a function signature. Domain contracts authorize directly from `calldata`: for example, `daml-vault` checks that the first four bytes match `functionSelector "transfer(address,uint256)"`, strips the selector, verifies exactly two ABI slots, and decodes recipient and amount from those slots.

### `TxParams`

Chain-agnostic transaction parameter wrapper (`TxParams.daml`). Currently EVM-only, extensible to BTC/SOL by adding further constructors.

```daml
data TxParams
  = EvmType2TxParams EvmType2TransactionParams
  deriving (Eq, Show)
```

`SignRequest` and `SignBidirectionalEvent` carry `TxParams`; `hashTxParams` in `RequestId.daml` pattern-matches per constructor, so a future `BtcTxParams` / `SolTxParams` slots into the request-ID hash layout without disturbing the EVM path.

### `Signature` union type

```daml
data EcdsaSigData = EcdsaSigData with
    der        : SignatureHex   -- DER-encoded (r, s) as hex
    recoveryId : Int            -- 0 or 1 — y-parity for EVM ecrecover
  deriving (Eq, Show)

data Signature
  = EcdsaSig EcdsaSigData
  -- Future: EddsaSig EddsaSigData, SchnorrSig SchnorrSigData
  deriving (Eq, Show)
```

**Why DER?** Daml's `secp256k1WithEcdsaOnly` builtin only accepts DER-encoded signatures; there is no builtin for verifying `(r, s)` structured components. This is why Canton's signature format diverges from Solana's `AffinePoint { bigR, s, recoveryId }`.

**Why a union?** Future-proofs for EdDSA (Solana, Sui) and Schnorr (Bitcoin Taproot) without changing the wire format.

## Authority Delegation Flow

The Vault → Signer crossing uses Daml's flexible-controller pattern combined with disclosed contracts. A vault choice that needs a signature runs with this authority chain:

```
VaultProposal (propose/sign/sign/finalize)
  → Vault (signatory: [op1, op2, op3])
    → RequestDeposit (body authority: op1 + op2 + op3 + requester)
      → create SignRequest                         (needs operators + requester authority — ✓ both available in Vault body)
      → exercise Signer.SignBidirectional          (needs requester authority — ✓ requester is controller)
        → SignRequest.Execute                      (body authority: operators + requester)
          → SignBidirectionalEvent                 (signatory: operators, requester — ✓)
```

Key points:

1. A nonconsuming Vault choice runs with the Vault's signatory authority (operators).
2. `requester` is the controller of `RequestDeposit`, so it contributes its own authority.
3. Creating `SignRequest` consumes both — valid because both are available at creation.
4. `Signer.SignBidirectional` is exercised on the **disclosed** Signer contract; `requester` is a flexible controller, so it can exercise without `sigNetwork`'s explicit delegation.
5. `SignRequest.Execute` runs with `operators` (signatory) + `requester` (controller) — the exact authority required to create `SignBidirectionalEvent`.

No re-signing happens per transaction. Operator authority established at Vault creation propagates through the entire chain via nonconsuming choices.

## Cross-Operator-Set Isolation

`sender` (the KDF predecessorId) is computed in `SignRequest.Execute` as `computeOperatorsHash (map partyToText operators)` — directly from the on-ledger `operators` signatory list. Since Canton party IDs are globally unique (`hint::sha256(namespace_key)`), two different operator sets can never produce the same `sender` even with identical `txParams`. The operators list is sorted before hashing.

```
sender = computeOperatorsHash(map partyToText operators)
computeOperatorsHash = keccak256(concat(map (keccak256 . toHex) (sort operatorTexts)))
```

The Vault never supplies `sender`; it is derived from authority that the Vault provably holds. The MPC's KDF and the `requestId` hash both depend on `sender`, so the MPC signature is transitively bound to the full operator set — stripping or reordering operators breaks verification.

### Vault-side namespacing via `path`

The Signer **only** isolates operator sets, not vaults. Two `Vault` contracts that share the same operator set will share the same `sender`, and so the same key namespace, unless the Vault layer namespaces its requests via `path`. By convention, `daml-vault` prepends `vaultId`:

- Deposit: `path = vaultId <> "," <> partyToText requester <> "," <> userPath`
- Withdrawal: `path = vaultId <> ",root"`

Since `path` feeds both the KDF and `requestId`, this gives different EVM keys per `vaultId` even with identical operators. **Any new Vault implementation that reuses operator sets must follow the same convention** — the Signer cannot enforce it.

## MPC Service Flow

The MPC service is fully generic — it has no knowledge of deposits, withdrawals, or ERC-20 concepts. It only watches `SignBidirectionalEvent` and exercises `Signer.Respond` / `Signer.RespondBidirectional`.

1. Watch `SignBidirectionalEvent` via Canton `/v2/updates` WebSocket stream.
2. Validate transaction metadata: `CreatedEvent.signatories` must include all operators and the requester (defense-in-depth against API-layer forgery).
3. Re-compute `requestId` with the TS mirror of `RequestId.daml` and log it for traceability.
4. Derive the child private key with `derive_epsilon_canton()` using `predecessorId` (= `sender` = operatorsHash) and `path`.
5. Threshold-sign the transaction hash.
6. Exercise `Signer.Respond` → creates `SignatureRespondedEvent`.
7. Poll the destination chain for confirmation; re-simulate the call at `blockNumber - 1` to extract ABI-encoded return data (or encode `0xdeadbeef` + error payload on failure).
8. Sign `responseHash = keccak256(requestId <> mpcOutput)` with the **root** private key (not the child) and exercise `Signer.RespondBidirectional` → creates `RespondBidirectionalEvent`.

The MPC service does not enforce a Canton-side replay nonce. The Vault enforces single-use via `Pending*` archives, and the destination EVM chain enforces transaction-nonce uniqueness. The MPC may safely receive a duplicate `SignBidirectionalEvent` with an identical `requestId`: signing is idempotent (RFC6979 deterministic ECDSA) and only one EVM tx will ever land.

### KDF chain ID

The MPC KDF uses `canton:global` as the **source** chain CAIP-2 ID — not the destination chain. The derivation path string is:

```
sig.network v2.0.0 epsilon derivation:canton:global:{predecessorId}:{path}
```

The KDF always uses the source chain (where the request originates), not the destination. This is exported as `constants.KDF_CHAIN_IDS.CANTON` from `signet.js` and must match `Chain::Canton.caip2_chain_id()` in the Rust MPC node.

## `requestId` Computation

`computeRequestId` produces a `keccak256` over the concatenation of EIP-712-encoded fields. The Daml implementation (`RequestId.daml`), the Rust implementation in `indexer_canton`, and the TS oracle (`ts-packages/canton-sig/src/mpc/crypto.ts`) must all produce byte-identical hashes.

```daml
computeRequestId sender txParams caip2Id keyVersion path algo dest params =
  keccak256 $
       eip712EncodeString sender                -- operatorsHash, set in SignRequest.Execute
    <> hashTxParams       txParams
    <> eip712EncodeString caip2Id
    <> eip712EncodeUint256 (toHex keyVersion)
    <> eip712EncodeString path
    <> eip712EncodeString algo
    <> eip712EncodeString dest
    <> eip712EncodeString params

computeResponseHash requestId output =
  keccak256 (assertBytes32 requestId <> output)
```

The `responseHash` is what the MPC signs with the root key. Since `sender` is the `operatorsHash`, the MPC signature transitively binds the outcome to the full operator set.

## Security Model

### Ledger-level invariant

`SignBidirectionalEvent` has `signatory operators, requester` — `sigNetwork` is only an observer. In a multi-participant Canton Network, a malicious SigNetwork participant cannot forge these contracts because the operators' Confirming Participant Nodes would reject the transaction at the mediator level. `sigNetwork` cannot create `SignBidirectionalEvent` directly — only a `requester` with `operators`' signatory authority (via a Vault choice) can.

### API-level caveat: malicious participant

The multi-signatory model protects the ledger but not the API. The MPC service reads from SigNetwork's JSON Ledger API via WebSocket — analogous to an off-chain service trusting a single Ethereum RPC endpoint. A malicious SigNetwork participant could patch its API to inject fake `CreatedEvent` entries into the stream.

The MPC service validates `CreatedEvent.signatories` as defense-in-depth. In **single-participant** mode, a malicious participant can forge metadata too, so this check only closes the gap when combined with **multi-participant** deployment, where metadata is populated from the actual confirmation protocol.

Canton has no light-client proof protocol — no Merkle proofs against a global state root — so the only robust mitigation is distributing MPC reads across multiple participants.

### Phased rollout

- **v0 (PoC)** — Single Canton participant operated by SigNetwork. MPC trusts the node. Multi-signatory model provides defense-in-depth only. Acceptable for a demo with a known, trusted operator.
- **v1 (Multi-participant)** — Each operator runs its own Canton participant. The `sigNetwork` party is multi-hosted with Observation permission on operator participants. MPC nodes are distributed across participants so no single operator controls the threshold. The multi-signatory model now provides real security via Canton's confirmation protocol.
- **v2 (Cross-validation)** — MPC nodes cross-check `SignBidirectionalEvent` against multiple participants before signing.

## Design Decisions

- **Separate DARs.** `daml-signer` and `daml-vault` are separate packages. `daml-signer` depends only on `daml-eip712` (for primitive encoders). `daml-vault` depends on `daml-signer` via `data-dependencies`. Shared byte types (`BytesHex`, `SignatureHex`) come from `DA.Crypto.Text` (stdlib) — no cross-DAR type sharing needed. Enables independent versioning and reuse across multiple vault implementations.
- **No Signer-layer nonce.** Replay prevention is the **Vault's** responsibility. Domain contracts already enforce single-use via `Pending*` archives (Canton side) and the EVM transaction nonce (chain side). The Signer only enforces that distinct operator sets cannot share a key namespace — which it does by computing `sender = operatorsHash` from on-ledger signatories inside `SignRequest.Execute`, not by trusting Vault input.

## Dependencies

- `daml-prim`, `daml-stdlib`, `daml-script`
- `daml-eip712` (via `data-dependencies`) — EIP-712 primitive encoders (`eip712EncodeString`, `eip712EncodeUint256`, etc.)

## Usage

Add to your `daml.yaml`:

```yaml
data-dependencies:
  - ../daml-signer/.daml/dist/daml-signer-0.0.1.dar
```

## Build & Test

```bash
dpm build
dpm test
```

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
  ├── IssueNonce                      ← requester self-serves the first SigningNonce
  │     controller: requester
  │
  ├── SignBidirectional               ← requester exercises (via Vault);
  │     controller: requester           archives SigningNonce, delegates to SignRequest.Execute,
  │                                     rotates nonce atomically
  │
  ├── Respond                         ← sigNetwork publishes ECDSA signature for the underlying tx
  │     controller: sigNetwork
  │
  └── RespondBidirectional            ← sigNetwork publishes outcome signature after confirmation
        controller: sigNetwork

SigningNonce                          ← replay-prevention nonce (signatory: sigNetwork)
SignRequest (transient)               ← created by Vault body, consumed via Execute in same tx
SignBidirectionalEvent                ← what the MPC watches (signatory: operators, requester)
SignatureRespondedEvent               ← ECDSA signature evidence (signatory: sigNetwork)
RespondBidirectionalEvent             ← outcome signature evidence (signatory: sigNetwork)
```

## Templates

### `Signer`

Singleton identity contract. Shared off-chain via disclosed contracts — any party with the blob can exercise choices on it. `sigNetwork` is the sole signatory. **No public key is stored here** — that's per-vault on the domain layer (e.g., `Vault.evmMpcPublicKey` in `daml-vault`).

```daml
template Signer
  with
    sigNetwork : Party
  where
    signatory sigNetwork

    nonconsuming choice IssueNonce : ContractId SigningNonce
      with requester : Party
      controller requester
      do create SigningNonce with sigNetwork; requester

    nonconsuming choice SignBidirectional
      : (ContractId SignBidirectionalEvent, ContractId SigningNonce)
      with
        signRequestCid : ContractId SignRequest
        nonceCid       : ContractId SigningNonce
        requester      : Party
      controller requester
      do
        nonce <- fetch nonceCid
        assertMsg "Nonce sigNetwork mismatch" (nonce.sigNetwork == sigNetwork)
        assertMsg "Nonce requester mismatch" (nonce.requester == requester)
        archive nonceCid
        eventCid <- exercise signRequestCid Execute
        newNonceCid <- create SigningNonce with sigNetwork; requester
        pure (eventCid, newNonceCid)

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

### `SigningNonce`

Replay-prevention nonce with atomic rotation. The requester issues the first nonce via `Signer.IssueNonce`; each `SignBidirectional` call archives the old nonce and creates a fresh one — so the requester always has a nonce ready for the next request without an extra transaction.

`sigNetwork` is the sole signatory so the MPC observes the archive in the sign transaction without needing observer rights on domain contracts. Pure Signer-layer infrastructure — no domain semantics.

**Nonce binding is validated off-chain, by design.** The `nonceCidText` field carried in `SignRequest` / `SignBidirectionalEvent` is the text form of the consumed `SigningNonce` contract ID, hashed into `requestId` for replay prevention. An on-chain check like `assertMsg "..." (nonceCidText == show nonceCid)` is architecturally impossible: Daml's `Show` instance for `ContractId` returns the placeholder string `"<contract-id>"` inside ledger code, and the underlying Daml-LF `CONTRACT_ID_TO_TEXT` builtin always returns `None` on-ledger (it is only defined for off-ledger code). Binding enforcement therefore lives in the MPC service, which cross-checks `nonceCidText` against the `ArchivedEvent` (templateId suffix `SigningNonce`) observed in the same transaction tree — see [MPC Service Flow](#mpc-service-flow) step 3. This split is intentional, not a gap: the ledger cannot express the check, so it is enforced at the observer layer instead.

```daml
template SigningNonce
  with
    sigNetwork : Party
    requester  : Party
  where
    signatory sigNetwork
    observer requester

    choice Consume_SigningNonce : ()
      controller requester
      do pure ()
```

### `SignRequest` (transient)

Transient authority bridge (Vault → Signer, the Daml equivalent of Solana CPI). Created inside a Vault choice body — where operator authority is available as a signatory — and consumed in the same transaction by `Signer.SignBidirectional` → `Execute`.

The MPC never sees this template. The `Execute` choice is the authority bridge: its body runs with `operators` (signatory) + `requester` (controller) — exactly the authority needed to create `SignBidirectionalEvent`.

```daml
template SignRequest
  with
    operators                   : [Party]
    requester                   : Party
    sigNetwork                  : Party
    sender                      : Text      -- predecessorId = vaultId <> keccak256(sort(operators))
    txParams                    : TxParams
    caip2Id                     : Text
    keyVersion                  : Int
    path                        : Text
    algo                        : Text
    dest                        : Text
    params                      : Text
    nonceCidText                : Text      -- text representation of consumed SigningNonce ID;
                                            -- hashed into requestId for replay prevention
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators, requester
    observer sigNetwork
    ensure not (null operators) && unique operators

    choice Execute : ContractId SignBidirectionalEvent
      controller requester
      do
        create SignBidirectionalEvent with
          operators; requester; sigNetwork; sender
          txParams; caip2Id; keyVersion; path; algo; dest; params
          nonceCidText
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
    sender                      : Text
    txParams                    : TxParams
    caip2Id                     : Text
    keyVersion                  : Int
    path                        : Text
    algo                        : Text
    dest                        : Text
    params                      : Text
    nonceCidText                : Text
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

### `EvmTransactionParams`

Generic EIP-1559 transaction parameters (`EvmTypes.daml`). The MPC is transaction-type agnostic — it signs any Type 2 transaction. The contract stores the function signature and ABI-encoded args as a single blob, giving Daml visibility into the EVM call for on-chain authorization via `abiSlot` / `abiSlotCount` (from `daml-abi`).

```daml
data EvmTransactionParams = EvmTransactionParams
  with
    to                   : BytesHex   -- 20 bytes, destination address
    functionSignature    : Text       -- e.g., "transfer(address,uint256)"
    encodedArgs          : BytesHex   -- full ABI-encoded parameter body (after selector)
    value                : BytesHex   -- 32 bytes, ETH value (usually "00...")
    nonce                : BytesHex   -- 32 bytes
    gasLimit             : BytesHex   -- 32 bytes
    maxFeePerGas         : BytesHex   -- 32 bytes
    maxPriorityFeePerGas : BytesHex   -- 32 bytes
    chainId              : BytesHex   -- 32 bytes
  deriving (Eq, Show)
```

**Why split `functionSignature` and `encodedArgs` instead of storing raw calldata?** EVM calldata is a 4-byte function selector followed by the ABI-encoded parameter body. Storing the two pieces separately keeps both halves inspectable from Daml while letting any signer reconstruct byte-identical calldata:

- `functionSignature : Text` is the canonical signature string, e.g. `"transfer(address,uint256)"`. The 4-byte selector is recomputable off-chain as `keccak256(functionSignature)[0..4]` (→ `0xa9059cbb` for `transfer`). Keeping it as `Text` — not a pre-hashed constant — means Daml can compare and display it directly, and the selector is always provably derived from a human-readable name.
- `encodedArgs : BytesHex` is the ABI-encoded parameter body _after_ the selector. For `transfer(address,uint256)` this is exactly two 32-byte slots: slot 0 = recipient (address left-padded to 32 bytes), slot 1 = amount (uint256). Vault code authorizes the call on-chain by reading these slots — e.g. `daml-vault`'s `Erc20Vault` asserts `abiSlotCount encodedArgs == 2`, extracts the recipient with `abiSlot encodedArgs 0`, and the amount with `abiDecodeUint encodedArgs 1`.

The MPC (and any other signer) reconstructs canonical calldata deterministically as `keccak256(functionSignature)[0..4] <> encodedArgs` — see `buildCalldata` in `ts-packages/canton-sig/src/evm/tx-builder.ts`. Every byte that goes on the wire is therefore a pure function of fields the ledger already sees.

### `TxParams`

Chain-agnostic transaction parameter wrapper (`TxParams.daml`). Currently EVM-only, extensible to BTC/SOL by adding further constructors.

```daml
data TxParams
  = EvmTxParams EvmTransactionParams
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

## Cross-Vault Isolation

`requestId` is bound to all operator parties via `sender = vaultId <> operatorsHash`. Since Canton party IDs are globally unique (`hint::sha256(namespace_key)`), two different operator sets can never produce the same `requestId` even with identical `txParams`. The operators list is sorted before hashing.

```
sender = predecessorId = vaultId <> computeOperatorsHash(map partyToText operators)
computeOperatorsHash = keccak256(concat(map (keccak256 . toHex) (sort operatorTexts)))
```

The Vault computes `predecessorId` on-chain and passes it to the Signer as `sender`. The MPC's KDF and the `requestId` hash both depend on `sender`, so the MPC signature is transitively bound to the full operator set — stripping or reordering operators breaks verification.

## MPC Service Flow

The MPC service is fully generic — it has no knowledge of deposits, withdrawals, or ERC-20 concepts. It only watches `SignBidirectionalEvent` and exercises `Signer.Respond` / `Signer.RespondBidirectional`.

1. Watch `SignBidirectionalEvent` via Canton `/v2/updates` WebSocket stream in `LEDGER_EFFECTS` mode — the `ExercisedEvent` nodes let the MPC assert the `SignBidirectional` choice directly and see nonce archival as a consuming exercise (under `ACS_DELTA` it would only see an `ArchivedEvent`). The TS reference client in `ts-packages/canton-sig` subscribes in `ACS_DELTA` and binds the nonce via `ArchivedEvent` instead.
2. Validate transaction metadata: `CreatedEvent.signatories` must include all operators and the requester (defense-in-depth against API-layer forgery).
3. Verify an `ExercisedEvent` with choice `SignBidirectional` on the pinned `Signer` contract exists in the same transaction — proves the event came through the correct Daml code path, not fabricated.
4. Verify `nonceCidText` matches the `contractId` of a **consuming** `ExercisedEvent` in the same transaction, and that its `templateId` suffix is `SigningNonce`. Skipped during catch-up (`getActiveContracts`) where transaction context is unavailable.
5. Re-compute `requestId` with the TS mirror of `RequestId.daml` and log it for traceability.
6. Derive the child private key with `derive_epsilon_canton()` using `predecessorId` (= `sender`) and `path`.
7. Threshold-sign the transaction hash.
8. Exercise `Signer.Respond` → creates `SignatureRespondedEvent`.
9. Poll the destination chain for confirmation; re-simulate the call at `blockNumber - 1` to extract ABI-encoded return data (or encode `0xdeadbeef` + error payload on failure).
10. Sign `responseHash = keccak256(requestId <> mpcOutput)` with the **root** private key (not the child) and exercise `Signer.RespondBidirectional` → creates `RespondBidirectionalEvent`.

### KDF chain ID

The MPC KDF uses `canton:global` as the **source** chain CAIP-2 ID — not the destination chain. The derivation path string is:

```
sig.network v2.0.0 epsilon derivation:canton:global:{predecessorId}:{path}
```

The KDF always uses the source chain (where the request originates), not the destination. This is exported as `constants.KDF_CHAIN_IDS.CANTON` from `signet.js` and must match `Chain::Canton.caip2_chain_id()` in the Rust MPC node.

## `requestId` Computation

`computeRequestId` produces a `keccak256` over the concatenation of EIP-712-encoded fields. The Daml implementation (`RequestId.daml`), the Rust implementation in `indexer_canton`, and the TS oracle (`ts-packages/canton-sig/src/mpc/crypto.ts`) must all produce byte-identical hashes.

```daml
computeRequestId sender txParams caip2Id keyVersion path algo dest params nonceCidText =
  keccak256 $
       eip712EncodeString sender                -- predecessorId = vaultId <> operatorsHash
    <> hashTxParams       txParams
    <> eip712EncodeString caip2Id
    <> eip712EncodeUint256 (toHex keyVersion)
    <> eip712EncodeString path
    <> eip712EncodeString algo
    <> eip712EncodeString dest
    <> eip712EncodeString params
    <> eip712EncodeString nonceCidText

computeResponseHash requestId output =
  keccak256 (assertBytes32 requestId <> output)
```

The `responseHash` is what the MPC signs with the root key. Since `sender` already encodes `operatorsHash`, the MPC signature transitively binds the outcome to the full operator set.

## Security Model

### Ledger-level invariant

`SignBidirectionalEvent` has `signatory operators, requester` — `sigNetwork` is only an observer. In a multi-participant Canton Network, a malicious SigNetwork participant cannot forge these contracts because the operators' Confirming Participant Nodes would reject the transaction at the mediator level. `sigNetwork` cannot create `SignBidirectionalEvent` directly — only a `requester` with `operators`' signatory authority (via a Vault choice) can.

### API-level caveat: malicious participant

The multi-signatory model protects the ledger but not the API. The MPC service reads from SigNetwork's JSON Ledger API via WebSocket — analogous to an off-chain service trusting a single Ethereum RPC endpoint. A malicious SigNetwork participant could patch its API to inject fake `CreatedEvent` entries into the stream.

The MPC service validates `CreatedEvent.signatories`, the presence of an `ExercisedEvent` for choice `SignBidirectional` on the pinned `Signer`, and the `nonceCidText → consuming ExercisedEvent(SigningNonce)` binding as defense-in-depth. In **single-participant** mode, a malicious participant can forge metadata too, so these checks only close the gap when combined with **multi-participant** deployment, where metadata is populated from the actual confirmation protocol.

Canton has no light-client proof protocol — no Merkle proofs against a global state root — so the only robust mitigation is distributing MPC reads across multiple participants.

### Phased rollout

- **v0 (PoC)** — Single Canton participant operated by SigNetwork. MPC trusts the node. Multi-signatory model provides defense-in-depth only. Acceptable for a demo with a known, trusted operator.
- **v1 (Multi-participant)** — Each operator runs its own Canton participant. The `sigNetwork` party is multi-hosted with Observation permission on operator participants. MPC nodes are distributed across participants so no single operator controls the threshold. The multi-signatory model now provides real security via Canton's confirmation protocol.
- **v2 (Cross-validation)** — MPC nodes cross-check `SignBidirectionalEvent` against multiple participants before signing.

## Design Decisions

- **Separate DARs.** `daml-signer` and `daml-vault` are separate packages. `daml-signer` depends only on `daml-eip712` (for primitive encoders). `daml-vault` depends on `daml-signer` via `data-dependencies`. Shared byte types (`BytesHex`, `SignatureHex`) come from `DA.Crypto.Text` (stdlib) — no cross-DAR type sharing needed. Enables independent versioning and reuse across multiple vault implementations.
- **Signer-layer nonce.** Replay prevention uses `SigningNonce` (signatory: `sigNetwork`), issued via `Signer.IssueNonce` and atomically rotated in `Signer.SignBidirectional`. Domain contracts don't need `sigNetwork` as observer. Authorization (who may use a Vault) is the integrator's concern, not the Signer's.

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

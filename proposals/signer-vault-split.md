# Signer/Vault Split: Canton MPC PoC

Split `VaultOrchestrator` into two independent templates with different
operators: a **Signer** (SigNetwork) and a **Vault** (DEX). The Signer is
generic signing infrastructure — chain-agnostic, vault-agnostic, reusable
across multiple DEXes. The Vault is domain-specific ERC20 custody that
creates signing requests and interprets outcomes.

This mirrors the Solana architecture: `signet-solana-program` (Signer) vs
`solana-contract-examples` (Vault calling Signer via CPI).

## Motivation

The current `VaultOrchestrator` conflates two responsibilities:

1. **Signing coordination** — MPC key derivation, request IDs, signature
   lifecycle, outcome verification
2. **Vault operations** — deposit auth cards, ERC20 holdings, sweep
   validation, refund logic

Problems:

- A new vault type (BTC, NFT, swap) requires duplicating the entire signing
  layer
- The MPC service is coupled to vault-specific contract types
  (`PendingEvmTx`, `TxSource`)
- A single operator (`issuer`) controls both signing and custody — no
  separation between infrastructure provider and application

## Parties

| Party        | Role                        | Owns                |
| ------------ | --------------------------- | ------------------- |
| `sigNetwork` | MPC infrastructure provider | Signer              |
| `mpc`        | MPC service identity        | Observer everywhere |
| `dex`        | Vault operator (a DEX)      | Vault               |
| `user`       | End user (depositor/holder) | Exercises Vault     |

## Contract Overview

### Signer Layer (SigNetwork)

```
Signer (singleton)                 ← sigNetwork deploys, shares blob off-chain
  │
  ├── ProvideSignature choice      ← MPC exercises after signing EVM tx
  └── ProvideOutcome choice        ← MPC exercises after chain confirmation
          │
          ▼
SignAuthorization                   ← DEX creates (via Vault choice)
  │
  └── Accept choice                ← MPC exercises, archives auth, creates:
          │
          ▼
PendingSignature                   ← carries request metadata + mpcPublicKey
  │
  └── ClaimOutcome choice          ← DEX exercises (via Vault choice),
          │                           verifies MPC sig, archives evidence,
          ▼                           returns ClaimResult
EcdsaSignature + EvmTxOutcomeSignature (evidence contracts)
```

### Vault Layer (DEX)

```
Vault (singleton)                  ← DEX deploys, shares blob off-chain
  │
  ├── RequestDepositAuth           ← user requests auth card
  ├── ApproveDepositAuth           ← dex approves, creates DepositAuthorization
  ├── RequestEvmDeposit            ← user requests deposit → creates SignAuthorization
  ├── ClaimEvmDeposit              ← user claims → exercises ClaimOutcome → creates Erc20Holding
  ├── RequestEvmWithdrawal         ← user requests withdrawal → creates SignAuthorization
  └── CompleteEvmWithdrawal        ← user completes → exercises ClaimOutcome → refund or finalize

DepositAuthProposal, DepositAuthorization, Erc20Holding (unchanged)
```

## Signer Contracts

### `Signer`

Singleton identity contract. Holds the MPC public key. Shared off-chain via
disclosed contracts — any party with the blob can exercise choices on it.

```daml
template Signer
  with
    sigNetwork   : Party
    mpc          : Party
    mpcPublicKey : PublicKeyHex
  where
    signatory sigNetwork
    observer mpc

    nonconsuming choice ProvideSignature : ContractId EcdsaSignature
      with
        dex       : Party
        requester : Party
        requestId : BytesHex
        r         : BytesHex
        s         : BytesHex
        v         : Int
      controller sigNetwork
      do
        create EcdsaSignature with
          sigNetwork; dex; requester; requestId; r; s; v

    nonconsuming choice ProvideOutcome : ContractId EvmTxOutcomeSignature
      with
        dex       : Party
        requester : Party
        requestId : BytesHex
        signature : SignatureHex
        mpcOutput : BytesHex
      controller sigNetwork
      do
        create EvmTxOutcomeSignature with
          sigNetwork; dex; requester; requestId; signature; mpcOutput
```

### `SignAuthorization`

Proposal contract created by the Vault (signatory: `dex`), consumed by
SigNetwork. This is the handoff point — the Vault authorizes a signing
request, and the Signer picks it up.

The `metadata` field is opaque to the Signer. The Vault uses it to tag
requests (e.g., `"deposit"` vs `"withdrawal"`) and verifies it on claim to
prevent cross-flow confusion.

```daml
template SignAuthorization
  with
    dex           : Party
    sigNetwork    : Party
    mpc           : Party
    requester     : Party          -- end user
    evmParams     : EvmTransactionParams
    predecessorId : Text           -- vault-computed: vaultId <> partyToText dex
    path          : Text           -- deposit: sender,userPath; withdrawal: "root"
    nonceCidText  : Text           -- consumed contract ID as text (uniqueness nonce)
    keyVersion    : Int
    algo          : Text
    dest          : Text
    metadata      : Text           -- opaque to Signer, e.g. "deposit" or "withdrawal"
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory dex
    observer sigNetwork, mpc

    choice Accept : ContractId PendingSignature
      with
        signerCid : ContractId Signer
      controller sigNetwork
      do
        signer <- fetch signerCid
        assertMsg "Signer party mismatch" (signer.sigNetwork == sigNetwork)

        let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
        let requestId = computeRequestId
              (partyToText dex)     -- sender = dex party (cross-vault isolation)
              requester
              evmParams caip2Id keyVersion path algo dest nonceCidText

        create PendingSignature with
          sigNetwork; mpc; dex; requester; requestId
          mpcPublicKey = signer.mpcPublicKey
          evmParams; predecessorId; path; nonceCidText
          keyVersion; algo; dest; metadata
          outputDeserializationSchema; respondSerializationSchema
```

### `PendingSignature`

Anchor contract for a signing request. Created by `Accept`, carries all
metadata the MPC service needs. The `mpcPublicKey` is copied from the
Signer at creation time so `ClaimOutcome` can verify signatures without
fetching the Signer again.

```daml
template PendingSignature
  with
    sigNetwork    : Party
    mpc           : Party
    mpcPublicKey  : PublicKeyHex   -- copied from Signer at Accept time
    dex           : Party
    requester     : Party
    requestId     : BytesHex
    evmParams     : EvmTransactionParams
    predecessorId : Text
    path          : Text
    nonceCidText  : Text
    keyVersion    : Int
    algo          : Text
    dest          : Text
    metadata      : Text           -- opaque, passed through from SignAuthorization
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory sigNetwork
    observer mpc, dex, requester

    choice ClaimOutcome : ClaimResult
      with
        outcomeCid : ContractId EvmTxOutcomeSignature
        ecdsaCid   : ContractId EcdsaSignature
        claimer    : Party
      controller claimer
      do
        outcome <- fetch outcomeCid
        ecdsa   <- fetch ecdsaCid

        assertMsg "Outcome requestId mismatch"
          (outcome.requestId == requestId)
        assertMsg "Ecdsa requestId mismatch"
          (ecdsa.requestId == requestId)

        let responseHash = computeResponseHash requestId outcome.mpcOutput
        assertMsg "Invalid MPC signature"
          (secp256k1WithEcdsaOnly outcome.signature responseHash mpcPublicKey)

        archive outcomeCid
        archive ecdsaCid

        pure ClaimResult with
          requestId; dex; requester; evmParams; metadata
          mpcOutput = outcome.mpcOutput
          ecdsaR = ecdsa.r; ecdsaS = ecdsa.s; ecdsaV = ecdsa.v
```

### `EcdsaSignature`

```daml
template EcdsaSignature
  with
    sigNetwork : Party
    dex        : Party
    requester  : Party
    requestId  : BytesHex
    r          : BytesHex
    s          : BytesHex
    v          : Int
  where
    signatory sigNetwork
    observer dex, requester
```

### `EvmTxOutcomeSignature`

```daml
template EvmTxOutcomeSignature
  with
    sigNetwork : Party
    dex        : Party
    requester  : Party
    requestId  : BytesHex
    signature  : SignatureHex
    mpcOutput  : BytesHex
  where
    signatory sigNetwork
    observer dex, requester
```

### `ClaimResult` (data record)

Returned by `ClaimOutcome` — the Vault uses this to create holdings or
process refunds.

```daml
data ClaimResult = ClaimResult
  with
    requestId : BytesHex
    dex       : Party
    requester : Party
    evmParams : EvmTransactionParams
    metadata  : Text
    mpcOutput : BytesHex
    ecdsaR    : BytesHex
    ecdsaS    : BytesHex
    ecdsaV    : Int
  deriving (Eq, Show)
```

## Vault Contracts

### `Vault`

Replaces `VaultOrchestrator`. Domain-specific ERC20 custody. The `sigNetwork`
party is stored so the Vault can set it on `SignAuthorization` contracts.

```daml
template Vault
  with
    dex          : Party
    sigNetwork   : Party
    mpc          : Party
    vaultAddress : BytesHex
    vaultId      : Text
  where
    signatory dex
    observer mpc
```

### `RequestEvmDeposit`

Validates the auth card, creates a `SignAuthorization` for the Signer.
The `predecessorId` is computed here (vault-specific) and passed through.

```daml
    nonconsuming choice RequestEvmDeposit : ContractId SignAuthorization
      with
        requester : Party
        path      : Text
        evmParams : EvmTransactionParams
        authCidText : Text
        keyVersion  : Int
        algo        : Text
        dest        : Text
        authCid     : ContractId DepositAuthorization
        outputDeserializationSchema : Text
        respondSerializationSchema  : Text
      controller requester
      do
        auth <- fetch authCid
        assertMsg "Auth card issuer mismatch" (auth.issuer == dex)
        assertMsg "Auth card owner mismatch" (auth.owner == requester)
        assertMsg "Auth card has no remaining uses" (auth.remainingUses > 0)
        archive authCid
        when (auth.remainingUses > 1) do
          void $ create auth with remainingUses = auth.remainingUses - 1

        let recipientArg = case evmParams.args of
              recipient :: _ -> recipient
              [] -> ""
        assertMsg "Only ERC20 transfer allowed"
          (evmParams.functionSignature == "transfer(address,uint256)")
        assertMsg "Transfer recipient must be vault address"
          (recipientArg == vaultAddress)

        let sender = partyToText requester
        let fullPath = sender <> "," <> path
        let predecessorId = vaultId <> partyToText dex

        create SignAuthorization with
          dex; sigNetwork; mpc; requester
          evmParams; predecessorId; path = fullPath; nonceCidText = authCidText
          keyVersion; algo; dest; metadata = "deposit"
          outputDeserializationSchema; respondSerializationSchema
```

### `ClaimEvmDeposit`

Exercises `PendingSignature.ClaimOutcome` to verify the MPC signature and
archive evidence. Then interprets the result for the deposit flow.

```daml
    nonconsuming choice ClaimEvmDeposit : ContractId Erc20Holding
      with
        requester  : Party
        pendingCid : ContractId PendingSignature
        outcomeCid : ContractId EvmTxOutcomeSignature
        ecdsaCid   : ContractId EcdsaSignature
      controller requester
      do
        result <- exercise pendingCid ClaimOutcome with
          outcomeCid; ecdsaCid; claimer = dex

        assertMsg "Not a deposit" (result.metadata == "deposit")
        assertMsg "Requester mismatch" (result.requester == requester)
        assertMsg "DEX mismatch" (result.dex == dex)

        assertMsg "MPC reported ETH transaction failure"
          (not (hasErrorPrefix result.mpcOutput))
        let success = abiDecodeBool result.mpcOutput 0
        assertMsg "ERC20 transfer returned false" success

        let amount = (result.evmParams).args !! 1
        create Erc20Holding with
          issuer = dex
          owner = requester
          erc20Address = (result.evmParams).to
          amount
```

### `RequestEvmWithdrawal`

Archives the `Erc20Holding` (optimistic debit), creates a
`SignAuthorization` for the Signer.

```daml
    nonconsuming choice RequestEvmWithdrawal : ContractId SignAuthorization
      with
        requester        : Party
        evmParams        : EvmTransactionParams
        recipientAddress : BytesHex
        balanceCidText   : Text
        keyVersion       : Int
        algo             : Text
        dest             : Text
        balanceCid       : ContractId Erc20Holding
        outputDeserializationSchema : Text
        respondSerializationSchema  : Text
      controller requester
      do
        holding <- fetch balanceCid
        assertMsg "Holding issuer mismatch" (holding.issuer == dex)
        assertMsg "Holding owner mismatch" (holding.owner == requester)

        let recipientArg = case evmParams.args of
              recipient :: _ -> recipient
              [] -> ""
        let amountArg = evmParams.args !! 1

        assertMsg "Only ERC20 transfer allowed"
          (evmParams.functionSignature == "transfer(address,uint256)")
        assertMsg "ERC20 contract must match holding"
          (evmParams.to == holding.erc20Address)
        assertMsg "Transfer recipient must match specified address"
          (recipientArg == recipientAddress)
        assertMsg "Withdraw amount must match holding"
          (amountArg == holding.amount)

        archive balanceCid

        let predecessorId = vaultId <> partyToText dex

        create SignAuthorization with
          dex; sigNetwork; mpc; requester
          evmParams; predecessorId; path = "root"
          nonceCidText = balanceCidText
          keyVersion; algo; dest; metadata = "withdrawal"
          outputDeserializationSchema; respondSerializationSchema
```

### `CompleteEvmWithdrawal`

```daml
    nonconsuming choice CompleteEvmWithdrawal : Optional (ContractId Erc20Holding)
      with
        requester  : Party
        pendingCid : ContractId PendingSignature
        outcomeCid : ContractId EvmTxOutcomeSignature
        ecdsaCid   : ContractId EcdsaSignature
      controller requester
      do
        result <- exercise pendingCid ClaimOutcome with
          outcomeCid; ecdsaCid; claimer = dex

        assertMsg "Not a withdrawal" (result.metadata == "withdrawal")
        assertMsg "Requester mismatch" (result.requester == requester)
        assertMsg "DEX mismatch" (result.dex == dex)

        let shouldRefund =
              if hasErrorPrefix result.mpcOutput then True
              else not (abiDecodeBool result.mpcOutput 0)

        if not shouldRefund
          then pure None
          else do
            let amount = (result.evmParams).args !! 1
            refundCid <- create Erc20Holding with
              issuer = dex
              owner = requester
              erc20Address = (result.evmParams).to
              amount
            pure (Some refundCid)
```

### Auth Contracts (unchanged)

`DepositAuthProposal`, `DepositAuthorization`, and `Erc20Holding` are
unchanged from the current design — only `issuer` is renamed to `dex` in
the Vault context. (Or kept as `issuer` if we want the Vault to be
operator-agnostic.)

## Cross-Vault Isolation

The `requestId` includes `partyToText dex` as the sender field. Since
Canton party IDs are globally unique (`hint::sha256(namespace_key)`),
two different DEXes can never produce the same `requestId` even with
identical `evmParams`.

```
requestId = eip712Hash(keccak256(
    requestTypeHash
    <> hashText (partyToText dex)       -- cross-vault isolation
    <> hashText (partyToText requester) -- cross-user isolation
    <> hashEvmParams evmParams
    <> hashText caip2Id
    <> padLeft (toHex keyVersion) 32
    <> hashText path
    <> hashText algo
    <> hashText dest
    <> hashText nonceCidText
))
```

Note: `computeRequestId` signature changes — it now takes `dex` and
`requester` separately instead of a single `sender` text. The EIP-712
type hash must be updated to include the new field. Both Daml and
TypeScript implementations must match.

## Deposit Lifecycle

```
 User                  Vault (DEX)             Signer (SigNetwork)     MPC Service              Sepolia
 |                     |                       |                       |                         |
 | 1. RequestDepositAuth                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | DepositAuthProposal   |                       |                         |
 |                     |                       |                       |                         |
 | 2. ApproveDepositAuth                       |                       |                         |
 |                     | DepositAuthorization  |                       |                         |
 |                     |                       |                       |                         |
 | 3. ERC20 transfer to deposit address        |                       |                         |
 |------------------------------------------------------------------------------  transfer ------>|
 |                     |                       |                       |                         |
 | 4. RequestEvmDeposit|                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | validates auth card   |                       |                         |
 |                     | creates               |                       |                         |
 |                     | SignAuthorization ---->|                       |                         |
 |                     |                       |                       |                         |
 |                     |                       |  5. MPC observes SignAuthorization               |
 |                     |                       |<--------------------->|                         |
 |                     |                       |  exercises Accept     |                         |
 |                     |                       |  → PendingSignature   |                         |
 |                     |                       |                       |                         |
 |                     |                       |                       | 6. derives child key    |
 |                     |                       |                       |    signs EVM tx         |
 |                     |                       |                       |                         |
 |                     |                       | 7. ProvideSignature   |                         |
 |                     |                       |<--- EcdsaSignature ---|                         |
 |                     |                       |                       |                         |
 | 8. observes EcdsaSignature                  |                       |                         |
 |<--------------------------------------------|                       |                         |
 |    reconstructSignedTx, eth_sendRawTransaction                      |                         |
 |------------------------------------------------------------------------------ sweep tx ------>|
 |                     |                       |                       |                         |
 |                     |                       |                       | 9. polls Sepolia        |
 |                     |                       |                       |    re-simulates call    |
 |                     |                       |                       |                         |
 |                     |                       | 10. ProvideOutcome    |                         |
 |                     |                       |<-- EvmTxOutcomeSig ---|                         |
 |                     |                       |                       |                         |
 | 11. ClaimEvmDeposit |                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | exercises             |                       |                         |
 |                     | PendingSignature      |                       |                         |
 |                     |   .ClaimOutcome ------>|                       |                         |
 |                     |                       | verifies MPC sig      |                         |
 |                     |                       | archives evidence     |                         |
 |                     |<-- ClaimResult -------|                       |                         |
 |                     |                       |                       |                         |
 |                     | checks metadata="deposit"                     |                         |
 |                     | abiDecodeBool == true  |                       |                         |
 |                     | creates Erc20Holding   |                       |                         |
 |                     |                       |                       |                         |
 |<-- Erc20Holding ----|                       |                       |                         |
```

## Withdrawal Lifecycle

```
 User                  Vault (DEX)             Signer (SigNetwork)     MPC Service              Sepolia
 |                     |                       |                       |                         |
 | 1. RequestEvmWithdrawal                     |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | validates Erc20Holding|                       |                         |
 |                     | archives it           |                       |                         |
 |                     | creates               |                       |                         |
 |                     | SignAuthorization ---->|                       |                         |
 |                     |   metadata="withdrawal"|                      |                         |
 |                     |                       |                       |                         |
 |                     |                       | 2. MPC: Accept        |                         |
 |                     |                       |  → PendingSignature   |                         |
 |                     |                       |                       | 3. sign + submit        |
 |                     |                       | 4. ProvideSignature   |                         |
 |                     |                       |<--- EcdsaSignature ---|                         |
 |                     |                       |                       |                         |
 | 5. submit signed tx |                       |                       |                         |
 |-------------------------------------------------------------------------- withdrawal tx ----->|
 |                     |                       |                       |                         |
 |                     |                       |                       | 6. poll + outcome       |
 |                     |                       | 7. ProvideOutcome     |                         |
 |                     |                       |<-- EvmTxOutcomeSig ---|                         |
 |                     |                       |                       |                         |
 | 8. CompleteEvmWithdrawal                    |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | ClaimOutcome -------->|                       |                         |
 |                     |<-- ClaimResult -------|                       |                         |
 |                     |                       |                       |                         |
 |                     | metadata="withdrawal" |                       |                         |
 |                     | success? → None       |                       |                         |
 |                     | failure? → refund     |                       |                         |
 |                     |   Erc20Holding        |                       |                         |
 |<-- result ----------|                       |                       |                         |
```

## MPC Service Changes

The MPC service becomes fully generic — it watches `SignAuthorization`
instead of `PendingEvmTx` and exercises Signer choices instead of
VaultOrchestrator choices. It has no knowledge of deposits, withdrawals,
or ERC20 concepts.

### Current Flow (vault-coupled)

1. Watch `PendingEvmTx` via WebSocket stream
2. Read `vaultId`, `issuer`, `path` from PendingEvmTx payload
3. Derive child key: `predecessorId = vaultId + partyToText issuer`
4. Sign EVM tx → exercise `VaultOrchestrator.SignEvmTx`
5. Poll chain → exercise `VaultOrchestrator.ProvideEvmOutcomeSig`

### New Flow (generic)

1. Watch `SignAuthorization` via WebSocket stream
2. Exercise `SignAuthorization.Accept` with `signerCid`
   → creates `PendingSignature`, get its CID
3. Read `predecessorId`, `path` from PendingSignature payload
4. Derive child key using `predecessorId` directly (no vault concepts)
5. Sign EVM tx → exercise `Signer.ProvideSignature`
6. Poll chain → exercise `Signer.ProvideOutcome`

The `predecessorId` is now pre-computed by the Vault and passed through.
The MPC service doesn't need to know how it was constructed.

## `computeRequestId` Changes

The function signature changes to include the DEX party as a separate
field for cross-vault isolation:

```daml
-- Before
computeRequestId : Text -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId sender evmParams caip2Id keyVersion path algo dest nonceCidText

-- After
computeRequestId : Text -> Party -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId dexText requester evmParams caip2Id keyVersion path algo dest nonceCidText
```

The EIP-712 struct type hash changes to include the new field:

```
-- Before
CantonMpcDepositRequest(string sender,EvmTransactionParams evmParams,...)

-- After
CantonMpcSignRequest(string dex,string requester,EvmTransactionParams evmParams,...)
```

Both the Daml and TypeScript implementations must produce identical hashes.

## Authorization Flow (Daml)

### Why `SignAuthorization.Accept` works

`Accept` is a consuming choice on `SignAuthorization`:

- **Signatory**: `dex`
- **Controller**: `sigNetwork`
- **Body authority**: `dex` (signatory) + `sigNetwork` (controller)
- Can create `PendingSignature` with signatory `sigNetwork` ✓
- Can fetch `Signer` (sigNetwork is signatory) ✓

### Why `Vault.ClaimEvmDeposit` → `PendingSignature.ClaimOutcome` works

`ClaimEvmDeposit` body runs with `dex` (Vault signatory) + `user` (controller).
It exercises `ClaimOutcome` with `claimer = dex`:

- `dex` is an observer on `PendingSignature` → can see it ✓
- `ClaimOutcome` controller is `claimer` (= `dex`) → has authority ✓
- `ClaimOutcome` body has `sigNetwork` (signatory) + `dex` (controller) →
  can archive `EcdsaSignature` and `EvmTxOutcomeSignature` (signatory: `sigNetwork`) ✓

### Disclosed contracts

The Vault and Signer contracts are shared off-chain via disclosed contract
blobs — same pattern as the current `VaultOrchestrator`. The user's
command submission includes disclosed blobs for both the Vault and the
Signer (for the ClaimOutcome exercise chain).

## Open Questions

1. **Separate DARs or single DAR?** — The Signer and Vault could be
   separate DAR packages (different SDK versions, independent deployment)
   or modules within the same DAR (simpler codegen, shared types). Separate
   DARs is cleaner architecturally but requires cross-DAR type sharing for
   `EvmTransactionParams`, `ClaimResult`, etc.

2. **`metadata` typing** — Currently `Text` for simplicity. Could be a
   typed enum if we want compile-time safety, but that couples the Signer
   to vault concepts. `Text` keeps the Signer generic.

3. **Renaming `issuer` → `dex`** — The Vault's `DepositAuthorization` and
   `Erc20Holding` currently use `issuer`. Should these be renamed to `dex`
   for consistency, or kept as `issuer` to stay operator-agnostic?

4. **`requestId` computation location** — Currently the Vault computes it.
   In this proposal, the Signer computes it (in `Accept`). This means the
   Vault doesn't know the `requestId` at `SignAuthorization` creation time.
   If the Vault needs to correlate its own state with the Signer's, it can
   use `nonceCidText` (the consumed contract ID, globally unique).

5. **Multiple Signers** — Should the Vault support switching between
   Signers (e.g., key rotation)? Currently the `sigNetwork` party is fixed
   on the Vault. A `UpdateSigner` choice could handle this.

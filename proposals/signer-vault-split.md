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

## Custodial Risk Analysis

### The Problem with Naïve Splitting

In Canton, a template's sole signatory has **unilateral authority** to create
instances of that template with arbitrary field values. If the Signer layer
templates (`PendingSignature`, `EcdsaSignature`, `EvmTxOutcomeSignature`) had
only `sigNetwork` as signatory, a compromised SigNetwork could:

1. **On-ledger**: `createCmd PendingSignature` directly — bypassing
   `SignAuthorization.Accept` entirely. Forge `EcdsaSignature` and
   `EvmTxOutcomeSignature` with arbitrary values.
2. **Off-ledger**: Derive child keys for any vault (the derivation uses
   `predecessorId` and `path`, both publicly observable on-ledger) and sign
   arbitrary EVM transactions — moving funds without any Canton record.

This makes SigNetwork **third-party custodial** over every DEX's funds.
Compared to the current model where each DEX (issuer) is self-custodial,
this is strictly worse: a single SigNetwork compromise would affect all
vaults across all DEXes.

### The Mitigation: Dual Signatories via Authority Flow

The fix is to **preserve the vault operators' signatory authority** on
`PendingSignature`. When `SignAuthorization.Accept` is exercised:

- `operators` authority comes from being signatories on `SignAuthorization`
- `sigNetwork` authority comes from being controller of `Accept`

The choice body has both parties' authority and can create
`PendingSignature` with `signatory sigNetwork :: operators`. Neither party
can create it alone — the only path is through the authorized workflow.

This uses the standard Daml **Multi-Party Agreement** pattern: authority
established at Vault creation (via a proposal/accept chain) propagates
through every downstream contract without re-signing.

### Vault Operators as a Multi-Sig

Vaults support multiple operator parties (`operators : [Party]`) for
distributed trust. All operators must agree at Vault creation time (via
`VaultProposal`), but subsequent operations (deposits, withdrawals) inherit
their combined authority automatically through nonconsuming choices.

### Malicious Participant: API-Layer Attack

The dual-signatory model protects the **ledger** but not the **API**.
The MPC service reads from SigNetwork's JSON Ledger API — if SigNetwork
patches its participant to inject fake events, the MPC signs
unauthorized transactions. This is the same attack vector as a malicious
Ethereum RPC endpoint. Canton has no light client protocol to prove
contract inclusion. See **MPC Trust Boundary: Malicious Participant
Attack** below for the full analysis and mitigation options.

### MPC Outcome Signing Over All Operators

The MPC must sign its outcome over **all** operator parties — not just a
single DEX identifier. The `computeRequestId` hash includes a
deterministic encoding of all operators, and the `computeResponseHash`
binds the MPC signature to the same set. This prevents an attacker from
stripping operators from the signed payload to weaken the multi-sig.

## Parties

| Party        | Role                        | Owns                |
| ------------ | --------------------------- | ------------------- |
| `sigNetwork` | MPC infrastructure provider | Signer              |
| `mpc`        | MPC service identity        | Observer everywhere |
| `operators`  | Vault operator parties (multi-sig) | Vault          |
| `user`       | End user (depositor/holder) | Exercises Vault     |

A vault can have one or more operator parties (e.g., `[dex1, dex2, dex3]`).
All operators must agree at Vault creation time via `VaultProposal`. Their
combined signatory authority flows through to `SignAuthorization` and
`PendingSignature` automatically.

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
        operators : [Party]
        requester : Party
        requestId : BytesHex
        r         : BytesHex
        s         : BytesHex
        v         : Int
      controller sigNetwork
      do
        create EcdsaSignature with
          sigNetwork; operators; requester; requestId; r; s; v

    nonconsuming choice ProvideOutcome : ContractId EvmTxOutcomeSignature
      with
        operators : [Party]
        requester : Party
        requestId : BytesHex
        signature : SignatureHex
        mpcOutput : BytesHex
      controller sigNetwork
      do
        create EvmTxOutcomeSignature with
          sigNetwork; operators; requester; requestId; signature; mpcOutput
```

### `SignAuthorization`

Proposal contract created by the Vault (signatory: `operators`), consumed
by SigNetwork. This is the handoff point — the Vault authorizes a signing
request, and the Signer picks it up.

The `metadata` field is opaque to the Signer. The Vault uses it to tag
requests (e.g., `"deposit"` vs `"withdrawal"`) and verifies it on claim to
prevent cross-flow confusion.

**Signatory authority flow**: `operators` are signatories (inherited from
the Vault), `sigNetwork` is controller of `Accept`. The `Accept` body has
both parties' authority, enabling creation of `PendingSignature` with
`signatory sigNetwork :: operators`.

```daml
template SignAuthorization
  with
    operators     : [Party]        -- vault operator multi-sig
    sigNetwork    : Party
    mpc           : Party
    requester     : Party          -- end user
    evmParams     : EvmTransactionParams
    predecessorId : Text           -- vault-computed: vaultId <> operatorsId
    path          : Text           -- deposit: sender,userPath; withdrawal: "root"
    nonceCidText  : Text           -- consumed contract ID as text (uniqueness nonce)
    keyVersion    : Int
    algo          : Text
    dest          : Text
    metadata      : Text           -- opaque to Signer, e.g. "deposit" or "withdrawal"
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators
    observer sigNetwork, mpc

    choice Accept : ContractId PendingSignature
      with
        signerCid : ContractId Signer
      controller sigNetwork
      do
        signer <- fetch signerCid
        assertMsg "Signer party mismatch" (signer.sigNetwork == sigNetwork)

        let caip2Id = "eip155:" <> chainIdToDecimalText evmParams.chainId
        let operatorsText = map partyToText operators
        let requestId = computeRequestId
              operatorsText         -- all operators (cross-vault isolation)
              requester
              evmParams caip2Id keyVersion path algo dest nonceCidText

        create PendingSignature with
          sigNetwork; mpc; operators; requester; requestId
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

**Dual signatory**: `sigNetwork :: operators`. Neither party can create
this contract alone — the only path is through `SignAuthorization.Accept`,
which requires both operators' authorization (signatory) and sigNetwork's
consent (controller).

```daml
template PendingSignature
  with
    sigNetwork    : Party
    mpc           : Party
    mpcPublicKey  : PublicKeyHex   -- copied from Signer at Accept time
    operators     : [Party]        -- vault operator multi-sig
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
    signatory sigNetwork :: operators  -- DUAL: neither party alone can create
    observer mpc, requester

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
          requestId; operators; requester; evmParams; metadata
          mpcOutput = outcome.mpcOutput
          ecdsaR = ecdsa.r; ecdsaS = ecdsa.s; ecdsaV = ecdsa.v
```

### `EcdsaSignature`

```daml
template EcdsaSignature
  with
    sigNetwork : Party
    operators  : [Party]
    requester  : Party
    requestId  : BytesHex
    r          : BytesHex
    s          : BytesHex
    v          : Int
  where
    signatory sigNetwork
    observer operators, requester
```

### `EvmTxOutcomeSignature`

```daml
template EvmTxOutcomeSignature
  with
    sigNetwork : Party
    operators  : [Party]
    requester  : Party
    requestId  : BytesHex
    signature  : SignatureHex
    mpcOutput  : BytesHex
  where
    signatory sigNetwork
    observer operators, requester
```

### `ClaimResult` (data record)

Returned by `ClaimOutcome` — the Vault uses this to create holdings or
process refunds.

```daml
data ClaimResult = ClaimResult
  with
    requestId : BytesHex
    operators : [Party]
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

### `VaultProposal`

Multi-party agreement contract for Vault creation. Uses the standard Daml
Pending pattern — each operator signs in sequence until all have agreed.

```daml
toSign : VaultProposal -> [Party]
toSign VaultProposal { alreadySigned, allOperators } =
  filter (`notElem` alreadySigned) allOperators

template VaultProposal
  with
    allOperators  : [Party]        -- the full set of operators for the Vault
    alreadySigned : [Party]        -- operators who have accepted so far
    sigNetwork    : Party
    mpc           : Party
    vaultAddress  : BytesHex
    vaultId       : Text
  where
    signatory alreadySigned
    observer allOperators
    ensure unique alreadySigned

    choice SignVault : Either (ContractId VaultProposal) (ContractId Vault)
      with signer : Party
      controller signer
      do
        assertMsg "Not an operator" (signer `elem` toSign this)
        let newSigned = signer :: alreadySigned
        if sort newSigned == sort allOperators
          then Right <$> create Vault with
            operators = allOperators; sigNetwork; mpc; vaultAddress; vaultId
          else Left <$> create this with alreadySigned = newSigned
```

### `Vault`

Replaces `VaultOrchestrator`. Domain-specific ERC20 custody. The
`sigNetwork` party is stored so the Vault can set it on
`SignAuthorization` contracts.

**Multi-sig**: `operators` is a list of parties who collectively control
the Vault. Created via `VaultProposal` — all operators must sign. Once
created, their combined signatory authority flows through every
nonconsuming choice without re-signing.

```daml
template Vault
  with
    operators    : [Party]         -- vault operator multi-sig
    sigNetwork   : Party
    mpc          : Party
    vaultAddress : BytesHex
    vaultId      : Text
  where
    signatory operators
    observer sigNetwork, mpc
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
        assertMsg "Auth card issuer mismatch" (auth.issuer `elem` operators)
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
        let operatorsId = concatMap partyToText (sort operators)
        let predecessorId = vaultId <> operatorsId

        create SignAuthorization with
          operators; sigNetwork; mpc; requester
          evmParams; predecessorId; path = fullPath; nonceCidText = authCidText
          keyVersion; algo; dest; metadata = "deposit"
          outputDeserializationSchema; respondSerializationSchema
```

### `ClaimEvmDeposit`

Exercises `PendingSignature.ClaimOutcome` to verify the MPC signature and
archive evidence. Then interprets the result for the deposit flow.

The `claimer` is set to `head operators` — any operator can claim on
behalf of the vault. The Vault's signatory authority (all operators)
propagates into the `ClaimOutcome` body because all operators are
signatories on `PendingSignature`.

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
          outcomeCid; ecdsaCid; claimer = head operators

        assertMsg "Not a deposit" (result.metadata == "deposit")
        assertMsg "Requester mismatch" (result.requester == requester)
        assertMsg "Operators mismatch" (sort result.operators == sort operators)

        assertMsg "MPC reported ETH transaction failure"
          (not (hasErrorPrefix result.mpcOutput))
        let success = abiDecodeBool result.mpcOutput 0
        assertMsg "ERC20 transfer returned false" success

        let amount = (result.evmParams).args !! 1
        create Erc20Holding with
          issuer = head operators
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
        assertMsg "Holding issuer mismatch" (holding.issuer `elem` operators)
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

        let operatorsId = concatMap partyToText (sort operators)
        let predecessorId = vaultId <> operatorsId

        create SignAuthorization with
          operators; sigNetwork; mpc; requester
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
          outcomeCid; ecdsaCid; claimer = head operators

        assertMsg "Not a withdrawal" (result.metadata == "withdrawal")
        assertMsg "Requester mismatch" (result.requester == requester)
        assertMsg "Operators mismatch" (sort result.operators == sort operators)

        let shouldRefund =
              if hasErrorPrefix result.mpcOutput then True
              else not (abiDecodeBool result.mpcOutput 0)

        if not shouldRefund
          then pure None
          else do
            let amount = (result.evmParams).args !! 1
            refundCid <- create Erc20Holding with
              issuer = head operators
              owner = requester
              erc20Address = (result.evmParams).to
              amount
            pure (Some refundCid)
```

### Auth Contracts (unchanged)

`DepositAuthProposal`, `DepositAuthorization`, and `Erc20Holding` are
unchanged from the current design. `issuer` on these contracts should be
one of the `operators` — validated via `elem` rather than exact equality
to support the multi-sig model.

## Cross-Vault Isolation

The `requestId` includes a deterministic hash of **all operator parties**
as the sender field. Since Canton party IDs are globally unique
(`hint::sha256(namespace_key)`), two different operator sets can never
produce the same `requestId` even with identical `evmParams`.

The operators list is sorted before hashing to ensure determinism
regardless of insertion order.

```
requestId = eip712Hash(keccak256(
    requestTypeHash
    <> hashText operatorsHash          -- cross-vault isolation (all operators)
    <> hashText (partyToText requester) -- cross-user isolation
    <> hashEvmParams evmParams
    <> hashText caip2Id
    <> padLeft (toHex keyVersion) 32
    <> hashText path
    <> hashText algo
    <> hashText dest
    <> hashText nonceCidText
))

where operatorsHash = keccak256(concat(sort(map partyToText operators)))
```

Note: `computeRequestId` signature changes — it now takes `[Text]`
(operator party texts) and `requester` separately instead of a single
`sender` text. The EIP-712 type hash must be updated to include the new
fields. Both Daml and TypeScript implementations must match.

## Deposit Lifecycle

```
 User                  Vault (Operators)       Signer (SigNetwork)     MPC Service              Sepolia
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
 |                     | SignAuthorization ---->|  (signatory: operators)                         |
 |                     |                       |                       |                         |
 |                     |                       |  5. MPC observes SignAuthorization               |
 |                     |                       |<--------------------->|                         |
 |                     |                       |  exercises Accept     |                         |
 |                     |                       |  → PendingSignature   |  (signatory: sigNetwork  |
 |                     |                       |                       |   + operators)           |
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
 |                     |                       |<-- EvmTxOutcomeSig ---|  (signs over operators) |
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
 |                     | checks operators match |                       |                         |
 |                     | abiDecodeBool == true  |                       |                         |
 |                     | creates Erc20Holding   |                       |                         |
 |                     |                       |                       |                         |
 |<-- Erc20Holding ----|                       |                       |                         |
```

## Withdrawal Lifecycle

```
 User                  Vault (Operators)       Signer (SigNetwork)     MPC Service              Sepolia
 |                     |                       |                       |                         |
 | 1. RequestEvmWithdrawal                     |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | validates Erc20Holding|                       |                         |
 |                     | archives it           |                       |                         |
 |                     | creates               |                       |                         |
 |                     | SignAuthorization ---->|  (signatory: operators)                         |
 |                     |   metadata="withdrawal"|                      |                         |
 |                     |                       |                       |                         |
 |                     |                       | 2. MPC: Accept        |                         |
 |                     |                       |  → PendingSignature   |  (signatory: sigNetwork  |
 |                     |                       |                       |   + operators)           |
 |                     |                       |                       | 3. sign + submit        |
 |                     |                       | 4. ProvideSignature   |                         |
 |                     |                       |<--- EcdsaSignature ---|                         |
 |                     |                       |                       |                         |
 | 5. submit signed tx |                       |                       |                         |
 |-------------------------------------------------------------------------- withdrawal tx ----->|
 |                     |                       |                       |                         |
 |                     |                       |                       | 6. poll + outcome       |
 |                     |                       | 7. ProvideOutcome     |  (signs over operators) |
 |                     |                       |<-- EvmTxOutcomeSig ---|                         |
 |                     |                       |                       |                         |
 | 8. CompleteEvmWithdrawal                    |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | ClaimOutcome -------->|                       |                         |
 |                     |<-- ClaimResult -------|                       |                         |
 |                     |                       |                       |                         |
 |                     | metadata="withdrawal" |                       |                         |
 |                     | checks operators match|                       |                         |
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

### MPC Outcome Signing Over All Operators

The MPC must include **all operator parties** in the data it signs. The
`requestId` already encodes operators via `operatorsHash` (see
Cross-Vault Isolation), so the `responseHash` transitively binds the MPC
signature to the full operator set:

```
responseHash = computeResponseHash(requestId, mpcOutput)
                                      ↑
                          includes operatorsHash
```

`ClaimOutcome` verifies the MPC signature against this `responseHash`.
If an attacker strips or modifies operators, the `requestId` won't match
what the MPC signed, and the verification fails. This ensures the MPC
threshold quorum has attested to the exact set of operators that
authorized the signing request.

## `computeRequestId` Changes

The function signature changes to accept a list of operator party texts
and a separate requester:

```daml
-- Before
computeRequestId : Text -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId sender evmParams caip2Id keyVersion path algo dest nonceCidText

-- After
computeRequestId : [Text] -> Party -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId operatorsText requester evmParams caip2Id keyVersion path algo dest nonceCidText
```

The operators are sorted and hashed together into a single `operatorsHash`
field. This ensures determinism regardless of list order and binds the
request to the exact multi-sig set:

```daml
let operatorsHash = keccak256 (concatMap toHex (sort operatorsText))
```

The EIP-712 struct type hash changes:

```
-- Before
CantonMpcDepositRequest(string sender,EvmTransactionParams evmParams,...)

-- After
CantonMpcSignRequest(bytes32 operatorsHash,string requester,EvmTransactionParams evmParams,...)
```

Both the Daml and TypeScript implementations must produce identical
hashes. The TypeScript side computes `operatorsHash` the same way:
`keccak256(concat(sort(operatorPartyTexts)))`.

## Authorization Flow (Daml)

### Why `SignAuthorization.Accept` works

`Accept` is a consuming choice on `SignAuthorization`:

- **Signatory**: `operators` (all vault operator parties)
- **Controller**: `sigNetwork`
- **Body authority**: `operators` (signatories) + `sigNetwork` (controller)
- Can create `PendingSignature` with `signatory sigNetwork :: operators` ✓
- Can fetch `Signer` (sigNetwork is signatory) ✓

This is the key custodial property: `PendingSignature` has **dual
signatories**. Neither `sigNetwork` alone nor `operators` alone can
create it — both must participate through the `SignAuthorization.Accept`
workflow.

### Why `Vault.ClaimEvmDeposit` → `PendingSignature.ClaimOutcome` works

`ClaimEvmDeposit` body runs with `operators` (Vault signatories) +
`user` (controller). It exercises `ClaimOutcome` with
`claimer = head operators`:

- `head operators` is a signatory on `PendingSignature` → can see it ✓
- `ClaimOutcome` controller is `claimer` (= `head operators`) → has
  authority ✓
- `ClaimOutcome` body has `sigNetwork` + `operators` (signatories) +
  `head operators` (controller) → can archive `EcdsaSignature` and
  `EvmTxOutcomeSignature` (signatory: `sigNetwork`) ✓

### Multi-party authority flow

```
VaultProposal (propose/sign/sign/finalize)
  → Vault (signatory: [op1, op2, op3])
    → RequestEvmDeposit (body: op1+op2+op3 + requester)
      → SignAuthorization (signatory: [op1, op2, op3])
        → Accept (body: op1+op2+op3 + sigNetwork)
          → PendingSignature (signatory: [sigNetwork, op1, op2, op3])
```

The operator authority established at Vault creation propagates through
the entire chain. No re-signing per transaction.

### Disclosed contracts

The Vault and Signer contracts are shared off-chain via disclosed contract
blobs — same pattern as the current `VaultOrchestrator`. The user's
command submission includes disclosed blobs for both the Vault and the
Signer (for the ClaimOutcome exercise chain).

## MPC Trust Boundary: Malicious Participant Attack

### The Problem

The dual-signatory model (`signatory sigNetwork :: operators`) and
multi-participant Canton Network protect the **virtual global ledger** —
a malicious SigNetwork participant cannot forge contracts with operator
signatories because the operators' Confirming Participant Nodes (CPNs)
would reject the transaction at the mediator level.

However, the MPC service does not read the virtual global ledger. It
reads SigNetwork's **JSON Ledger API** via WebSocket. This is analogous
to an off-chain service trusting a single Ethereum RPC endpoint: the
blockchain is fine, but the API layer can lie.

A malicious SigNetwork participant could:

1. Patch the JSON Ledger API to inject fake `CreatedEvent` into the
   WebSocket stream — contracts that were never confirmed by any
   operator participant
2. The MPC service validates only the `requestId` hash
   (`tx-handler.ts:137-153`) — it does NOT inspect
   `CreatedEvent.signatories`, does NOT verify the contract was created
   via an authorized choice, does NOT check who submitted it
3. If the `requestId` is correctly computed from the forged `evmParams`,
   all 8 MPC nodes (connected to the same participant) sign the
   specified EVM transaction
4. Attacker submits signed tx to Ethereum — funds stolen

Even though `SignAuthorization` carries `signatory operators` (the full
`[dex1, dex2, dex3]` array), this protection only exists at the ledger
level. At the API layer, SigNetwork's participant can serve fake events
claiming these operators signed when they never did. The MPC service
does not inspect `CreatedEvent.signatories` — it trusts whatever the
participant reports. This is why MPC nodes must read from multiple
Canton participants: distributing the read path across
operator-controlled nodes ensures no single participant can trick enough
nodes to reach the signing threshold.

The `secp256k1WithEcdsaOnly` verification at claim time does not help
because the damage happens at **signing time** — the MPC already signed
the transaction and funds already moved on Ethereum. The attacker never
needs to claim anything on Canton.

### MPC Service Must Validate Signatories

The current MPC service only validates the `requestId` hash
(`tx-handler.ts:137-153`). It must also validate the **transaction
metadata** from the Canton JSON Ledger API:

1. **Check `CreatedEvent.signatories`** — verify that the expected
   operator parties are actual signatories on the contract, not just
   field values. Canton's `CreatedEvent` response includes a
   `signatories` array populated by the participant — this is the
   on-ledger truth, not a user-supplied field.

2. **Check `CreatedEvent.witness_parties`** — verify that the operators
   are witnesses to the transaction (meaning their participants
   confirmed it).

3. **Cross-reference contract fields with metadata** — the `operators`
   field in the contract payload should match `CreatedEvent.signatories`.
   If SigNetwork forges a contract with `operators = [dex1, dex2]` but
   is the sole signatory, the metadata will show
   `signatories = [sigNetwork]` only — a mismatch the MPC must reject.

```typescript
// Proposed validation in tx-handler.ts
const created = event.CreatedEvent;
const onLedgerSignatories = new Set(created.signatories);
const claimedOperators = payload.operators as string[];

for (const op of claimedOperators) {
  if (!onLedgerSignatories.has(op)) {
    throw new Error(
      `Operator ${op} is in contract payload but not in ` +
      `CreatedEvent.signatories — possible forgery`
    );
  }
}
```

This validation is defense-in-depth: in single-participant mode, a
malicious participant could also forge the metadata. But combined with
multi-participant deployment (where metadata is populated from the
actual confirmation protocol), it closes the gap.

### Why Canton Cannot Provide Light Client Proofs

Unlike Ethereum (where a light client can verify Merkle proofs against
block headers), Canton's privacy-first architecture means:

- Each participant has a **Private Contract Store (PCS)** — there is no
  global state root to verify against
- The mediator collects confirm/reject verdicts but does not publish a
  global commitment
- Contract data is only sent to participants hosting involved parties
- Canton does exchange **ACS commitments** (periodic SHA-256 hashes of
  shared contract state) between participants, but these are
  participant-to-participant consistency checks, not client-facing proofs

There is no cryptographic primitive in Canton for a client to verify
"this contract was confirmed by participant X" without trusting the
participant serving the API.

### Mitigation Options

**Option A: Distribute MPC nodes across participants (recommended)**

Each MPC node connects to a **different** participant. The `mpc` party
is hosted with Observation permission on multiple participants (Canton
supports multi-hosting via `PartyToParticipant` topology mappings).

```
MPC Node 1 ──► DEX1's participant    (reads SignAuthorization)
MPC Node 2 ──► DEX2's participant    (reads SignAuthorization)
MPC Node 3 ──► SigNetwork's participant
MPC Node 4 ──► DEX1's participant
MPC Node 5 ──► DEX2's participant
MPC Node 6 ──► DEX3's participant
MPC Node 7 ──► SigNetwork's participant
MPC Node 8 ──► DEX3's participant
```

SigNetwork can only fool the nodes on its own participant (2 of 8). Not
enough for a 5-of-8 threshold — attack fails.

**Option B: MPC nodes cross-validate against multiple participants**

Each MPC node reads from SigNetwork's participant but queries a DEX
participant to verify the same contract exists before signing. This is
analogous to using multiple Ethereum RPC providers:

```
Each MPC node, before signing:
  1. Read SignAuthorization from SigNetwork's participant
  2. Query DEX's participant: does this contract exist?
  3. Only sign if both agree
```

**Option C: DEX participants as primary read source**

The `mpc` party is hosted on every DEX participant (Observation
permission). MPC nodes connect to DEX participants for reading — not
SigNetwork's. SigNetwork's participant is only used for writing
(`Accept`, `ProvideSignature`, `ProvideOutcome`).

This removes SigNetwork from the read path entirely.

### Phased Rollout

**v0 (PoC):** Single Canton participant operated by SigNetwork. The MPC
trusts SigNetwork's node — same trust model as the current
`VaultOrchestrator`. The dual-signatory model is in place but provides
defense-in-depth only (not full protection). Acceptable for PoC with a
known, trusted operator.

**v1 (Multi-participant):** Each DEX runs its own Canton participant.
The MPC `mpc` party is multi-hosted (Observation permission on DEX
participants). MPC nodes are distributed across participants so no
single operator controls the threshold. The dual-signatory model now
provides real security via Canton's confirmation protocol.

**v2 (Cross-validation):** MPC nodes cross-validate contracts against
multiple participants before signing. Defense-in-depth against
compromised participants even in multi-participant mode.

### Deployment Requirements

For the dual-signatory model to provide real security:

1. **Each DEX must run its own Canton participant** — if all parties
   share one participant operated by SigNetwork, the signatory model is
   purely cosmetic (the operator can forge any contract)
2. **The `mpc` party must be multi-hosted** — hosted on DEX participants
   with Observation permission so MPC nodes can read from trusted sources
3. **MPC threshold must span multiple data sources** — nodes connected
   to the same participant are in the same trust domain

Without multi-participant deployment, the dual-signatory model provides
**no security** — it's enforced by the participant, and if SigNetwork is
the participant, it enforces its own rules.

### Canton Architecture References

- [Parties and Users on a Canton Ledger](https://docs.digitalasset.com/build/3.5/explanations/parties-users.html) — party hosting model
- [External Signing Overview](https://docs.digitalasset.com/build/3.4/explanations/external-signing/external_signing_overview.html) — Confirming Participant Nodes (CPNs) and validation flow
- [Onboard External Party (Multi-Hosted)](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_onboarding_multihosted.html) — hosting a party on multiple participants
- [Local and External Parties](https://docs.digitalasset.com/overview/3.4/explanations/canton/external-party.html) — trust model for external parties
- [Topology Management](https://docs.digitalasset.com/overview/3.4/explanations/canton/topology.html) — `PartyToParticipant` mappings
- [Canton Security Model](https://docs.digitalasset.com/overview/3.4/explanations/canton/security.html) — cryptographic keys and validation
- [Glossary: Virtual Global Ledger](https://docs.digitalasset.com/build/3.4/reference/glossary) — each participant holds a fragment of the virtual ledger; Canton protocol guarantees consistency
- [Glossary: Mediator](https://docs.digitalasset.com/build/3.4/reference/glossary) — commit coordinator that aggregates participant verdicts without seeing contract contents

## Open Questions

1. **Separate DARs or single DAR?** — The Signer and Vault could be
   separate DAR packages (different SDK versions, independent deployment)
   or modules within the same DAR (simpler codegen, shared types). Separate
   DARs is cleaner architecturally but requires cross-DAR type sharing for
   `EvmTransactionParams`, `ClaimResult`, etc.

2. **`metadata` typing** — Currently `Text` for simplicity. Could be a
   typed enum if we want compile-time safety, but that couples the Signer
   to vault concepts. `Text` keeps the Signer generic.

3. **`issuer` on auth/holding contracts** — `DepositAuthorization` and
   `Erc20Holding` use `issuer : Party`. With multi-sig operators, `issuer`
   should be one of the operators (validated via `elem`). Alternatively,
   these could be changed to `operators : [Party]` with `signatory
   operators`, but that requires the full multi-party authority at holding
   creation — which the Vault's nonconsuming choices already provide.

4. **`requestId` computation location** — The Signer computes requestId
   (in `Accept`). The Vault doesn't know the `requestId` at
   `SignAuthorization` creation time. Correlation uses `nonceCidText`
   (consumed contract ID, globally unique).

5. **Multiple Signers** — Should the Vault support switching between
   Signers (e.g., key rotation)? Currently the `sigNetwork` party is fixed
   on the Vault. A `UpdateSigner` choice could handle this.

6. **Operator changes** — Adding or removing operators requires creating a
   new Vault (new multi-party agreement). An `UpdateOperators` choice with
   a proposal/accept sub-flow could allow operator rotation without
   re-creating the Vault, but adds complexity.

7. **`head operators` as claimer** — `ClaimEvmDeposit` and
   `CompleteEvmWithdrawal` use `head operators` as the `claimer` party.
   This works because all operators are signatories on `PendingSignature`
   and any one of them can exercise `ClaimOutcome`. If a specific operator
   ordering matters, the Vault should enforce `sort operators` at creation.

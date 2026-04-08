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
2. **Vault operations** — ERC20 deposits, holdings, sweep validation,
   refund logic

Problems:

- A new vault type (BTC, NFT, swap) requires duplicating the entire signing
  layer
- The MPC service is coupled to vault-specific contract types
  (`PendingEvmTx`, `TxSource`)
- A single operator (`issuer`) controls both signing and custody — no
  separation between infrastructure provider and application

## Custodial Risk Analysis

### The Problem with Naïve Splitting

In Canton, a template's sole signatory has **unilateral authority** to
create instances of that template with arbitrary field values. If
`SignBidirectionalEvent` had only `sigNetwork` as signatory, a
compromised SigNetwork could forge sign requests and trick the MPC
into signing arbitrary EVM transactions.

### The Mitigation: Operator + Requester Signatories

`SignBidirectionalEvent` has `signatory operators, requester` — sigNetwork
is only an **observer**. SigNetwork cannot create sign requests at all.
The only path is through the Vault's `RequestDeposit` →
create `SignRequest` + exercise `Signer.SignBidirectional` → `SignRequest.Execute` flow, which requires
both operators' authority (Vault signatories) and requester's authority
(controller).

SigNetwork cannot forge `SignBidirectionalEvent` — only a `requester`
with the `operators`' signatory authority (via the Vault) can initiate a
signing request to SigNetwork.

This uses Daml's **flexible controllers** and a create + exercise delegation pattern:
authority established at Vault creation propagates through the atomic
transaction without re-signing.

### Vault Operators as a Multi-Sig

Vaults support multiple operator parties (`operators : [Party]`) for
distributed trust. All operators must agree at Vault creation time (via
`VaultProposal`), but subsequent operations (deposits, withdrawals) inherit
their combined authority automatically through nonconsuming choices.

#### Why `[Party]`, not `Party | [Party]`

Daml has no union types. A template field must be a single concrete type.
Daml does support sum types (variants) — e.g.,
`data Operators = Single Party | Multiple [Party]` — but using a variant
for signatories would require pattern-matching at every use site, and the
`signatory` keyword expects `Party` or `[Party]`, not a custom sum type.

The idiomatic Daml pattern (documented in the official
[Multi-Party Agreement Pattern](https://docs.daml.com/daml/patterns/multiparty-agreement.html))
is `operators : [Party]` with `signatory operators`. A single operator
is represented as `[operator]`. The `ensure` clause enforces
`not (null operators) && unique operators`, guaranteeing at least one
operator with no duplicates.

### Malicious Participant: API-Layer Attack

The multi-signatory model protects the **ledger** but not the **API**.
The MPC service reads from SigNetwork's JSON Ledger API — if SigNetwork
patches its participant to inject fake events, the MPC signs
unauthorized transactions. This is the same attack vector as a malicious
Ethereum RPC endpoint. Canton has no light client protocol to prove
contract inclusion. See **MPC Trust Boundary: Malicious Participant
Attack** below for the full analysis and mitigation options.

## Parties

| Party        | Role                               | Owns   |
| ------------ | ---------------------------------- | ------ |
| `sigNetwork` | MPC infrastructure (single party)  | Signer |
| `operators`  | Vault operator multi-sig `[Party]` | Vault  |
| `requester`  | End user (depositor/holder)        | —      |

`sigNetwork` is both the MPC party identity AND the Signer operator.
No separate `mpc` party. `sigNetwork` is the sole signatory on
`SigningNonce` — the MPC sees the nonce archive in the same
transaction as the `SignBidirectionalEvent` without needing observer
rights on domain contracts. A vault can have one or more operator
parties (e.g., `[dex1, dex2, dex3]`). All operators must agree at Vault
creation time via `VaultProposal`.

## Contract Overview

Names follow the Solana/Hydration MPC convention. See
`proposals/naming-alignment.md` for the full mapping.

### Signer Layer (matches Solana `signet_program`)

```
Signer (singleton)                    ← sigNetwork deploys, shares blob off-chain
  │
  ├── IssueNonce choice              ← requester self-serves replay-prevention nonces
  │     controller: requester (flexible)
  │
  ├── SignBidirectional choice        ← requester exercises (via Vault), consumes SignRequest,
  │     controller: requester (flexible)    creates SignBidirectionalEvent
  │
  ├── Respond choice                  ← sigNetwork exercises after signing EVM tx,
  │     controller: sigNetwork           creates SignatureRespondedEvent
  │
  └── RespondBidirectional choice     ← sigNetwork exercises after chain confirmation,
        controller: sigNetwork           creates RespondBidirectionalEvent

SigningNonce                          ← replay-prevention nonce (signatory: sigNetwork)
SignRequest (transient)               ← created, then consumed via Signer.SignBidirectional → Execute
                                         SignBidirectional archives SigningNonce, Execute creates event
SignBidirectionalEvent                ← what MPC watches (signatory: operators, requester)
SignatureRespondedEvent               ← ECDSA signature evidence (signatory: sigNetwork)
RespondBidirectionalEvent             ← outcome signature evidence (signatory: sigNetwork)
```

### Vault Layer (Canton-specific, domain ERC20 custody)

```
Vault (singleton)                     ← operators deploy via VaultProposal
  │
  ├── RequestDeposit                  ← requester deposits, atomic create + exercise
  │                                      SignRequest → Signer.SignBidirectional
  │                                      → SignBidirectionalEvent
  ├── ClaimDeposit                    ← requester verifies MPC sig → Erc20Holding
  ├── RequestWithdrawal               ← requester burns holding, same atomic flow
  └── CompleteWithdrawal              ← requester verifies MPC sig → refund or finalize

Erc20Holding (domain contract)
```

## Signer Contracts

### `Signer`

Singleton identity contract. Shared off-chain via disclosed contracts —
any party with the blob can exercise choices on it. `sigNetwork` is the
sole signatory (MPC infrastructure). No public key here — that's
per-vault on the `Vault` template.

```daml
template Signer
  with
    sigNetwork : Party
  where
    signatory sigNetwork

    nonconsuming choice IssueNonce : ContractId SigningNonce
      with
        requester : Party
      controller requester
      do
        create SigningNonce with sigNetwork; requester

    nonconsuming choice SignBidirectional
      : (ContractId SignBidirectionalEvent, ContractId SigningNonce)
      with
        signRequestCid : ContractId SignRequest
        nonceCid       : ContractId SigningNonce  -- consumed and rotated
        requester      : Party          -- flexible controller
      controller requester
      do
        -- Validate nonce was issued by this Signer's sigNetwork for this requester
        nonce <- fetch nonceCid
        assertMsg "Nonce sigNetwork mismatch" (nonce.sigNetwork == sigNetwork)
        assertMsg "Nonce requester mismatch" (nonce.requester == requester)
        -- Archive old nonce
        archive nonceCid
        -- Delegate to SignRequest.Execute to get operators authority
        eventCid <- exercise signRequestCid Execute
        -- Issue fresh nonce for the next request (atomic rotation)
        newNonceCid <- create SigningNonce with sigNetwork; requester
        pure (eventCid, newNonceCid)

    nonconsuming choice Respond : ContractId SignatureRespondedEvent
      with
        operators : [Party]
        requester : Party
        requestId : BytesHex
        signature : SignatureHex        -- DER-encoded ECDSA signature
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
        signature        : SignatureHex -- DER-encoded MPC outcome signature
      controller sigNetwork
      do
        create RespondBidirectionalEvent with
          sigNetwork; operators; requester; requestId
          responder = sigNetwork; serializedOutput; signature
```

### `SigningNonce`

Replay-prevention nonce with atomic rotation. The requester issues the
first nonce via `Signer.IssueNonce`, and each `SignBidirectional` call
archives the old nonce and creates a fresh one — so the requester
always has a nonce ready for the next request without an extra
transaction. The `Consume_SigningNonce` choice lets the requester
discard unused nonces.

The nonce is pure infrastructure — no domain semantics.

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

Created in the Vault's `RequestDeposit` choice body, then consumed by
`Signer.SignBidirectional` → `SignRequest.Execute`. The MPC never sees
this template — it exists only to carry operator authority across the
Vault→Signer boundary (Daml equivalent of Solana CPI).

The `Execute` choice is the authority bridge: it runs with `operators`
(SignRequest signatory) + `requester` (controller) — exactly the authority
needed to create `SignBidirectionalEvent`.

```daml
template SignRequest
  with
    operators                  : [Party]
    requester                  : Party
    sigNetwork                 : Party
    sender                     : Text   -- predecessorId = vaultId <> keccak256(sort(operators)), for KDF
    evmTxParams                : EvmTransactionParams
    caip2Id                    : Text
    keyVersion                 : Int
    path                       : Text
    algo                       : Text
    dest                       : Text
    params                     : Text
    nonceCidText               : Text   -- text representation for requestId hash
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators
    observer sigNetwork
    ensure not (null operators) && unique operators

    choice Execute : ContractId SignBidirectionalEvent
      controller requester
      do
        -- body authority: operators (signatory) + requester (controller)
        create SignBidirectionalEvent with
          operators; requester; sigNetwork; sender
          evmTxParams; caip2Id; keyVersion; path; algo; dest; params
          nonceCidText
          outputDeserializationSchema; respondSerializationSchema
```

### `SignBidirectionalEvent`

The sign request template. Created by `SignRequest.Execute` (delegated
from `Signer.SignBidirectional`).
This is what the MPC watches — equivalent to Solana's
`SignBidirectionalEvent`.

```daml
template SignBidirectionalEvent
  with
    operators                  : [Party]
    requester                  : Party
    sigNetwork                 : Party
    sender                     : Text   -- predecessorId = vaultId <> keccak256(sort(operators)), for KDF
    evmTxParams                : EvmTransactionParams
    caip2Id                    : Text
    keyVersion                 : Int
    path                       : Text
    algo                       : Text
    dest                       : Text
    params                     : Text
    nonceCidText               : Text   -- consumed contract ID (replay prevention)
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

MPC delivers the ECDSA signature. Equivalent to Solana's
`SignatureRespondedEvent`. Includes a `Consume` choice so the Vault
can archive it at claim time (the Vault body doesn't have `sigNetwork`
authority to `archive` directly).

```daml
template SignatureRespondedEvent
  with
    sigNetwork : Party
    operators  : [Party]
    requester  : Party
    requestId  : BytesHex
    responder  : Party
    signature  : SignatureHex           -- DER-encoded ECDSA signature
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

MPC delivers the outcome signature after EVM execution confirmation.
Equivalent to Solana's `RespondBidirectionalEvent`. Same `Consume`
pattern for Vault-side cleanup.

```daml
template RespondBidirectionalEvent
  with
    sigNetwork       : Party
    operators        : [Party]
    requester        : Party
    requestId        : BytesHex
    responder        : Party
    serializedOutput : BytesHex
    signature        : SignatureHex     -- DER-encoded MPC outcome signature
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
    allOperators    : [Party]
    alreadySigned   : [Party]
    sigNetwork      : Party
    evmVaultAddress : BytesHex
    evmMpcPublicKey : PublicKeyHex
    vaultId         : Text
  where
    signatory alreadySigned
    observer allOperators
    ensure not (null allOperators) && unique allOperators && unique alreadySigned

    choice SignVault : Either (ContractId VaultProposal) (ContractId Vault)
      with signer : Party
      controller signer
      do
        assertMsg "Not an operator" (signer `elem` toSign this)
        let newSigned = signer :: alreadySigned
        if sort newSigned == sort allOperators
          then Right <$> create Vault with
            operators = allOperators; sigNetwork
            evmVaultAddress; evmMpcPublicKey; vaultId
          else Left <$> create this with alreadySigned = newSigned
```

### `Vault`

Replaces `VaultOrchestrator`. Domain-specific ERC20 custody.
`evmMpcPublicKey` is per-vault (each vault has its own derived MPC key).

```daml
template Vault
  with
    operators       : [Party]
    sigNetwork      : Party
    evmVaultAddress : BytesHex
    evmMpcPublicKey : PublicKeyHex
    vaultId         : Text
  where
    signatory operators
    observer sigNetwork
    ensure not (null operators) && unique operators
```

### `PendingDeposit`

Vault-layer anchor for an in-flight deposit. Created by `RequestDeposit`,
consumed by `ClaimDeposit`. Guarantees single-use via archive.

```daml
template PendingDeposit
  with
    operators   : [Party]
    requester   : Party
    sigNetwork  : Party
    requestId   : BytesHex
    evmTxParams : EvmTransactionParams
  where
    signatory operators
    observer requester, sigNetwork
    ensure not (null operators)
```

### `PendingWithdrawal`

Same pattern for withdrawals. Carries the holding info for refund.

```daml
template PendingWithdrawal
  with
    operators    : [Party]
    requester    : Party
    sigNetwork   : Party
    requestId    : BytesHex
    evmTxParams  : EvmTransactionParams
    erc20Address : BytesHex
    amount       : BytesHex
  where
    signatory operators
    observer requester, sigNetwork
    ensure not (null operators)
```

### `RequestDeposit`

Atomically creates `SignBidirectionalEvent` (via Signer, which archives
the `SigningNonce`) AND `PendingDeposit` (on Vault). The user calls one
choice — everything chains internally.

```daml
    nonconsuming choice RequestDeposit
      : (ContractId SignBidirectionalEvent, ContractId PendingDeposit, ContractId SigningNonce)
      with
        requester    : Party
        signerCid    : ContractId Signer   -- disclosed contract
        path         : Text
        evmTxParams  : EvmTransactionParams
        nonceCid     : ContractId SigningNonce  -- Signer-layer nonce
        nonceCidText : Text    -- text representation (MPC verifies off-chain)
        keyVersion   : Int
        algo       : Text
        dest       : Text
        params     : Text
        outputDeserializationSchema : Text
        respondSerializationSchema  : Text
      controller requester
      do
        let recipientArg = case evmTxParams.args of
              recipient :: _ -> recipient
              [] -> ""
        assertMsg "Only ERC20 transfer allowed"
          (evmTxParams.functionSignature == "transfer(address,uint256)")
        assertMsg "Transfer recipient must be vault address"
          (recipientArg == evmVaultAddress)

        let fullPath = partyToText requester <> "," <> path
        let caip2Id = "eip155:" <> chainIdToDecimalText evmTxParams.chainId
        let operatorsHash = computeOperatorsHash (map partyToText operators)
        let predecessorId = vaultId <> operatorsHash

        -- Step 1: Create SignRequest (needs operators authority)
        signReqCid <- create SignRequest with
          operators; requester; sigNetwork
          evmTxParams; sender = predecessorId; caip2Id; keyVersion
          path = fullPath; algo; dest; params
          nonceCidText
          outputDeserializationSchema; respondSerializationSchema

        -- Step 2: Exercise Signer.SignBidirectional (needs requester authority)
        -- Signer archives the nonce (sigNetwork authority), then delegates
        -- to SignRequest.Execute which creates SignBidirectionalEvent
        (signEventCid, newNonceCid) <- exercise signerCid SignBidirectional with
          signRequestCid = signReqCid; nonceCid; requester

        -- Compute requestId for the pending anchor
        let requestId = computeRequestId
              predecessorId evmTxParams caip2Id keyVersion
              fullPath algo dest params nonceCidText

        -- Create vault-layer anchor (consumed at claim time)
        pendingCid <- create PendingDeposit with
          operators; requester; sigNetwork; requestId; evmTxParams

        pure (signEventCid, pendingCid, newNonceCid)
```

### `ClaimDeposit`

Consumes `PendingDeposit` (single-use guarantee), verifies the MPC
signature, creates `Erc20Holding`.

```daml
    nonconsuming choice ClaimDeposit : ContractId Erc20Holding
      with
        requester                    : Party
        pendingDepositCid            : ContractId PendingDeposit
        respondBidirectionalEventCid : ContractId RespondBidirectionalEvent
        signatureRespondedEventCid   : ContractId SignatureRespondedEvent
      controller requester
      do
        pending <- fetch pendingDepositCid
        archive pendingDepositCid           -- single-use guarantee

        assertMsg "Sender mismatch" (pending.requester == requester)
        assertMsg "Operators mismatch" (sort pending.operators == sort operators)

        outcome <- fetch respondBidirectionalEventCid
        assertMsg "Outcome requestId mismatch"
          (outcome.requestId == pending.requestId)

        let responseHash = computeResponseHash pending.requestId outcome.serializedOutput
        assertMsg "Invalid MPC signature"
          (secp256k1WithEcdsaOnly outcome.signature responseHash evmMpcPublicKey)

        assertMsg "MPC reported ETH transaction failure"
          (not (hasErrorPrefix outcome.serializedOutput))
        let success = abiDecodeBool outcome.serializedOutput 0
        assertMsg "ERC20 transfer returned false" success

        exercise respondBidirectionalEventCid Consume_RespondBidirectional with actor = requester
        exercise signatureRespondedEventCid Consume_SignatureResponded with actor = requester

        let amount = (pending.evmTxParams).args !! 1
        create Erc20Holding with
          operators
          owner = requester
          erc20Address = (pending.evmTxParams).to
          amount
```

### `RequestWithdrawal`

Archives the `Erc20Holding` (optimistic debit), same atomic flow as
`RequestDeposit`. Creates `SignBidirectionalEvent` + `PendingWithdrawal`.

```daml
    nonconsuming choice RequestWithdrawal
      : (ContractId SignBidirectionalEvent, ContractId PendingWithdrawal, ContractId SigningNonce)
      with
        requester        : Party
        signerCid        : ContractId Signer
        evmTxParams      : EvmTransactionParams
        recipientAddress : BytesHex
        balanceCid       : ContractId Erc20Holding
        nonceCid         : ContractId SigningNonce  -- Signer-layer nonce
        nonceCidText     : Text    -- text representation (MPC verifies off-chain)
        keyVersion       : Int
        algo             : Text
        dest             : Text
        params           : Text
        outputDeserializationSchema : Text
        respondSerializationSchema  : Text
      controller requester
      do
        holding <- fetch balanceCid
        assertMsg "Holding operators mismatch" (sort holding.operators == sort operators)
        assertMsg "Holding owner mismatch" (holding.owner == requester)

        let recipientArg = case evmTxParams.args of
              recipient :: _ -> recipient
              [] -> ""
        let amountArg = evmTxParams.args !! 1

        assertMsg "Only ERC20 transfer allowed"
          (evmTxParams.functionSignature == "transfer(address,uint256)")
        assertMsg "ERC20 contract must match holding"
          (evmTxParams.to == holding.erc20Address)
        assertMsg "Transfer recipient must match"
          (recipientArg == recipientAddress)
        assertMsg "Withdraw amount must match holding"
          (amountArg == holding.amount)

        archive balanceCid

        let caip2Id = "eip155:" <> chainIdToDecimalText evmTxParams.chainId
        let operatorsHash = computeOperatorsHash (map partyToText operators)
        let predecessorId = vaultId <> operatorsHash

        signReqCid <- create SignRequest with
          operators; requester; sigNetwork
          evmTxParams; sender = predecessorId; caip2Id; keyVersion
          path = "root"; algo; dest; params
          nonceCidText
          outputDeserializationSchema; respondSerializationSchema

        (signEventCid, newNonceCid) <- exercise signerCid SignBidirectional with
          signRequestCid = signReqCid; nonceCid; requester

        let requestId = computeRequestId
              predecessorId evmTxParams caip2Id keyVersion
              "root" algo dest params nonceCidText

        pendingCid <- create PendingWithdrawal with
          operators; requester; sigNetwork; requestId; evmTxParams
          erc20Address = holding.erc20Address
          amount = holding.amount

        pure (signEventCid, pendingCid, newNonceCid)
```

### `CompleteWithdrawal`

Consumes `PendingWithdrawal`. On failure, refunds the holding.

```daml
    nonconsuming choice CompleteWithdrawal : Optional (ContractId Erc20Holding)
      with
        requester                    : Party
        pendingWithdrawalCid         : ContractId PendingWithdrawal
        respondBidirectionalEventCid : ContractId RespondBidirectionalEvent
        signatureRespondedEventCid   : ContractId SignatureRespondedEvent
      controller requester
      do
        pending <- fetch pendingWithdrawalCid
        archive pendingWithdrawalCid        -- single-use guarantee

        assertMsg "Sender mismatch" (pending.requester == requester)
        assertMsg "Operators mismatch" (sort pending.operators == sort operators)

        outcome <- fetch respondBidirectionalEventCid
        assertMsg "Outcome requestId mismatch"
          (outcome.requestId == pending.requestId)

        let responseHash = computeResponseHash pending.requestId outcome.serializedOutput
        assertMsg "Invalid MPC signature"
          (secp256k1WithEcdsaOnly outcome.signature responseHash evmMpcPublicKey)

        exercise respondBidirectionalEventCid Consume_RespondBidirectional with actor = requester
        exercise signatureRespondedEventCid Consume_SignatureResponded with actor = requester

        let shouldRefund =
              hasErrorPrefix outcome.serializedOutput
                || not (abiDecodeBool outcome.serializedOutput 0)

        if not shouldRefund
          then pure None
          else do
            refundCid <- create Erc20Holding with
              operators
              owner = requester
              erc20Address = pending.erc20Address
              amount = pending.amount
            pure (Some refundCid)
```

### `Erc20Holding`

Tracks on-ledger ERC20 balances per user. `sigNetwork` is NOT an
observer — nonce verification uses `SigningNonce` (Signer layer), so
domain contracts stay decoupled from MPC infrastructure.

```daml
template Erc20Holding
  with
    operators    : [Party]
    owner        : Party
    erc20Address : BytesHex
    amount       : BytesHex
  where
    signatory operators
    observer owner
```

## Cross-Vault Isolation

The `requestId` includes a deterministic hash of **all operator parties**
plus the `requester`. Since Canton party IDs are globally unique
(`hint::sha256(namespace_key)`), two different operator sets can never
produce the same `requestId` even with identical `evmTxParams`.

The operators list is sorted before hashing to ensure determinism.
See `requestId` Computation below for the full formula.

## Deposit Lifecycle

```
 Sender                Vault (Operators)       Signer (SigNetwork)     MPC (sigNetwork)         Sepolia
 |                     |                       |                       |                         |
 | 1. IssueNonce       |                       |                       |                         |
 |--------------------------------------------►| requester creates     |                         |
 |                     |                       |   SigningNonce         |                         |
 |<--------------------------------------------|   (via disclosed Signer)                        |
 |                     |                       |                       |                         |
 | 2. ERC20 transfer to deposit address        |                       |                         |
 |------------------------------------------------------------------------------ transfer ------>|
 |                     |                       |                       |                         |
 | 3. RequestDeposit(nonceCid, ...)            |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | create + exercise:    |                       |                         |
 |                     | SignRequest ──────────► SignBidirectional      |                         |
 |                     |                       | → Execute:            |                         |
 |                     |                       |   archives SigningNonce                         |
 |                     |                       |   creates SignBidirectionalEvent                 |
 |                     | + PendingDeposit      |   (signatory: operators, requester)              |
 |                     |   (vault anchor)      |                       |                         |
 |                     |                       |                       |                         |
 |                     |                       |                       | 6. observes event       |
 |                     |                       |                       |    verifies nonce       |
 |                     |                       |                       |    derives child key    |
 |                     |                       |                       |    threshold sign       |
 |                     |                       |                       |                         |
 |                     |                       | 7. Respond            |                         |
 |                     |                       |<- SignatureResponded -|                         |
 |                     |                       |                       |                         |
 | 8. observes SignatureRespondedEvent         |                       |                         |
 |<--------------------------------------------|                       |                         |
 |    reconstructSignedTx, eth_sendRawTransaction                      |                         |
 |------------------------------------------------------------------------------ sweep tx ------>|
 |                     |                       |                       |                         |
 |                     |                       |                       | 9. polls Sepolia        |
 |                     |                       |                       |    re-simulates call    |
 |                     |                       |                       |                         |
 |                     |                       | 10. RespondBidirectional                        |
 |                     |                       |<- RespondBidirectional-|  (signs over operators) |
 |                     |                       |   Event               |                         |
 |                     |                       |                       |                         |
 | 11. ClaimDeposit    |                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | archives PendingDeposit (single-use)          |                         |
 |                     | verifies MPC sig      |                       |                         |
 |                     |   via evmMpcPublicKey  |                       |                         |
 |                     | creates Erc20Holding  |                       |                         |
 |                     |                       |                       |                         |
 |<-- Erc20Holding ----|                       |                       |                         |
```

## Withdrawal Lifecycle

```
 Sender                Vault (Operators)       Signer (SigNetwork)     MPC (sigNetwork)         Sepolia
 |                     |                       |                       |                         |
 | 0. IssueNonce       |                       |                       |                         |
 |--------------------------------------------►| requester creates     |                         |
 |                     |                       |   SigningNonce         |                         |
 |<--------------------------------------------|   (via disclosed Signer)                        |
 |                     |                       |                       |                         |
 | 1. RequestWithdrawal(nonceCid, ...)         |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | validates + archives  |                       |                         |
 |                     |   Erc20Holding        |                       |                         |
 |                     | create + exercise:    |                       |                         |
 |                     | SignRequest ──────────► SignBidirectional      |                         |
 |                     |                       | → Execute:            |                         |
 |                     |                       |   archives SigningNonce                         |
 |                     |                       |   creates SignBidirectionalEvent                 |
 |                     | + PendingWithdrawal   |                       |                         |
 |                     |                       |                       |                         |
 |                     |                       |                       | 2. threshold sign       |
 |                     |                       | 3. Respond            |                         |
 |                     |                       |<- SignatureResponded -|                         |
 |                     |                       |                       |                         |
 | 4. submit signed tx |                       |                       |                         |
 |-------------------------------------------------------------------------- withdrawal tx ----->|
 |                     |                       |                       |                         |
 |                     |                       |                       | 5. poll + outcome       |
 |                     |                       | 6. RespondBidirectional                         |
 |                     |                       |<- RespondBidirectional-|                         |
 |                     |                       |   Event               |                         |
 |                     |                       |                       |                         |
 | 7. CompleteWithdrawal                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | archives PendingWithdrawal (single-use)       |                         |
 |                     | verifies MPC sig      |                       |                         |
 |                     | success? → None       |                       |                         |
 |                     | failure? → refund     |                       |                         |
 |                     |   Erc20Holding        |                       |                         |
 |<-- result ----------|                       |                       |                         |
```

## MPC Service Changes

The MPC service becomes fully generic — it watches
`SignBidirectionalEvent` (same name as Solana/Hydration) and exercises
Signer choices (`Respond`, `RespondBidirectional`). It has no knowledge
of deposits, withdrawals, or ERC20 concepts.

### Current Flow (vault-coupled)

1. Watch `PendingEvmTx` via WebSocket stream
2. Read `vaultId`, `issuer`, `path` from PendingEvmTx payload
3. Derive child key: `predecessorId = vaultId + partyToText issuer`
4. Sign EVM tx → exercise `VaultOrchestrator.SignEvmTx`
5. Poll chain → exercise `VaultOrchestrator.ProvideEvmOutcomeSig`

### New Flow (matches Solana/Hydration pattern)

1. Watch `SignBidirectionalEvent` via WebSocket stream
2. Validate transaction metadata (signatories, witness parties)
3. Verify `nonceCidText` matches an archived `SigningNonce` in same tx
4. Read `operators`, `requester`, `path`, `keyVersion` from event payload
5. Derive child key using `derive_epsilon_canton()`
6. Threshold sign the EVM tx hash
7. Exercise `Signer.Respond` → creates `SignatureRespondedEvent`
8. Watch EVM for execution confirmation
9. Exercise `Signer.RespondBidirectional` → creates `RespondBidirectionalEvent`

The MPC never sees `SignRequest` (transient) or domain contracts
(`Erc20Holding`). It only sees `SignBidirectionalEvent` and
`SigningNonce` — both Signer-layer contracts.

### KDF Chain ID

The KDF uses `canton:global` as the source chain CAIP-2 ID (not
`eip155:1`). The derivation path is:

```
"sig.network v2.0.0 epsilon derivation:canton:global:{predecessorId}:{path}"
```

The KDF always uses the SOURCE chain (where the request originates), not
the destination chain. Canton requests use `canton:global`. This is
exported as `constants.KDF_CHAIN_IDS.CANTON` from `signet.js@0.4.1` and
must match `Chain::Canton.caip2_chain_id()` in the Rust MPC node.

### Signature Format

Canton/Daml's `secp256k1WithEcdsaOnly` builtin only accepts DER-encoded
`SignatureHex`. There is no Daml builtin for verifying structured `(r, s)`
components. The MPC DER-encodes signatures before publishing to Canton.
This is why we use `SignatureHex` (DER-encoded) instead of Solana's
`AffinePoint { bigR, s, recoveryId }` struct.

### MPC Outcome Signing Over All Operators

The MPC must include **all operator parties** in the data it signs. The
`requestId` already encodes operators via `operatorsHash` (see
Cross-Vault Isolation), so the `responseHash` transitively binds the MPC
signature to the full operator set:

```
responseHash = keccak256(assertBytes32 requestId <> safeKeccak256 serializedOutput)
-- requestId transitively includes operatorsHash (from computeRequestId)
```

`ClaimDeposit`/`CompleteWithdrawal` verifies the MPC signature against
this `responseHash` using `evmMpcPublicKey` from the Vault. If an
attacker strips or modifies operators, the `requestId` won't match
what the MPC signed, and the verification fails.

## `requestId` Computation

Uses Keccak256 over ABI-packed encoding of all fields — same approach
as Solana/Hydration (`generate_request_id()` in the MPC node). The
`operators` are sorted and hashed into a single `operatorsHash` for
determinism:

```
requestId = keccak256(
       hashText sender             -- sender = predecessorId = vaultId <> operatorsHash
    <> hashEvmParams evmTxParams
    <> hashText caip2Id
    <> padLeft (toHex keyVersion) 32
    <> hashText path
    <> hashText algo
    <> hashText dest
    <> hashText params
    <> hashText nonceCidText       -- consumed contract ID (replay prevention)
)
```

Where:

- `sender` = `predecessorId` = `vaultId <> computeOperatorsHash(map partyToText operators)`
- `computeOperatorsHash` = `keccak256(concat(sort(map (keccak256 . toHex) operatorTexts)))`
- `path` = pre-computed by the Vault: `partyToText requester <> "," <> userPath`

Both the Daml and Rust/TypeScript implementations must produce identical
hashes.

## Authority Delegation Flow (Daml)

### Atomic create + exercise delegation

`RequestDeposit` on the Vault uses a two-step pattern:

1. Creates `SignRequest` (signatory: `operators`)
2. Exercises `Signer.SignBidirectional` (controller: `requester`, flexible controller on disclosed Signer)
3. `SignBidirectional` delegates to `SignRequest.Execute` (consuming choice) which creates `SignBidirectionalEvent` (signatory: `operators, requester`)

- **Body authority**: `operators` (Vault signatories) + `requester`
  (controller of `RequestDeposit`)
- `requester` has visibility of Signer via disclosed contract ✓

### Multi-party authority flow

```
VaultProposal (propose/sign/sign/finalize)
  → Vault (signatory: [op1, op2, op3])
    → RequestDeposit (body: op1+op2+op3 + requester)
      → create SignRequest, exercise Signer.SignBidirectional → Execute
        → SignBidirectionalEvent (signatory: [op1, op2, op3, requester])
```

The operator authority established at Vault creation propagates through
the entire chain. No re-signing per transaction.

### Disclosed contracts

The Vault and Signer contracts are shared off-chain via disclosed
contract blobs. The requester's command submission includes disclosed blobs
for both the Vault and the Signer.

## MPC Trust Boundary: Malicious Participant Attack

### The Problem

`SignBidirectionalEvent` has `signatory operators, requester` — sigNetwork
is only an observer. In a multi-participant Canton Network, a malicious
SigNetwork participant cannot forge these contracts because the
operators' Confirming Participant Nodes (CPNs) would reject the
transaction at the mediator level.

However, the MPC service does not read the virtual global ledger. It
reads SigNetwork's **JSON Ledger API** via WebSocket. This is analogous
to an off-chain service trusting a single Ethereum RPC endpoint: the
blockchain is fine, but the API layer can lie.

A malicious SigNetwork participant could:

1. Patch the JSON Ledger API to inject fake `CreatedEvent` into the
   WebSocket stream — contracts that were never confirmed by any
   operator participant
2. The MPC service validates the `requestId` hash and checks
   `CreatedEvent.signatories` + `witnessParties` against the contract's
   `operators` field (defense-in-depth, added in `tx-handler.ts`). However,
   in single-participant mode, a malicious participant can forge BOTH
   the contract payload AND the metadata — so this check only provides
   real protection in multi-participant deployment.
3. If the `requestId` is correctly computed from the forged `evmTxParams`,
   all 8 MPC nodes (connected to the same participant) sign the
   specified EVM transaction
4. Attacker submits signed tx to Ethereum — funds stolen

Even though `SignBidirectionalEvent` carries `signatory operators, requester`
(the full `[dex1, dex2, dex3]` array + requester), this protection only exists at the ledger
level. At the API layer, SigNetwork's participant can serve fake events
claiming these operators signed when they never did. The MPC service
now validates `CreatedEvent.signatories` against the contract's
`operators` field, but in single-participant mode a malicious participant
can forge metadata too. This is why MPC nodes must read from multiple
Canton participants: distributing the read path across
operator-controlled nodes ensures no single participant can trick enough
nodes to reach the signing threshold.

The `secp256k1WithEcdsaOnly` verification at claim time does not help
because the damage happens at **signing time** — the MPC already signed
the transaction and funds already moved on Ethereum. The attacker never
needs to claim anything on Canton.

### MPC Service Signatory Validation (implemented)

The MPC service validates **transaction metadata** from the Canton JSON
Ledger API in addition to the `requestId` hash:

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
// Implemented in tx-handler.ts signAndEnqueue()
const created = event.CreatedEvent;
const onLedgerSignatories = new Set(created.signatories);
const claimedOperators = payload.operators as string[];

for (const op of claimedOperators) {
  if (!onLedgerSignatories.has(op)) {
    throw new Error(
      `Operator ${op} is in contract payload but not in ` +
        `CreatedEvent.signatories — possible forgery`,
    );
  }
}
```

This validation is defense-in-depth: in single-participant mode, a
malicious participant could also forge the metadata. But combined with
multi-participant deployment (where metadata is populated from the
actual confirmation protocol), it closes the gap.

### Nonce: `SigningNonce` and MPC Verification

Replay prevention uses a dedicated `SigningNonce` contract. The
requester self-serves the first nonce via `Signer.IssueNonce`
(controller: requester); subsequent nonces are created atomically by
`SignBidirectional` (nonce rotation). Pure Signer-layer infrastructure
— no domain semantics, no coupling to vault-specific templates.

#### Design rationale

Previous iterations used domain contracts (`Authorization`,
`Erc20Holding`) as nonces. This coupled the Signer to vault-specific
templates: `sigNetwork` needed observer rights on domain contracts,
and the MPC maintained an `ALLOWED_NONCE_TEMPLATES` set that grew
per vault type. By moving the nonce to the Signer layer:

- **Domain contracts stay clean** — `Erc20Holding` (and any future
  integrator templates) don't need `sigNetwork` as observer.
- **Authorization is the integrator's concern** — different vault
  types can implement their own auth patterns (auth cards, multi-sig
  approvals, rate limits, or nothing at all) without touching the
  signing infrastructure.
- **One nonce template for all operations** — deposits, withdrawals,
  and any future vault type all use the same `SigningNonce`. The MPC
  checks exactly one template type.

#### Lifecycle

1. **Issuance (first nonce only)** — The `requester` exercises
   `Signer.IssueNonce` on the disclosed Signer contract. Creates a
   `SigningNonce` (signatory: `sigNetwork`, observer: `requester`).
   This is a separate transaction — the nonce is non-transient.
   Subsequent nonces come from atomic rotation in `SignBidirectional`.
2. **Consumption + rotation** — The user passes `nonceCid` and
   `nonceCidText` to the Vault choice. `Signer.SignBidirectional`
   validates the nonce (sigNetwork + requester match), archives it,
   delegates to `SignRequest.Execute` to create `SignBidirectionalEvent`,
   then creates a fresh `SigningNonce` — all atomically. The Vault
   returns the new nonce CID alongside the event and pending anchor,
   so the requester always has a nonce ready for the next request.
3. **MPC verification** — The MPC sees `ArchivedEvent(SigningNonce)` +
   `CreatedEvent(SignBidirectionalEvent)` in the same transaction.
   It verifies that `nonceCidText` matches the archived contract ID
   and that the template is `SigningNonce`.

#### Why Daml can't enforce the nonceCidText binding on-chain

Daml cannot convert `ContractId` to `Text` on-chain — `show` on
`ContractId` throws a runtime error in Daml 3.x, and
`contractIdToText` returns `None` in ledger code. The user provides
both `nonceCid` (the actual `ContractId SigningNonce`, used for
on-chain archive) and `nonceCidText` (the text representation, hashed
into `requestId`). On-chain, the archive is deterministic (the contract
referenced by `nonceCid` gets consumed). Off-chain, the MPC verifies
the text matches the archived contract's ID.

#### MPC-side enforcement

The Canton `/v2/updates` WebSocket stream returns full transactions
containing both `CreatedEvent` and `ArchivedEvent` entries (in
`ACS_DELTA` mode, non-transient archives are visible). The MPC
verifies:

1. **Contract was archived in the same transaction** — `nonceCidText`
   must match the `contractId` of an `ArchivedEvent` in the same
   transaction that created the `SignBidirectionalEvent`.
2. **Contract is a `SigningNonce`** — the `ArchivedEvent.templateId`
   must be `SigningNonce`. One template, no growing set.

```typescript
const archivedEvents = txEvents.filter((e) => "ArchivedEvent" in e).map((e) => e.ArchivedEvent);

const nonceEvent = archivedEvents.find((a) => a.contractId === nonceCidText);
if (!nonceEvent) {
  throw new Error("nonceCidText does not match any ArchivedEvent");
}
if (templateSuffix(nonceEvent.templateId) !== SIGNING_NONCE_SUFFIX) {
  throw new Error("nonceCidText is not a SigningNonce");
}
```

During catch-up (reconnection via `getActiveContracts`), the
transaction context is unavailable — the catch-up path trusts the
ledger state, which is acceptable because catch-up only processes
contracts that survived the confirmation protocol.

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

Each MPC node connects to a **different** participant. The `sigNetwork` party
is hosted with Observation permission on multiple participants (Canton
supports multi-hosting via `PartyToParticipant` topology mappings).

```
MPC Node 1 ──► DEX1's participant    (reads SignBidirectionalEvent)
MPC Node 2 ──► DEX2's participant    (reads SignBidirectionalEvent)
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
  1. Read SignBidirectionalEvent from SigNetwork's participant
  2. Query DEX's participant: does this contract exist?
  3. Only sign if both agree
```

**Option C: DEX participants as primary read source**

The `sigNetwork` party is hosted on every DEX participant (Observation
permission). MPC nodes connect to DEX participants for reading — not
SigNetwork's. SigNetwork's participant is only used for writing
(`Respond`, `RespondBidirectional`).

This removes SigNetwork from the read path entirely.

### Phased Rollout

**v0 (PoC):** Single Canton participant operated by SigNetwork. The MPC
trusts SigNetwork's node — same trust model as the current
`VaultOrchestrator`. The operators + requester signatory model is in place but provides
defense-in-depth only (not full protection). Acceptable for PoC with a
known, trusted operator.

**v1 (Multi-participant):** Each DEX runs its own Canton participant.
The MPC `sigNetwork` party is multi-hosted (Observation permission on DEX
participants). MPC nodes are distributed across participants so no
single operator controls the threshold. The multi-signatory model now
provides real security via Canton's confirmation protocol.

**v2 (Cross-validation):** MPC nodes cross-validate contracts against
multiple participants before signing. Defense-in-depth against
compromised participants even in multi-participant mode.

### Deployment Requirements

For the multi-signatory model to provide real security:

1. **Each DEX must run its own Canton participant** — if all parties
   share one participant operated by SigNetwork, the signatory model is
   purely cosmetic (the operator can forge any contract)
2. **`sigNetwork` party must be multi-hosted** — hosted on DEX
   participants with Observation permission so MPC nodes can read from
   trusted sources
3. **MPC threshold must span multiple data sources** — nodes connected
   to the same participant are in the same trust domain

Without multi-participant deployment, the multi-signatory model provides
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

## Decisions

1. **Separate DARs** — Signer and Vault are separate DAR packages.
   `daml-signer` depends only on `daml-evm-types` (for
   `EvmTransactionParams`). `daml-vault` depends on `daml-signer` via
   `data-dependencies`. Shared types (`BytesHex`, `SignatureHex`) come
   from `DA.Crypto.Text` (stdlib) — no cross-DAR type sharing needed.
   This enables independent versioning, deployment, and reuse of the
   Signer layer across multiple vault implementations.

2. **Signer-layer nonce** — Replay prevention uses `SigningNonce`
   (signatory: `sigNetwork`), issued via `Signer.IssueNonce`
   (controller: `requester`) and atomically rotated in
   `Signer.SignBidirectional`. Domain contracts don't need
   `sigNetwork` as observer; the MPC checks exactly one template type.
   Authorization is the integrator's concern, not the Signer's.

## Open Questions

1. **Multiple Signers** — Should the Vault support switching between
   Signers (e.g., key rotation)? Currently `sigNetwork` is fixed on the
   Vault. An `UpdateSigner` choice could handle this.

2. **Operator changes** — Adding or removing operators requires a new
   Vault (new multi-party agreement). An `UpdateOperators` choice could
   allow rotation without re-creating the Vault.

3. **`evmTxParams` vs `serializedTransaction`** — Canton uses structured
   `EvmTransactionParams` (can't RLP-encode on-chain). The MPC indexer
   must RLP-encode client-side before hashing. This is a Canton-specific
   divergence from Solana's raw `serialized_transaction` bytes.

## Future Improvements

### Vault-Level Authorization (Requester Allowlisting)

The current Vault has no authorization gate — any `requester` party can
call `RequestDeposit` / `RequestWithdrawal` on any Vault they can see,
and issue unlimited `SigningNonce`s. The old `DepositAuthorization` with
a remaining-use counter was removed during the signer/vault split and
not replaced.

This is not a DDoS concern — Canton handles spam prevention at the
infrastructure level:

- **Permissioned network**: only onboarded participants can transact
- **Sequencer traffic management**: per-member byte budgets
  (`max_base_traffic_amount`, `enforce_rate_limiting`), Canton Coin burn
  for extra traffic
- **Participant command throttling**: 200 cmd/s default, enabled since
  Canton 2.4.0 (`maxRate`, `maxDirtyRequests`)
- **Ledger API auth**: JWT + mTLS on the JSON Ledger API

On-chain rate limiting is not an idiomatic Canton pattern — no
documented examples exist. Canton positions DDoS defense entirely at the
infrastructure and protocol layers, not the smart contract level.

However, **authorization** (who may use a Vault) is a business logic
concern the Vault should own. Proposed approach:

1. **`AuthorizedRequester` template** — signed by `operators`, granting a
   specific party permission to interact with a specific Vault. Passed as
   a `ContractId` argument to `RequestDeposit` / `RequestWithdrawal`,
   which fetches it, asserts the requester matches, and proceeds.
   Optionally include a usage quota or expiry.

2. **MPC service rate limiting** — throttle signing ceremonies per-party
   in the TS MPC service (queue + backpressure). The MPC ceremony is the
   expensive operation; gating it off-chain is simpler and more
   responsive than on-chain counters.

3. **JWT auth on the Ledger API** — configure token-based access so only
   authenticated clients can reach the Canton API at all.

Per-party rate limits do not exist at the Canton protocol level — limits
apply per participant node. If per-party throttling is needed beyond
authorization, it belongs in the MPC service middleware.

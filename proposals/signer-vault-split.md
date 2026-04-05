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

### Malicious Participant: API-Layer Attack

The multi-signatory model protects the **ledger** but not the **API**.
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

| Party        | Role                               | Owns   |
| ------------ | ---------------------------------- | ------ |
| `sigNetwork` | MPC infrastructure (single party)  | Signer |
| `operators`  | Vault operator multi-sig `[Party]` | Vault  |
| `requester`  | End user (depositor/holder)        | —      |

`sigNetwork` is both the MPC party identity AND the Signer operator.
No separate `mpc` party. A vault can have one or more operator parties
(e.g., `[dex1, dex2, dex3]`). All operators must agree at Vault
creation time via `VaultProposal`.

## Contract Overview

Names follow the Solana/Hydration MPC convention. See
`proposals/naming-alignment.md` for the full mapping.

### Signer Layer (matches Solana `signet_program`)

```
Signer (singleton)                    ← sigNetwork deploys, shares blob off-chain
  │
  ├── SignBidirectional choice        ← requester exercises (via Vault), consumes SignRequest,
  │     controller: requester (flexible)    creates SignBidirectionalEvent
  │
  ├── Respond choice                  ← sigNetwork exercises after signing EVM tx,
  │     controller: sigNetwork           creates SignatureRespondedEvent
  │
  └── RespondBidirectional choice     ← sigNetwork exercises after chain confirmation,
        controller: sigNetwork           creates RespondBidirectionalEvent

SignRequest (transient)               ← created, then consumed via Signer.SignBidirectional → Execute
SignBidirectionalEvent                ← what MPC watches (signatory: operators, requester)
SignatureRespondedEvent               ← ECDSA signature evidence (signatory: sigNetwork)
RespondBidirectionalEvent             ← outcome signature evidence (signatory: sigNetwork)
```

### Vault Layer (Canton-specific, domain ERC20 custody)

```
Vault (singleton)                     ← operators deploy via VaultProposal
  │
  ├── RequestAuthorization            ← requester requests auth card
  ├── ApproveAuthorization            ← operator approves, creates Authorization
  ├── RequestDeposit                  ← requester consumes auth, atomic create + exercise
  │                                      SignRequest → Signer.SignBidirectional
  │                                      → SignBidirectionalEvent
  ├── ClaimDeposit                    ← requester verifies MPC sig → Erc20Holding
  ├── RequestWithdrawal               ← requester burns holding, same atomic flow
  └── CompleteWithdrawal              ← requester verifies MPC sig → refund or finalize

Authorization, Erc20Holding (domain contracts)
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

    nonconsuming choice SignBidirectional : ContractId SignBidirectionalEvent
      with
        signRequestCid : ContractId SignRequest
        requester      : Party          -- flexible controller
      controller requester
      do
        -- Delegate to SignRequest.Execute to get operators authority.
        -- This body has sigNetwork + requester, but needs operators + requester
        -- to create SignBidirectionalEvent. The Execute choice on SignRequest
        -- provides operators authority (SignRequest signatory).
        exercise signRequestCid Execute

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
    nonceCidText               : Text   -- consumed contract ID (uniqueness nonce)
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

Validates the auth card, atomically creates `SignBidirectionalEvent`
(via Signer) AND `PendingDeposit` (on Vault). The user calls one
choice — everything chains internally.

```daml
    nonconsuming choice RequestDeposit
      : (ContractId SignBidirectionalEvent, ContractId PendingDeposit)
      with
        requester    : Party
        signerCid    : ContractId Signer   -- disclosed contract
        path         : Text
        evmTxParams  : EvmTransactionParams
        authCid      : ContractId Authorization
        nonceCidText : Text    -- user provides contract ID string
                               -- (show doesn't work on-chain; MPC verifies off-chain)
        keyVersion   : Int
        algo       : Text
        dest       : Text
        params     : Text
        outputDeserializationSchema : Text
        respondSerializationSchema  : Text
      controller requester
      do
        auth <- fetch authCid
        assertMsg "Auth operators mismatch" (sort auth.operators == sort operators)
        assertMsg "Auth owner mismatch" (auth.owner == requester)
        assertMsg "No remaining uses" (auth.remainingUses > 0)
        archive authCid
        when (auth.remainingUses > 1) do
          void $ create auth with remainingUses = auth.remainingUses - 1

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
        -- Signer internally delegates to SignRequest.Execute
        signEventCid <- exercise signerCid SignBidirectional with
          signRequestCid = signReqCid; requester

        -- Compute requestId for the pending anchor
        let requestId = computeRequestId
              predecessorId evmTxParams caip2Id keyVersion
              fullPath algo dest params nonceCidText

        -- Create vault-layer anchor (consumed at claim time)
        pendingCid <- create PendingDeposit with
          operators; requester; sigNetwork; requestId; evmTxParams

        pure (signEventCid, pendingCid)
```

### `ClaimDeposit`

Consumes `PendingDeposit` (single-use guarantee), verifies the MPC
signature, creates `Erc20Holding`.

```daml
    nonconsuming choice ClaimDeposit : ContractId Erc20Holding
      with
        requester         : Party
        pendingDepositCid : ContractId PendingDeposit
        outcomeCid        : ContractId RespondBidirectionalEvent
        sigCid            : ContractId SignatureRespondedEvent
      controller requester
      do
        pending <- fetch pendingDepositCid
        archive pendingDepositCid           -- single-use guarantee

        assertMsg "Sender mismatch" (pending.requester == requester)
        assertMsg "Operators mismatch" (sort pending.operators == sort operators)

        outcome <- fetch outcomeCid
        assertMsg "Outcome requestId mismatch"
          (outcome.requestId == pending.requestId)

        let responseHash = computeResponseHash pending.requestId outcome.serializedOutput
        assertMsg "Invalid MPC signature"
          (secp256k1WithEcdsaOnly outcome.signature responseHash evmMpcPublicKey)

        assertMsg "MPC reported ETH transaction failure"
          (not (hasErrorPrefix outcome.serializedOutput))
        let success = abiDecodeBool outcome.serializedOutput 0
        assertMsg "ERC20 transfer returned false" success

        -- Use Consume choices (Vault body lacks sigNetwork authority to archive directly)
        exercise outcomeCid Consume_RespondBidirectional with actor = requester
        exercise sigCid Consume_SignatureResponded with actor = requester

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
      : (ContractId SignBidirectionalEvent, ContractId PendingWithdrawal)
      with
        requester        : Party
        signerCid        : ContractId Signer
        evmTxParams      : EvmTransactionParams
        recipientAddress : BytesHex
        balanceCid       : ContractId Erc20Holding
        nonceCidText     : Text    -- user provides balance contract ID string
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

        signEventCid <- exercise signerCid SignBidirectional with
          signRequestCid = signReqCid; requester

        let requestId = computeRequestId
              predecessorId evmTxParams caip2Id keyVersion
              "root" algo dest params nonceCidText

        pendingCid <- create PendingWithdrawal with
          operators; requester; sigNetwork; requestId; evmTxParams
          erc20Address = holding.erc20Address
          amount = holding.amount

        pure (signEventCid, pendingCid)
```

### `CompleteWithdrawal`

Consumes `PendingWithdrawal`. On failure, refunds the holding.

```daml
    nonconsuming choice CompleteWithdrawal : Optional (ContractId Erc20Holding)
      with
        requester            : Party
        pendingWithdrawalCid : ContractId PendingWithdrawal
        outcomeCid           : ContractId RespondBidirectionalEvent
        sigCid               : ContractId SignatureRespondedEvent
      controller requester
      do
        pending <- fetch pendingWithdrawalCid
        archive pendingWithdrawalCid        -- single-use guarantee

        assertMsg "Sender mismatch" (pending.requester == requester)
        assertMsg "Operators mismatch" (sort pending.operators == sort operators)

        outcome <- fetch outcomeCid
        assertMsg "Outcome requestId mismatch"
          (outcome.requestId == pending.requestId)

        let responseHash = computeResponseHash pending.requestId outcome.serializedOutput
        assertMsg "Invalid MPC signature"
          (secp256k1WithEcdsaOnly outcome.signature responseHash evmMpcPublicKey)

        exercise outcomeCid Consume_RespondBidirectional with actor = requester
        exercise sigCid Consume_SignatureResponded with actor = requester

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

### Auth Contracts

`Authorization` and `Erc20Holding` are domain-specific.

```daml
template AuthorizationRequest
  with
    operators : [Party]
    owner     : Party
  where
    signatory operators
    observer owner

template Authorization
  with
    operators     : [Party]
    owner         : Party
    remainingUses : Int
  where
    signatory operators
    observer owner
    ensure not (null operators) && remainingUses > 0
```

The `RequestAuthorization` and `ApproveAuthorization` choices on the Vault:

```daml
    -- Auth card management — two-step flow:
    -- 1. User requests (creates AuthorizationRequest)
    -- 2. Any operator triggers approval (creates Authorization)
    -- Both are Vault choices → body has all operators' authority (Daml rule:
    -- "consequences of exercise are authorized by signatories + actors").
    -- Individual operator approval is enforced at the Canton PROTOCOL level:
    -- each signatory's participant must independently confirm the transaction
    -- (signatory confirmation policy). No propose/accept pattern needed.
    nonconsuming choice RequestAuthorization : ContractId AuthorizationRequest
      with
        requester : Party
      controller requester
      do
        create AuthorizationRequest with
          operators
          owner = requester

    nonconsuming choice ApproveAuthorization : ContractId Authorization
      with
        requestCid    : ContractId AuthorizationRequest
        remainingUses : Int
        approver      : Party
      controller approver
      do
        assertMsg "Not an operator" (approver `elem` operators)
        request <- fetch requestCid
        assertMsg "Operators mismatch" (sort request.operators == sort operators)
        archive requestCid
        create Authorization with
          operators
          owner = request.owner
          remainingUses
```

`Erc20Holding` tracks on-ledger ERC20 balances per user:

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
See `requestId` Computation above for the full formula.

## Deposit Lifecycle

```
 Sender                Vault (Operators)       Signer (SigNetwork)     MPC (sigNetwork)         Sepolia
 |                     |                       |                       |                         |
 | 1. RequestAuthorization                     |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | Authorization pending |                       |                         |
 |                     |                       |                       |                         |
 | 2. ApproveAuthorization (operators)         |                       |                         |
 |                     | Authorization created |                       |                         |
 |                     |                       |                       |                         |
 | 3. ERC20 transfer to deposit address        |                       |                         |
 |------------------------------------------------------------------------------ transfer ------>|
 |                     |                       |                       |                         |
 | 4. RequestDeposit   |                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | validates auth card   |                       |                         |
 |                     | create + exercise:    |                       |                         |
 |                     | SignRequest ──────────► SignBidirectional      |                         |
 |                     |                       | → SignBidirectionalEvent                        |
 |                     | + PendingDeposit      |   (signatory: operators, requester)               |
 |                     |   (vault anchor)      |                       |                         |
 |                     |                       |                       |                         |
 |                     |                       |                       | 5. observes event       |
 |                     |                       |                       |    derives child key    |
 |                     |                       |                       |    threshold sign       |
 |                     |                       |                       |                         |
 |                     |                       | 6. Respond            |                         |
 |                     |                       |<- SignatureResponded -|                         |
 |                     |                       |                       |                         |
 | 7. observes SignatureRespondedEvent         |                       |                         |
 |<--------------------------------------------|                       |                         |
 |    reconstructSignedTx, eth_sendRawTransaction                      |                         |
 |------------------------------------------------------------------------------ sweep tx ------>|
 |                     |                       |                       |                         |
 |                     |                       |                       | 8. polls Sepolia        |
 |                     |                       |                       |    re-simulates call    |
 |                     |                       |                       |                         |
 |                     |                       | 9. RespondBidirectional                         |
 |                     |                       |<- RespondBidirectional-|  (signs over operators) |
 |                     |                       |   Event               |                         |
 |                     |                       |                       |                         |
 | 10. ClaimDeposit    |                       |                       |                         |
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
 | 1. RequestWithdrawal|                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | validates + archives  |                       |                         |
 |                     |   Erc20Holding        |                       |                         |
 |                     | create + exercise:    |                       |                         |
 |                     | SignRequest ──────────► SignBidirectional      |                         |
 |                     |                       | → SignBidirectionalEvent                        |
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
2. Read `operators`, `requester`, `path`, `keyVersion` from event payload
3. Derive child key using `derive_epsilon_canton()`
4. Threshold sign the EVM tx hash
5. Exercise `Signer.Respond` → creates `SignatureRespondedEvent`
6. Watch EVM for execution confirmation
7. Exercise `Signer.RespondBidirectional` → creates `RespondBidirectionalEvent`

The MPC never sees `SignRequest` (transient). It only sees
`SignBidirectionalEvent` — same as on Solana/Hydration.

### KDF Chain ID

The KDF uses `canton:global` as the source chain CAIP-2 ID (not
`eip155:1`). The derivation path is:

```
"sig.network v2.0.0 epsilon derivation:canton:global:{predecessorId}:{path}"
```

The KDF always uses the SOURCE chain (where the request originates), not
the destination chain. Canton requests use `canton:global`. This must
match `Chain::Canton.caip2_chain_id()` in the Rust MPC node.

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
responseHash = eip712Hash(keccak256(
    responseTypeHash <> assertBytes32 requestId <> safeKeccak256 serializedOutput
))
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
requestId = eip712Hash(keccak256(
    requestTypeHash
    <> hashText sender             -- sender = predecessorId = vaultId <> operatorsHash
    <> hashEvmParams evmTxParams
    <> hashText caip2Id
    <> padLeft (toHex keyVersion) 32
    <> hashText path
    <> hashText algo
    <> hashText dest
    <> hashText params
    <> hashText nonceCidText       -- consumed contract ID (replay prevention)
))
```

Where:
- `sender` = `predecessorId` = `vaultId <> computeOperatorsHash(map partyToText operators)`
- `computeOperatorsHash` = `keccak256(concat(sort(map (keccak256 . toHex) operatorTexts)))`
- `path` = pre-computed by the Vault: `partyToText requester <> "," <> userPath`

Both the Daml and Rust/TypeScript implementations must produce identical
hashes.

## Authorization Flow (Daml)

### Atomic create + exercise delegation

`RequestDeposit` on the Vault uses a two-step pattern:

1. Creates `SignRequest` (signatory: `operators`)
2. Exercises `Signer.SignBidirectional` (controller: `requester`, flexible controller on disclosed Signer)
3. `SignBidirectional` delegates to `SignRequest.Execute` (consuming choice) which creates `SignBidirectionalEvent` (signatory: `operators, requester`)

- **Body authority**: `operators` (Vault signatories) + `requester`
  (controller of `RequestDeposit`)
- `requester` has visibility of Signer via disclosed contract ✓
- `SignBidirectionalEvent` signatory is `operators, requester` — sigNetwork
  is NOT a signatory, only observer. SigNetwork cannot forge sign
  requests.

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

## Open Questions

1. **Separate DARs or single DAR?** — The Signer and Vault could be
   separate DAR packages (different SDK versions, independent deployment)
   or modules within the same DAR (simpler codegen, shared types).
   Separate DARs is cleaner architecturally but requires cross-DAR type
   sharing for `EvmTransactionParams`, `SignatureHex`, etc.

2. **Multiple Signers** — Should the Vault support switching between
   Signers (e.g., key rotation)? Currently `sigNetwork` is fixed on the
   Vault. An `UpdateSigner` choice could handle this.

3. **Operator changes** — Adding or removing operators requires a new
   Vault (new multi-party agreement). An `UpdateOperators` choice could
   allow rotation without re-creating the Vault.

4. **`evmTxParams` vs `serializedTransaction`** — Canton uses structured
   `EvmTransactionParams` (can't RLP-encode on-chain). The MPC indexer
   must RLP-encode client-side before hashing. This is a Canton-specific
   divergence from Solana's raw `serialized_transaction` bytes.

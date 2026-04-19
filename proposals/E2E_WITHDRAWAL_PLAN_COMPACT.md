# EVM Withdrawal Architecture: Canton MPC PoC

Mirrors the familiar CEX withdrawal experience: the user requests a withdrawal
from their balance, and the system sends tokens from the centralized
**vault address** to an external **recipient address** — except here the
"CEX backend" is a Canton ledger + MPC signing service, giving cryptographic
proof of every step.

## What the Demo Does

1. User exercises `Signer.IssueNonce` (disclosed contract), creating a
   `SigningNonce` for replay prevention (or reuses the nonce returned from
   a previous `RequestDeposit` / `RequestWithdrawal`)
2. User exercises `Vault.RequestWithdrawal` on Canton, providing their
   `Erc20Holding` and EVM transaction parameters for the withdrawal
3. Vault validates the holding (ownership, ERC20 address, amount),
   archives it (optimistic debit), and atomically:
   - Creates a `SignRequest` (authority bridge)
   - Exercises `Signer.SignBidirectional`, which archives the `SigningNonce`,
     delegates to `SignRequest.Execute` → `SignBidirectionalEvent`, and
     issues a fresh nonce
   - Creates a `PendingWithdrawal` (vault-layer anchor)
4. MPC Service observes the `SignBidirectionalEvent` via WebSocket stream
5. MPC Service validates signatories and nonce archive in same tx
6. MPC Service builds, serializes, and signs the EVM withdrawal transaction
7. MPC Service exercises `Signer.Respond` on Canton, creating a
   `SignatureRespondedEvent`
8. User observes the `SignatureRespondedEvent`, reconstructs the signed
   transaction, and submits it to Sepolia via `eth_sendRawTransaction`
9. MPC Service re-simulates the call at `blockNumber - 1` to extract
   ABI-encoded return data
10. MPC Service exercises `Signer.RespondBidirectional` on Canton, creating a
    `RespondBidirectionalEvent` carrying the ABI-encoded `mpcOutput`
11. User observes the outcome and exercises `Vault.CompleteWithdrawal`
    on Canton; Canton verifies the MPC signature, archives all evidence
    contracts — on success the withdrawal is final, on failure a refund
    `Erc20Holding` is created

The result: tokens move from the **vault address** on Sepolia to the user's
specified **recipient address**, and all Canton evidence is archived. On
failure, the user's `Erc20Holding` is restored.

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
 |                     |                       |                       | 2. observes event       |
 |                     |                       |                       |    validates signatories |
 |                     |                       |                       |    verifies nonce archive|
 |                     |                       |                       |    derives vault key    |
 |                     |                       |                       |    threshold sign       |
 |                     |                       |                       |                         |
 |                     |                       | 3. Respond            |                         |
 |                     |                       |<- SignatureResponded -|                         |
 |                     |                       |                       |                         |
 | 4. observes SignatureRespondedEvent         |                       |                         |
 |<--------------------------------------------|                       |                         |
 |    reconstructSignedTx, eth_sendRawTransaction                      |                         |
 |-------------------------------------------------------------------------- withdrawal tx ----->|
 |                     |                       |                       |                         |
 |                     |                       |                       | 5. polls Sepolia        |
 |                     |                       |                       |    re-simulates call    |
 |                     |                       |                       |                         |
 |                     |                       | 6. RespondBidirectional                        |
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

## Daml Contracts

### Signer Layer

Same contracts as the deposit flow — see `E2E_DEPOSIT_PLAN_COMPACT.md`.
`SignBidirectionalEvent`, `SignatureRespondedEvent`,
`RespondBidirectionalEvent`, `SigningNonce`, `SignRequest` are all reused
as-is. The MPC service is flow-agnostic — it watches
`SignBidirectionalEvent` regardless of deposit vs withdrawal.

### Vault Layer

### `PendingWithdrawal` (Erc20Vault.daml)

Vault-layer anchor for an in-flight withdrawal. Carries the holding info
for refund on failure.

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

All other contracts (`EvmTransactionParams`, `TxParams`, `Signature`,
`Vault`, `Erc20Holding`) are unchanged from the deposit flow — see
`E2E_DEPOSIT_PLAN_COMPACT.md`.

### Choices on `Vault`

**`RequestWithdrawal`** — user initiates a withdrawal from their
`Erc20Holding`. Archives the holding (optimistic debit), same atomic flow
as `RequestDeposit`. Creates `SignBidirectionalEvent` + `PendingWithdrawal`.

No authorization card is needed — the `Erc20Holding` itself is the
authorization. Ownership is verified by fetching the contract and checking
`owner == requester`. The `SigningNonce` contractId serves as the natural
nonce for `requestId`.

```daml
nonconsuming choice RequestWithdrawal
  : (ContractId SignBidirectionalEvent, ContractId PendingWithdrawal, ContractId SigningNonce)
  with
    requester        : Party
    signerCid        : ContractId Signer
    evmTxParams      : EvmTransactionParams
    recipientAddress : BytesHex
    balanceCid       : ContractId Erc20Holding
    nonceCid         : ContractId SigningNonce
    nonceCidText     : Text
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

    assertMsg "Only ERC20 transfer allowed"
      (evmTxParams.functionSignature == "transfer(address,uint256)")
    assertMsg "encodedArgs must be exactly 2 slots"
      (abiSlotCount evmTxParams.encodedArgs == 2)
    let recipientArg = abiSlot evmTxParams.encodedArgs 0
    let amountArg = abiDecodeUint evmTxParams.encodedArgs 1
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
      txParams = EvmTxParams evmTxParams; sender = predecessorId; caip2Id; keyVersion
      path = "root"; algo; dest; params
      nonceCidText
      outputDeserializationSchema; respondSerializationSchema

    (signEventCid, newNonceCid) <- exercise signerCid SignBidirectional with
      signRequestCid = signReqCid; nonceCid; requester

    let requestId = computeRequestId
          predecessorId (EvmTxParams evmTxParams) caip2Id keyVersion
          "root" algo dest params nonceCidText

    pendingCid <- create PendingWithdrawal with
      operators; requester; sigNetwork; requestId; evmTxParams
      erc20Address = holding.erc20Address
      amount = holding.amount

    pure (signEventCid, pendingCid, newNonceCid)
```

**Key derivation (predecessorId + path):** same KDF as deposit —
`predecessorId = vaultId <> operatorsHash`. The difference is path:
`"root"` derives the vault's shared key that controls the centralized
vault address, whereas deposit uses
`partyToText requester <> "," <> userPath` for per-user deposit addresses.

**`CompleteWithdrawal`** — user triggers completion after observing the
outcome. Archives `PendingWithdrawal` (single-use guarantee), verifies MPC
signature, and archives both evidence contracts via `Consume_*` choices.
Uses `abiHasErrorPrefix` and `abiDecodeBool` to determine success or
failure — on success, the withdrawal is final; on failure, a refund
`Erc20Holding` is created to restore the user's balance.

Unlike `ClaimDeposit` (which rejects on failure), `CompleteWithdrawal`
must handle both outcomes because the holding was already archived in
`RequestWithdrawal` (optimistic debit).

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
    archive pendingWithdrawalCid

    assertMsg "Sender mismatch" (pending.requester == requester)
    assertMsg "Operators mismatch" (sort pending.operators == sort operators)

    outcome <- fetch respondBidirectionalEventCid
    assertMsg "Outcome requestId mismatch"
      (outcome.requestId == pending.requestId)

    let responseHash = computeResponseHash pending.requestId outcome.serializedOutput
    assertMsg "Invalid MPC signature"
      (secp256k1WithEcdsaOnly (signatureDer outcome.signature) responseHash evmMpcPublicKey)

    exercise respondBidirectionalEventCid Consume_RespondBidirectional with actor = requester
    exercise signatureRespondedEventCid Consume_SignatureResponded with actor = requester

    let shouldRefund =
          abiHasErrorPrefix outcome.serializedOutput
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

### Crypto Functions (RequestId.daml)

No new functions. `computeRequestId` and `computeResponseHash` are reused
as-is — see `E2E_DEPOSIT_PLAN_COMPACT.md`. The nonce slot receives
`nonceCidText` (the consumed `SigningNonce` contractId as text) for both
deposit and withdrawal. `computeResponseHash` concatenates the raw
`mpcOutput` after `requestId` — no inner keccak — so it matches the MPC
and Solana single-hash semantics.

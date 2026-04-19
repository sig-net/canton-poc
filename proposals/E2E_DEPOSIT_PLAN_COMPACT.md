# EVM Deposit Architecture: Canton MPC PoC

Mirrors the familiar CEX deposit experience: the user sends tokens to a
personal **deposit address**, and the system automatically sweeps them into a
centralized vault — except here the "CEX backend" is a Canton ledger + MPC
signing service, giving cryptographic proof of every step.

The Signer (sigNetwork) is generic signing infrastructure — chain-agnostic,
vault-agnostic, reusable across multiple vault types. The Vault (operators)
is domain-specific ERC20 custody that creates signing requests and interprets
outcomes. See [`daml-packages/daml-signer/README.md`](../daml-packages/daml-signer/README.md)
for the Signer layer, authority delegation flow, MPC service flow, and security model.

## What the Demo Does

1. User exercises `Signer.IssueNonce` (disclosed contract), creating a
   `SigningNonce` for replay prevention
2. User sends ERC20 tokens to a **deposit address** on Sepolia
   (derived from MPC root public key, predecessorId=vaultId+operatorsHash,
   path=requester+userPath)
3. User exercises `Vault.RequestDeposit` on Canton to request a **sweep from
   the deposit address to the vault address**
   (derived from MPC root public key, predecessorId=vaultId+operatorsHash,
   path="root") via an ERC20 `transfer` call. The choice atomically:
   - Creates a `SignRequest` (authority bridge)
   - Exercises `Signer.SignBidirectional`, which archives the `SigningNonce`,
     delegates to `SignRequest.Execute` → `SignBidirectionalEvent`, and
     issues a fresh nonce
   - Creates a `PendingDeposit` (vault-layer anchor)
4. MPC Service observes the `SignBidirectionalEvent` via WebSocket stream
5. MPC Service validates signatories and nonce archive in same tx
6. MPC Service builds, serializes, and signs the EVM sweep transaction
7. MPC Service exercises `Signer.Respond` on Canton, creating a
   `SignatureRespondedEvent`
8. User observes the `SignatureRespondedEvent`, reconstructs the signed
   transaction, and submits it to Sepolia via `eth_sendRawTransaction`
9. MPC Service re-simulates the call at `blockNumber - 1` to extract
   ABI-encoded return data
10. MPC Service exercises `Signer.RespondBidirectional` on Canton, creating a
    `RespondBidirectionalEvent` carrying the ABI-encoded `mpcOutput`
11. User observes the outcome and exercises `Vault.ClaimDeposit` on Canton
12. Canton verifies the MPC signature via `secp256k1WithEcdsaOnly`, decodes the
    `mpcOutput` via `abiDecodeBool`, archives `PendingDeposit` and both evidence
    contracts, and creates an `Erc20Holding`

The result: an `Erc20Holding` contract on Canton representing the user's
wrapped ERC-20 balance.

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
 |                     |                       |                       | 4. observes event       |
 |                     |                       |                       |    validates signatories |
 |                     |                       |                       |    verifies nonce archive|
 |                     |                       |                       |    derives child key    |
 |                     |                       |                       |    threshold sign       |
 |                     |                       |                       |                         |
 |                     |                       | 5. Respond            |                         |
 |                     |                       |<- SignatureResponded -|                         |
 |                     |                       |                       |                         |
 | 6. observes SignatureRespondedEvent         |                       |                         |
 |<--------------------------------------------|                       |                         |
 |    reconstructSignedTx, eth_sendRawTransaction                      |                         |
 |------------------------------------------------------------------------------ sweep tx ------>|
 |                     |                       |                       |                         |
 |                     |                       |                       | 7. polls Sepolia        |
 |                     |                       |                       |    re-simulates call    |
 |                     |                       |                       |                         |
 |                     |                       | 8. RespondBidirectional                        |
 |                     |                       |<- RespondBidirectional-|                         |
 |                     |                       |   Event               |                         |
 |                     |                       |                       |                         |
 | 9. ClaimDeposit     |                       |                       |                         |
 |-------------------->|                       |                       |                         |
 |                     | archives PendingDeposit (single-use)          |                         |
 |                     | verifies MPC sig      |                       |                         |
 |                     |   via evmMpcPublicKey  |                       |                         |
 |                     | creates Erc20Holding  |                       |                         |
 |                     |                       |                       |                         |
 |<-- Erc20Holding ----|                       |                       |                         |
```

## Parties

| Party        | Role                               | Owns   |
| ------------ | ---------------------------------- | ------ |
| `sigNetwork` | MPC infrastructure (single party)  | Signer |
| `operators`  | Vault operator multi-sig `[Party]` | Vault  |
| `requester`  | End user (depositor)               | --     |

## Daml Contracts

### Signer Layer (generic signing infrastructure)

Signer templates (`Signer`, `SigningNonce`, `SignRequest`, `SignBidirectionalEvent`,
`SignatureRespondedEvent`, `RespondBidirectionalEvent`) are documented in the
[`daml-signer` package README](../daml-packages/daml-signer/README.md) along
with the authority delegation flow, MPC service flow, and security model.
The deposit flow exercises them in the sequence shown in the lifecycle diagram above.

### Vault Layer (domain ERC20 custody)

The Vault layer (`Erc20Vault.daml` in `daml-vault`) defines the ERC-20 custody
templates and choice bodies used by the deposit flow. Transaction parameter
types (`EvmTransactionParams`, `TxParams`) are imported from `daml-signer`
and documented in the
[`daml-signer` README](../daml-packages/daml-signer/README.md#evmtransactionparams)
— including the rationale for splitting `functionSignature` /
`encodedArgs` instead of storing raw calldata.

### `Signature` (Signer.daml)

Signature union type. Currently ECDSA-only, extensible to EdDSA/Schnorr.

```daml
data EcdsaSigData = EcdsaSigData with
    der : SignatureHex      -- DER-encoded (r, s) as hex
    recoveryId : Int        -- 0 or 1 — y-parity for EVM ecrecover
  deriving (Eq, Show)

data Signature
  = EcdsaSig EcdsaSigData
  deriving (Eq, Show)
```

### `VaultProposal` (Erc20Vault.daml)

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
      && byteCount evmVaultAddress == 32

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

### `Vault` (Erc20Vault.daml)

Domain-specific ERC20 custody. `evmMpcPublicKey` is per-vault (each vault
has its own derived MPC key). `evmVaultAddress` is validated as 32 bytes
(ABI-encoded address).

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
      && byteCount evmVaultAddress == 32

    nonconsuming choice RequestDeposit
      : (ContractId SignBidirectionalEvent, ContractId PendingDeposit, ContractId SigningNonce)
    nonconsuming choice ClaimDeposit : ContractId Erc20Holding
    nonconsuming choice RequestWithdrawal
      : (ContractId SignBidirectionalEvent, ContractId PendingWithdrawal, ContractId SigningNonce)
    nonconsuming choice CompleteWithdrawal : Optional (ContractId Erc20Holding)
```

### `PendingDeposit` (Erc20Vault.daml)

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

### `Erc20Holding` (Erc20Vault.daml)

Tracks on-ledger ERC20 balances per user. `sigNetwork` is NOT an observer —
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

### Choices on `Vault`

**`RequestDeposit`** — user creates a deposit request. Atomically creates
`SignRequest` → `SignBidirectionalEvent` (via Signer) and `PendingDeposit`
(vault anchor). Returns the new `SigningNonce` for the next request.

```daml
nonconsuming choice RequestDeposit
  : (ContractId SignBidirectionalEvent, ContractId PendingDeposit, ContractId SigningNonce)
  with
    requester    : Party
    signerCid    : ContractId Signer
    path         : Text
    evmTxParams  : EvmTransactionParams
    nonceCid     : ContractId SigningNonce
    nonceCidText : Text
    keyVersion   : Int
    algo         : Text
    dest         : Text
    params       : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  controller requester
  do
    assertMsg "Only ERC20 transfer allowed"
      (evmTxParams.functionSignature == "transfer(address,uint256)")
    assertMsg "encodedArgs must be exactly 2 slots"
      (abiSlotCount evmTxParams.encodedArgs == 2)
    let recipientArg = abiSlot evmTxParams.encodedArgs 0
    assertMsg "Transfer recipient must be vault address"
      (recipientArg == evmVaultAddress)

    let fullPath = partyToText requester <> "," <> path
    let caip2Id = "eip155:" <> chainIdToDecimalText evmTxParams.chainId
    let operatorsHash = computeOperatorsHash (map partyToText operators)
    let predecessorId = vaultId <> operatorsHash

    signReqCid <- create SignRequest with
      operators; requester; sigNetwork
      txParams = EvmTxParams evmTxParams; sender = predecessorId; caip2Id; keyVersion
      path = fullPath; algo; dest; params
      nonceCidText
      outputDeserializationSchema; respondSerializationSchema

    (signEventCid, newNonceCid) <- exercise signerCid SignBidirectional with
      signRequestCid = signReqCid; nonceCid; requester

    let requestId = computeRequestId
          predecessorId (EvmTxParams evmTxParams) caip2Id keyVersion
          fullPath algo dest params nonceCidText

    pendingCid <- create PendingDeposit with
      operators; requester; sigNetwork; requestId; evmTxParams

    pure (signEventCid, pendingCid, newNonceCid)
```

**`ClaimDeposit`** — user triggers claim after observing the outcome.
Archives `PendingDeposit` (single-use guarantee), verifies the MPC
signature against `evmMpcPublicKey`, validates ABI-decoded bool, archives
both evidence contracts via `Consume_*` choices, and creates `Erc20Holding`.

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
    archive pendingDepositCid

    assertMsg "Sender mismatch" (pending.requester == requester)
    assertMsg "Operators mismatch" (sort pending.operators == sort operators)

    outcome <- fetch respondBidirectionalEventCid
    assertMsg "Outcome requestId mismatch"
      (outcome.requestId == pending.requestId)

    let responseHash = computeResponseHash pending.requestId outcome.serializedOutput
    assertMsg "Invalid MPC signature"
      (secp256k1WithEcdsaOnly (signatureDer outcome.signature) responseHash evmMpcPublicKey)

    assertMsg "MPC reported ETH transaction failure"
      (not (abiHasErrorPrefix outcome.serializedOutput))
    let success = abiDecodeBool outcome.serializedOutput 0
    assertMsg "ERC20 transfer returned false" success

    exercise respondBidirectionalEventCid Consume_RespondBidirectional with actor = requester
    exercise signatureRespondedEventCid Consume_SignatureResponded with actor = requester

    let amount = abiDecodeUint (pending.evmTxParams).encodedArgs 1
    create Erc20Holding with
      operators
      owner = requester
      erc20Address = (pending.evmTxParams).to
      amount
```

### Key Derivation (predecessorId + path)

`predecessorId = vaultId <> computeOperatorsHash(map partyToText operators)`.
This ensures different operator sets never control the same EVM address via
the MPC KDF. `computeOperatorsHash` sorts operators and hashes each
individually before concatenating and hashing the result.

- **Vault address**: path = `"root"`
- **Deposit address**: path = `partyToText requester <> "," <> userPath`

### Crypto Functions (RequestId.daml)

```daml
hashEvmParams : EvmTransactionParams -> BytesHex
hashEvmParams p =
  keccak256 $
       eip712EncodeAddress p.to
    <> eip712EncodeString p.functionSignature
    <> eip712EncodeBytes p.encodedArgs
    <> eip712EncodeUint256 p.value
    <> eip712EncodeUint256 p.nonce
    <> eip712EncodeUint256 p.gasLimit
    <> eip712EncodeUint256 p.maxFeePerGas
    <> eip712EncodeUint256 p.maxPriorityFee
    <> eip712EncodeUint256 p.chainId

computeRequestId : Text -> TxParams -> Text -> Int -> Text -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId sender txParams caip2Id keyVersion path algo dest params nonceCidText =
  keccak256 $
       eip712EncodeString sender
    <> hashTxParams txParams
    <> eip712EncodeString caip2Id
    <> eip712EncodeUint256 (toHex keyVersion)
    <> eip712EncodeString path
    <> eip712EncodeString algo
    <> eip712EncodeString dest
    <> eip712EncodeString params
    <> eip712EncodeString nonceCidText

computeResponseHash : BytesHex -> BytesHex -> BytesHex
computeResponseHash requestId output =
  keccak256 (assertBytes32 requestId <> eip712EncodeBytes output)
```

`computeResponseHash` hashes `mpcOutput` generically via `eip712EncodeBytes` —
it works for any length.

## ABI-Encoded mpcOutput

The MPC service sends ABI-encoded EVM return data as `mpcOutput`,
allowing Daml to interpret actual return values using `Abi.daml`.

### Wire Format

```
Success:  <ABI-encoded return data>          e.g. "0000...0001" (bool true, 64 hex chars)
Failure:  "deadbeef" <> <ABI-encoded error>  e.g. "deadbeef0000...0001" (72 hex chars)
```

### How the MPC Service Produces mpcOutput

1. **TX succeeded** (`receipt.status === "success"`): Re-simulate the call
   via `client.call()` at `blockNumber - 1` to extract the raw ABI-encoded
   return value. For ERC20 `transfer`, this is `bool(true)` =
   `0000...0001` (64 hex chars).
2. **TX reverted / replaced / timed out**: Prefix with `0xDEADBEEF` +
   ABI-encoded `bool(true)` as error payload. The bytes after `deadbeef`
   are reserved for richer error types in the future.

### How Canton Interprets mpcOutput

**`ClaimDeposit`** (deposit claim — rejects on any failure):

```daml
assertMsg "MPC reported ETH transaction failure"
  (not (abiHasErrorPrefix outcome.serializedOutput))
let success = abiDecodeBool outcome.serializedOutput 0
assertMsg "ERC20 transfer returned false" success
```

### Schemas on SignBidirectionalEvent

`SignBidirectionalEvent` carries two schema fields that tell the MPC service
how to decode and re-encode return data:

- `outputDeserializationSchema` — how to decode EVM return data
- `respondSerializationSchema` — how to encode the response for Canton

For ERC20 `transfer(address,uint256) returns (bool)`, both are
`[{"name":"","type":"bool"}]`.

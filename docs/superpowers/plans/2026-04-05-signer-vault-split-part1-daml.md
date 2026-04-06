# Signer/Vault Split — Part 1: Daml Contracts

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `VaultOrchestrator` (single template with 8 choices) into a
generic `Signer` layer and domain-specific `Vault` layer, matching the
architecture in `proposals/signer-vault-split.md`.

**Architecture:** The current `daml-vault` package contains everything. After
this plan, `daml-vault` will contain both the Signer layer (generic signing
infrastructure) and the Vault layer (ERC20 custody). The Signer and Vault
are in the same DAR but separate modules. A new `daml-signer` package is
NOT created yet — both modules live in `daml-vault` to avoid cross-DAR
type sharing complexity.

**Tech Stack:** Daml 3.4.11, `dpm build --all`, `dpm test` per package

**Spec:** `proposals/signer-vault-split.md` (the source of truth for all
template definitions, choices, and fields)

---

## File Structure

| File                                                  | Action      | Responsibility                                                                                                                  |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `daml-packages/daml-vault/daml/Signer.daml`           | **Create**  | Signer, SignRequest, SignBidirectionalEvent, SignatureRespondedEvent, RespondBidirectionalEvent                                 |
| `daml-packages/daml-vault/daml/Erc20Vault.daml`       | **Rewrite** | Vault, VaultProposal, PendingDeposit, PendingWithdrawal, Authorization, AuthorizationProposal, Erc20Holding + all Vault choices |
| `daml-packages/daml-vault/daml/RequestId.daml`        | **Modify**  | Update `computeRequestId` signature for operators list                                                                          |
| `daml-packages/daml-vault/daml/TestVault.daml`        | **Rewrite** | All tests updated for new template/choice names and multi-sig operators                                                         |
| `daml-packages/daml-vault/daml/TestRequestId.daml`    | **Modify**  | Update test calls for new `computeRequestId` signature                                                                          |
| `daml-packages/daml-evm-types/daml/TestFixtures.daml` | **Modify**  | Add fixtures for new signature format if needed                                                                                 |

## Naming Reference

| Old Name                                       | New Name                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `VaultOrchestrator`                            | `Vault` + `Signer` (two templates)                                               |
| `issuer : Party`                               | `operators : [Party]` (Vault) / `sigNetwork : Party` (Signer)                    |
| `mpc : Party`                                  | removed (sigNetwork serves both roles)                                           |
| `requester`                                    | `sender`                                                                         |
| `PendingEvmTx`                                 | `SignBidirectionalEvent` (Signer) + `PendingDeposit`/`PendingWithdrawal` (Vault) |
| `EcdsaSignature`                               | `SignatureRespondedEvent`                                                        |
| `EvmTxOutcomeSignature`                        | `RespondBidirectionalEvent`                                                      |
| `SignEvmTx` choice                             | `Respond` choice on Signer                                                       |
| `ProvideEvmOutcomeSig` choice                  | `RespondBidirectional` choice on Signer                                          |
| `RequestEvmDeposit`                            | `RequestDeposit`                                                                 |
| `ClaimEvmDeposit`                              | `ClaimDeposit`                                                                   |
| `RequestEvmWithdrawal`                         | `RequestWithdrawal`                                                              |
| `CompleteEvmWithdrawal`                        | `CompleteWithdrawal`                                                             |
| `RequestDepositAuth`                           | `RequestAuthorization`                                                           |
| `ApproveDepositAuth`                           | `ApproveAuthorization`                                                           |
| `DepositAuthProposal`                          | `AuthorizationProposal`                                                          |
| `DepositAuthorization`                         | `Authorization`                                                                  |
| `mpcPublicKey`                                 | `evmMpcPublicKey` (on Vault, not Signer)                                         |
| `vaultAddress`                                 | `evmVaultAddress`                                                                |
| `evmParams`                                    | `evmTxParams`                                                                    |
| `r, s, v` (EcdsaSignature)                     | `signature : SignatureHex` (DER-encoded)                                         |
| `signature, mpcOutput` (EvmTxOutcomeSignature) | `signature : SignatureHex, serializedOutput : BytesHex`                          |

---

### Task 1: Create `Signer.daml` — Signer layer templates

**Files:**

- Create: `daml-packages/daml-vault/daml/Signer.daml`

- [ ] **Step 1: Create `Signer.daml` with all Signer layer templates**

Copy the following templates from the proposal (`proposals/signer-vault-split.md` lines 142-323) into a new file. The module exports:

- `Signer` template (singleton, `signatory sigNetwork`)
- `SignRequest` template (transient, `signatory operators`, with `Execute` consuming choice)
- `SignBidirectionalEvent` template (`signatory operators, sender`, with `Consume_SignBidirectional`)
- `SignatureRespondedEvent` template (`signatory sigNetwork`, with `Consume_SignatureResponded`)
- `RespondBidirectionalEvent` template (`signatory sigNetwork`, with `Consume_RespondBidirectional`)

```daml
module Signer where

import DA.List (unique)
import DA.Crypto.Text (BytesHex, SignatureHex)

import EvmTypes (EvmTransactionParams)

-- ---------------------------------------------------------------------------
-- Signer singleton — MPC infrastructure
-- ---------------------------------------------------------------------------

template Signer
  with
    sigNetwork : Party
  where
    signatory sigNetwork

    nonconsuming choice SignBidirectional : ContractId SignBidirectionalEvent
      with
        signRequestCid : ContractId SignRequest
        sender         : Party
      controller sender
      do
        exercise signRequestCid Execute

    nonconsuming choice Respond : ContractId SignatureRespondedEvent
      with
        operators : [Party]
        sender    : Party
        requestId : BytesHex
        signature : SignatureHex
      controller sigNetwork
      do
        create SignatureRespondedEvent with
          sigNetwork; operators; sender; requestId
          responder = sigNetwork; signature

    nonconsuming choice RespondBidirectional : ContractId RespondBidirectionalEvent
      with
        operators        : [Party]
        sender           : Party
        requestId        : BytesHex
        serializedOutput : BytesHex
        signature        : SignatureHex
      controller sigNetwork
      do
        create RespondBidirectionalEvent with
          sigNetwork; operators; sender; requestId
          responder = sigNetwork; serializedOutput; signature

-- ---------------------------------------------------------------------------
-- SignRequest — transient authority bridge (Vault → Signer CPI)
-- ---------------------------------------------------------------------------

template SignRequest
  with
    operators                  : [Party]
    sender                     : Party
    sigNetwork                 : Party
    evmTxParams                : EvmTransactionParams
    vaultId                    : Text   -- MPC derives predecessorId = vaultId <> keccak256(sort(operators)) off-chain
    caip2Id                    : Text
    keyVersion                 : Int
    path                       : Text
    algo                       : Text
    dest                       : Text
    params                     : Text
    nonceCidText               : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators
    observer sigNetwork
    ensure not (null operators) && unique operators

    choice Execute : ContractId SignBidirectionalEvent
      controller sender
      do
        create SignBidirectionalEvent with
          operators; sender; sigNetwork
          evmTxParams; caip2Id; keyVersion; path; algo; dest; params
          nonceCidText
          outputDeserializationSchema; respondSerializationSchema

-- ---------------------------------------------------------------------------
-- SignBidirectionalEvent — what the MPC watches
-- ---------------------------------------------------------------------------

template SignBidirectionalEvent
  with
    operators                  : [Party]
    sender                     : Party
    sigNetwork                 : Party
    evmTxParams                : EvmTransactionParams
    vaultId                    : Text   -- MPC derives predecessorId = vaultId <> keccak256(sort(operators)) off-chain
    caip2Id                    : Text
    keyVersion                 : Int
    path                       : Text
    algo                       : Text
    dest                       : Text
    params                     : Text
    nonceCidText               : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators, sender
    observer sigNetwork
    ensure not (null operators) && unique operators

    choice Consume_SignBidirectional : ()
      with actor : Party
      controller actor
      do
        assertMsg "Not authorized"
          (actor `elem` operators || actor == sender)
        pure ()

-- ---------------------------------------------------------------------------
-- Evidence contracts — MPC response delivery
-- ---------------------------------------------------------------------------

template SignatureRespondedEvent
  with
    sigNetwork : Party
    operators  : [Party]
    sender     : Party
    requestId  : BytesHex
    responder  : Party
    signature  : SignatureHex
  where
    signatory sigNetwork
    observer operators, sender

    choice Consume_SignatureResponded : ()
      with actor : Party
      controller actor
      do
        assertMsg "Not authorized"
          (actor `elem` operators || actor == sender)
        pure ()

template RespondBidirectionalEvent
  with
    sigNetwork       : Party
    operators        : [Party]
    sender           : Party
    requestId        : BytesHex
    responder        : Party
    serializedOutput : BytesHex
    signature        : SignatureHex
  where
    signatory sigNetwork
    observer operators, sender

    choice Consume_RespondBidirectional : ()
      with actor : Party
      controller actor
      do
        assertMsg "Not authorized"
          (actor `elem` operators || actor == sender)
        pure ()
```

- [ ] **Step 2: Verify it compiles**

Run:

```bash
cd daml-packages/daml-vault && dpm build
```

Expected: Build succeeds (no errors). The new module has no dependencies on the old `Erc20Vault` module.

- [ ] **Step 3: Commit**

```bash
git add daml-packages/daml-vault/daml/Signer.daml
git commit -m "feat(daml): add Signer layer templates (SignBidirectionalEvent, SignRequest, evidence contracts)"
```

---

### Task 2: Update `RequestId.daml` — new `computeRequestId` signature

**Files:**

- Modify: `daml-packages/daml-vault/daml/RequestId.daml`

The current `computeRequestId` takes `sender : Text` as first arg. The new version takes `operators : [Text]` and `sender : Party` separately, and includes `operatorsHash` in the EIP-712 struct.

- [ ] **Step 1: Update `RequestId.daml`**

The `requestTypeHash` changes because the EIP-712 struct type changes. The `computeRequestId` function signature changes to accept operators list.

```daml
module RequestId where

import DA.List (sort)
import DA.Crypto.Text
  ( BytesHex
  , keccak256
  , toHex
  )

import EvmTypes (EvmTransactionParams(..))
import Eip712 (padLeft, assertBytes32, safeKeccak256, hashText, hashBytesList, eip712Hash)

-- ---------------------------------------------------------------------------
-- EIP-712 type hashes
-- ---------------------------------------------------------------------------

evmParamsTypeHash : BytesHex
evmParamsTypeHash = keccak256 (toHex "EvmTransactionParams(address to,string functionSignature,bytes[] args,uint256 value,uint256 nonce,uint256 gasLimit,uint256 maxFeePerGas,uint256 maxPriorityFee,uint256 chainId)")

requestTypeHash : BytesHex
requestTypeHash = keccak256 (toHex ("CantonMpcSignRequest(bytes32 operatorsHash,string sender,EvmTransactionParams evmParams,string caip2Id,uint32 keyVersion,string path,string algo,string dest,string params,string nonceCidText)" <> "EvmTransactionParams(address to,string functionSignature,bytes[] args,uint256 value,uint256 nonce,uint256 gasLimit,uint256 maxFeePerGas,uint256 maxPriorityFee,uint256 chainId)"))

responseTypeHash : BytesHex
responseTypeHash = keccak256 (toHex "CantonMpcResponse(bytes32 requestId,bytes mpcOutput)")

-- ---------------------------------------------------------------------------
-- Struct hashing
-- ---------------------------------------------------------------------------

hashEvmParams : EvmTransactionParams -> BytesHex
hashEvmParams p =
  keccak256 $
       evmParamsTypeHash
    <> padLeft p.to 32
    <> hashText p.functionSignature
    <> hashBytesList p.args
    <> padLeft p.value          32
    <> padLeft p.nonce          32
    <> padLeft p.gasLimit       32
    <> padLeft p.maxFeePerGas   32
    <> padLeft p.maxPriorityFee 32
    <> padLeft p.chainId        32

-- ---------------------------------------------------------------------------
-- Operators hash — deterministic encoding of multi-sig operator set
-- ---------------------------------------------------------------------------

computeOperatorsHash : [Text] -> BytesHex
computeOperatorsHash operatorTexts =
  let sorted = sort operatorTexts
      individualHashes = map (keccak256 . toHex) sorted
  in keccak256 (mconcat individualHashes)

-- ---------------------------------------------------------------------------
-- Request ID and response hash
-- ---------------------------------------------------------------------------

computeRequestId : [Text] -> Text -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> Text -> BytesHex
computeRequestId operatorTexts sender evmParams caip2Id keyVersion path algo dest params nonceCidText =
  let operatorsHash = computeOperatorsHash operatorTexts
  in eip712Hash $ keccak256 $
       requestTypeHash
    <> assertBytes32 operatorsHash
    <> hashText sender
    <> hashEvmParams evmParams
    <> hashText caip2Id
    <> padLeft (toHex keyVersion) 32
    <> hashText path
    <> hashText algo
    <> hashText dest
    <> hashText params
    <> hashText nonceCidText

computeResponseHash : BytesHex -> BytesHex -> BytesHex
computeResponseHash requestId output =
  eip712Hash $ keccak256 (responseTypeHash <> assertBytes32 requestId <> safeKeccak256 output)
```

**Key changes from current:**

- `requestTypeHash` uses `CantonMpcSignRequest` (was `CantonMpcDepositRequest`)
- Added `bytes32 operatorsHash` as first field in the EIP-712 struct
- Added `params` and `nonceCidText` as named fields (was `authCidText`)
- `computeRequestId` now takes `[Text]` operators + `Text` sender (was single `Text` sender)
- Added `computeOperatorsHash` helper
- `computeResponseHash` unchanged

- [ ] **Step 2: Verify it compiles**

Run:

```bash
cd daml-packages/daml-vault && dpm build
```

Expected: Build may fail because `TestRequestId.daml` and `Erc20Vault.daml` still use the old signature. That's OK — we fix those next.

- [ ] **Step 3: Commit**

```bash
git add daml-packages/daml-vault/daml/RequestId.daml
git commit -m "feat(daml): update computeRequestId for operators multi-sig and nonceCidText"
```

---

### Task 3: Rewrite `Erc20Vault.daml` — Vault layer

**Files:**

- Rewrite: `daml-packages/daml-vault/daml/Erc20Vault.daml`

Replace the entire `VaultOrchestrator` monolith with the new Vault layer. This is the largest single change.

- [ ] **Step 1: Replace `Erc20Vault.daml` contents**

```daml
module Erc20Vault where

import DA.Action (when, void)
import DA.List ((!!) , sort, unique)
import DA.Crypto.Text (BytesHex, PublicKeyHex, SignatureHex, secp256k1WithEcdsaOnly)

import EvmTypes (EvmTransactionParams)
import Eip712 (chainIdToDecimalText)
import RequestId (computeRequestId, computeResponseHash)
import Abi (hasErrorPrefix, abiDecodeBool)
import Signer (Signer(..), SignRequest(..), SignBidirectionalEvent,
               SignatureRespondedEvent(..), RespondBidirectionalEvent(..),
               SignBidirectional(..), Execute(..),
               Consume_SignatureResponded(..), Consume_RespondBidirectional(..))

-- ---------------------------------------------------------------------------
-- Auth contracts
-- ---------------------------------------------------------------------------

template AuthorizationProposal
  with
    issuer : Party
    owner  : Party
  where
    signatory issuer
    observer owner

template Authorization
  with
    issuer        : Party
    owner         : Party
    remainingUses : Int
  where
    signatory issuer
    observer owner
    ensure remainingUses > 0

-- ---------------------------------------------------------------------------
-- Holdings
-- ---------------------------------------------------------------------------

template Erc20Holding
  with
    operators    : [Party]
    owner        : Party
    erc20Address : BytesHex
    amount       : BytesHex
  where
    signatory operators
    observer owner

-- ---------------------------------------------------------------------------
-- Pending anchors (single-use via archive)
-- ---------------------------------------------------------------------------

template PendingDeposit
  with
    operators   : [Party]
    sender      : Party
    sigNetwork  : Party
    requestId   : BytesHex
    evmTxParams : EvmTransactionParams
  where
    signatory operators
    observer sender, sigNetwork
    ensure not (null operators)

template PendingWithdrawal
  with
    operators    : [Party]
    sender       : Party
    sigNetwork   : Party
    requestId    : BytesHex
    evmTxParams  : EvmTransactionParams
    erc20Address : BytesHex
    amount       : BytesHex
  where
    signatory operators
    observer sender, sigNetwork
    ensure not (null operators)

-- ---------------------------------------------------------------------------
-- VaultProposal — multi-party agreement for Vault creation
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Vault — ERC20 custody
-- ---------------------------------------------------------------------------

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

    -- Auth card management
    nonconsuming choice RequestAuthorization : ContractId AuthorizationProposal
      with
        sender : Party
      controller sender
      do
        create AuthorizationProposal with
          issuer = head operators
          owner = sender

    nonconsuming choice ApproveAuthorization : ContractId Authorization
      with
        proposalCid   : ContractId AuthorizationProposal
        remainingUses : Int
      controller operators
      do
        proposal <- fetch proposalCid
        assertMsg "Proposal issuer mismatch" (proposal.issuer `elem` operators)
        archive proposalCid
        create Authorization with
          issuer = proposal.issuer
          owner = proposal.owner
          remainingUses

    -- Deposit flow
    nonconsuming choice RequestDeposit
      : (ContractId SignBidirectionalEvent, ContractId PendingDeposit)
      with
        sender       : Party
        signerCid    : ContractId Signer
        path         : Text
        evmTxParams  : EvmTransactionParams
        authCid      : ContractId Authorization
        nonceCidText : Text
        keyVersion   : Int
        algo         : Text
        dest         : Text
        params       : Text
        outputDeserializationSchema : Text
        respondSerializationSchema  : Text
      controller sender
      do
        signer <- fetch signerCid
        assertMsg "sigNetwork mismatch" (signer.sigNetwork == sigNetwork)

        auth <- fetch authCid
        assertMsg "Auth issuer mismatch" (auth.issuer `elem` operators)
        assertMsg "Auth owner mismatch" (auth.owner == sender)
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

        let senderPath = partyToText sender <> "," <> path
        let caip2Id = "eip155:" <> chainIdToDecimalText evmTxParams.chainId
        let operatorTexts = map partyToText operators

        signReqCid <- create SignRequest with
          operators; sender; sigNetwork
          evmTxParams; caip2Id; keyVersion
          path = senderPath; algo; dest; params
          nonceCidText
          outputDeserializationSchema; respondSerializationSchema

        signEventCid <- exercise signerCid SignBidirectional with
          signRequestCid = signReqCid; sender

        let requestId = computeRequestId
              operatorTexts (partyToText sender) evmTxParams caip2Id keyVersion
              senderPath algo dest params nonceCidText

        pendingCid <- create PendingDeposit with
          operators; sender; sigNetwork; requestId; evmTxParams

        pure (signEventCid, pendingCid)

    nonconsuming choice ClaimDeposit : ContractId Erc20Holding
      with
        sender            : Party
        pendingDepositCid : ContractId PendingDeposit
        outcomeCid        : ContractId RespondBidirectionalEvent
        sigCid            : ContractId SignatureRespondedEvent
      controller sender
      do
        pending <- fetch pendingDepositCid
        archive pendingDepositCid

        assertMsg "Sender mismatch" (pending.sender == sender)
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

        exercise outcomeCid Consume_RespondBidirectional with actor = sender
        exercise sigCid Consume_SignatureResponded with actor = sender

        let amount = (pending.evmTxParams).args !! 1
        create Erc20Holding with
          operators
          owner = sender
          erc20Address = (pending.evmTxParams).to
          amount

    -- Withdrawal flow
    nonconsuming choice RequestWithdrawal
      : (ContractId SignBidirectionalEvent, ContractId PendingWithdrawal)
      with
        sender           : Party
        signerCid        : ContractId Signer
        evmTxParams      : EvmTransactionParams
        recipientAddress : BytesHex
        balanceCid       : ContractId Erc20Holding
        nonceCidText     : Text
        keyVersion       : Int
        algo             : Text
        dest             : Text
        params           : Text
        outputDeserializationSchema : Text
        respondSerializationSchema  : Text
      controller sender
      do
        holding <- fetch balanceCid
        assertMsg "Holding operators mismatch" (sort holding.operators == sort operators)
        assertMsg "Holding owner mismatch" (holding.owner == sender)

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
        let operatorTexts = map partyToText operators

        signer <- fetch signerCid
        assertMsg "sigNetwork mismatch" (signer.sigNetwork == sigNetwork)

        signReqCid <- create SignRequest with
          operators; sender; sigNetwork
          evmTxParams; caip2Id; keyVersion
          path = "root"; algo; dest; params
          nonceCidText
          outputDeserializationSchema; respondSerializationSchema

        signEventCid <- exercise signerCid SignBidirectional with
          signRequestCid = signReqCid; sender

        let requestId = computeRequestId
              operatorTexts (partyToText sender) evmTxParams caip2Id keyVersion
              "root" algo dest params nonceCidText

        pendingCid <- create PendingWithdrawal with
          operators; sender; sigNetwork; requestId; evmTxParams
          erc20Address = holding.erc20Address
          amount = holding.amount

        pure (signEventCid, pendingCid)

    nonconsuming choice CompleteWithdrawal : Optional (ContractId Erc20Holding)
      with
        sender               : Party
        pendingWithdrawalCid : ContractId PendingWithdrawal
        outcomeCid           : ContractId RespondBidirectionalEvent
        sigCid               : ContractId SignatureRespondedEvent
      controller sender
      do
        pending <- fetch pendingWithdrawalCid
        archive pendingWithdrawalCid

        assertMsg "Sender mismatch" (pending.sender == sender)
        assertMsg "Operators mismatch" (sort pending.operators == sort operators)

        outcome <- fetch outcomeCid
        assertMsg "Outcome requestId mismatch"
          (outcome.requestId == pending.requestId)

        let responseHash = computeResponseHash pending.requestId outcome.serializedOutput
        assertMsg "Invalid MPC signature"
          (secp256k1WithEcdsaOnly outcome.signature responseHash evmMpcPublicKey)

        exercise outcomeCid Consume_RespondBidirectional with actor = sender
        exercise sigCid Consume_SignatureResponded with actor = sender

        let shouldRefund =
              if hasErrorPrefix outcome.serializedOutput then True
              else not (abiDecodeBool outcome.serializedOutput 0)

        if not shouldRefund
          then pure None
          else do
            refundCid <- create Erc20Holding with
              operators
              owner = sender
              erc20Address = pending.erc20Address
              amount = pending.amount
            pure (Some refundCid)
```

- [ ] **Step 2: Verify it compiles**

Run:

```bash
dpm build --all
```

Expected: `Signer.daml` and `Erc20Vault.daml` compile. `TestVault.daml` and `TestRequestId.daml` will fail (they use old names). That's expected — we fix those next.

- [ ] **Step 3: Commit**

```bash
git add daml-packages/daml-vault/daml/Erc20Vault.daml
git commit -m "feat(daml): replace VaultOrchestrator with Vault + multi-sig operators"
```

---

### Task 4: Rewrite `TestVault.daml` — all Daml Script tests

**Files:**

- Rewrite: `daml-packages/daml-vault/daml/TestVault.daml`

Every test must be updated for:

1. New party model: `operators : [Party]` instead of `issuer : Party`, no `mpc` party
2. New template names: `Vault`, `Signer`, `Authorization`, etc.
3. New choice names: `RequestDeposit`, `ClaimDeposit`, etc.
4. New flow: Vault + Signer (two singletons), `RequestDeposit` returns tuple
5. `Erc20Holding` now has `operators : [Party]` instead of `issuer : Party`

The test structure should mirror the current tests but with new names. Key tests:

- Deposit lifecycle (happy path)
- Auth card management (request, approve, decrement, reject 0 uses)
- Claim deposit (happy path with MPC sig verification)
- Claim rejects wrong requester, wrong requestId, MPC failure, bool(false)
- Withdrawal lifecycle (request, complete success, complete failure/refund)
- Withdrawal rejects wrong owner, wrong ERC20, wrong amount, wrong recipient
- Controller tests (wrong controller on approve, respond, etc.)
- Auth card forgery (wrong issuer, wrong owner)

**NOTE:** The `testClaimHappyPath` and `testClaimAsRequester` tests directly create `PendingEvmTx`, `EcdsaSignature`, `EvmTxOutcomeSignature` via `createCmd`. In the new model, these become `PendingDeposit`, `SignatureRespondedEvent`, `RespondBidirectionalEvent`. The signatories change too — evidence contracts now have `sigNetwork` as signatory (not `issuer`/operators).

For tests that verify MPC signature validation (`testClaimHappyPath`), the test fixtures (`claimTestPubKey`, `claimTestSignature`, `claimTestRequestId`) are hardcoded golden values. The `requestId` computation changed (new EIP-712 type hash, new fields). So **the golden requestId will change** and we need to regenerate it.

**Approach for test fixtures:** For v1 of the tests, use a simplified approach:

- Skip MPC signature verification tests temporarily (comment out `testClaimHappyPath` etc.)
- OR use the new `computeRequestId` to compute requestIds in tests instead of hardcoded values
- Regenerate golden values after TypeScript crypto tests are updated (Part 2)

- [ ] **Step 1: Write the test file**

This is a large file. Write tests incrementally — start with the setup helper and basic lifecycle tests. The test must:

1. Create a `Signer` (sigNetwork party)
2. Create a `Vault` (operators party) — directly via `createCmd` (skip VaultProposal for unit tests)
3. Exercise vault choices using `submit (actAs sender <> readAs operators <> readAs sigNetwork)`

Note on authority: In Daml Script, `submit` runs as the submitting party. For `RequestDeposit` (controller: sender), the sender submits. But the choice body creates `SignRequest` (signatory: operators) — this requires operators authority. Since `RequestDeposit` is a nonconsuming choice on `Vault` (signatory: operators), the Vault's signatory authority is available in the choice body. The sender needs `readAs` for the Vault contract (or use disclosed contracts).

**IMPORTANT:** In Daml Script tests, disclosed contracts work differently than in the JSON API. Use `actAs` + `readAs` permissions to grant visibility. For the Signer (which the sender needs to exercise `SignBidirectional` on), the sender needs `readAs sigNetwork`.

Write the full test file. Due to the size, focus on the core tests first and add edge cases iteratively.

- [ ] **Step 2: Build and run tests**

Run:

```bash
dpm build --all
cd daml-packages/daml-vault && dpm test
```

Fix any compilation or test failures.

- [ ] **Step 3: Commit**

```bash
git add daml-packages/daml-vault/daml/TestVault.daml
git commit -m "test(daml): rewrite vault tests for signer/vault split"
```

---

### Task 5: Update `TestRequestId.daml` — new `computeRequestId` signature

**Files:**

- Modify: `daml-packages/daml-vault/daml/TestRequestId.daml`

Update all `computeRequestId` calls to use the new signature:

```daml
-- Old: computeRequestId sender evmParams caip2Id keyVersion path algo dest authCidText
-- New: computeRequestId operatorTexts sender evmParams caip2Id keyVersion path algo dest params nonceCidText
```

The golden values (expected requestId hashes) will change because the EIP-712 type hash changed. For now, update the function calls and let the tests compute expected values dynamically (or update golden values after regenerating from TypeScript).

- [ ] **Step 1: Update test calls**

Update the `computeRequestId` calls in `TestRequestId.daml` to use the new signature. Since the EIP-712 type hash changed, the golden values need to be regenerated.

**Approach:** For each test that checks `computeRequestId`, pass `["operator1_text"]` as the operators list and add `"params"` and `"nonceCidText"` arguments. The expected hash will change — regenerate from TypeScript tests later.

- [ ] **Step 2: Build and run**

```bash
dpm build --all
cd daml-packages/daml-vault && dpm test
```

- [ ] **Step 3: Commit**

```bash
git add daml-packages/daml-vault/daml/TestRequestId.daml
git commit -m "test(daml): update requestId tests for new signature with operators"
```

---

### Task 6: Final build and test verification

- [ ] **Step 1: Full build**

```bash
dpm build --all
```

- [ ] **Step 2: Run ALL Daml tests**

```bash
for pkg in daml-abi daml-uint256 daml-evm-types daml-eip712 daml-vault; do
  echo "--- Testing $pkg ---"
  (cd daml-packages/$pkg && dpm test)
done
```

Expected: All tests pass. The `daml-abi`, `daml-uint256`, `daml-evm-types`, `daml-eip712` packages should be unaffected.

- [ ] **Step 3: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix(daml): resolve remaining test failures from signer/vault split"
```

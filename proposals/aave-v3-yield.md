# Aave V3 Yield — Supply & Withdraw via MPC Vault

## Overview

Extend the vault to **supply ERC-20 holdings to Aave V3** on Sepolia, earning yield
on deposited assets. The user's `Erc20Holding` is consumed, the vault calls
`Pool.supply()`, and an `AavePosition` contract is created on Canton to track the
deposit. Later, the user can withdraw (including accrued yield) back into an
`Erc20Holding`.

**Why Aave V3:** best testnet coverage on Sepolia — fully deployed, faucet available,
9 assets supported, 86k+ transactions on the Pool contract.

## Sepolia Addresses

| Contract       | Address                                      |
| -------------- | -------------------------------------------- |
| Aave V3 Pool   | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` |
| USDC (test)    | `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8` |
| aUSDC (aToken) | `0x16dA4541aD1807f4443d92D26044C1147406EB80` |
| DAI (test)     | `0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357` |
| aDAI (aToken)  | `0x29598b72eb5CeBd806C5dCD549490FdA35B13cD8` |
| WETH (test)    | `0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c` |
| aWETH (aToken) | `0x5b071b590a59395fE4025A0Ccc1FcC931AAc1830` |
| Aave Faucet    | `0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D` |

## Sequence Diagram

```
 User              Canton                MPC Service         Sepolia
  |                  |                       |                  |
  |  RequestEvmApprove(token, Pool, max)     |                  |
  |----------------->|                       |                  |
  |                  | PendingEvmTx(approve)  |                  |
  |                  |---------------------->|                  |
  |                  |                       | sign + submit    |
  |                  |                       |----------------->|
  |                  |                       | EcdsaSignature   |
  |                  |<----------------------|                  |
  |                  |                       | outcome sig      |
  |                  |<----------------------|                  |
  |  ClaimEvmApprove |                       |                  |
  |----------------->| (verify, archive)     |                  |
  |                  |                       |                  |
  |  RequestAaveSupply(holdingCid, pool)     |                  |
  |----------------->|                       |                  |
  |                  | archive Erc20Holding  |                  |
  |                  | PendingEvmTx(supply)   |                  |
  |                  |---------------------->|                  |
  |                  |                       | sign + submit    |
  |                  |                       |----------------->|
  |                  |                       | EcdsaSignature   |
  |                  |<----------------------|                  |
  |                  |                       | outcome sig      |
  |                  |<----------------------|                  |
  |  ClaimAaveSupply |                       |                  |
  |----------------->| verify outcome        |                  |
  |                  | create AavePosition   |                  |
  |  <-- AavePosition                       |                  |
  |                  |                       |                  |
  :       ... time passes, yield accrues ... :                  :
  |                  |                       |                  |
  |  RequestAaveWithdraw(positionCid)        |                  |
  |----------------->|                       |                  |
  |                  | archive AavePosition  |                  |
  |                  | PendingEvmTx(withdraw) |                  |
  |                  |---------------------->|                  |
  |                  |                       | sign + submit    |
  |                  |                       |----------------->|
  |                  |                       | EcdsaSignature   |
  |                  |<----------------------|                  |
  |                  |                       | outcome sig      |
  |                  |<----------------------|                  |
  |  CompleteAaveWithdraw                    |                  |
  |----------------->| verify outcome        |                  |
  |                  | decode amountWithdrawn|                  |
  |                  | create Erc20Holding   |                  |
  |  <-- Erc20Holding (amount + yield)       |                  |
```

## EVM Functions

### 1. ERC-20 `approve` (one-time setup per token)

```
function approve(address spender, uint256 amount) returns (bool)
selector: 0x095ea7b3
```

**EvmTransactionParams:**

| Field               | Value                                                                            |
| ------------------- | -------------------------------------------------------------------------------- |
| `to`                | token address (e.g., USDC `94a9d9...c8`)                                         |
| `functionSignature` | `"approve(address,uint256)"`                                                     |
| `args[0]`           | Pool address, left-padded to 32 bytes                                            |
| `args[1]`           | `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` (max uint256) |
| `value`             | `00..00` (32 bytes zero)                                                         |

**Schema:** `outputDeserializationSchema = [{"name":"","type":"bool"}]`
**Schema:** `respondSerializationSchema = [{"name":"","type":"bool"}]`

### 2. Aave `supply`

```
function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)
selector: 0x617ba037
```

**EvmTransactionParams:**

| Field               | Value                                               |
| ------------------- | --------------------------------------------------- |
| `to`                | Pool `6ae43d3271ff6888e7fc43fd7321a503ff738951`     |
| `functionSignature` | `"supply(address,uint256,address,uint16)"`          |
| `args[0]`           | asset address, left-padded to 32 bytes              |
| `args[1]`           | amount, left-padded to 32 bytes                     |
| `args[2]`           | vault address (onBehalfOf), left-padded to 32 bytes |
| `args[3]`           | `00..00` (referralCode = 0)                         |
| `value`             | `00..00` (32 bytes zero)                            |

**Schema:** `outputDeserializationSchema = []` (supply returns void)
**Schema:** `respondSerializationSchema = []`

### 3. Aave `withdraw`

```
function withdraw(address asset, uint256 amount, address to) returns (uint256)
selector: 0x69328dec
```

**EvmTransactionParams:**

| Field               | Value                                              |
| ------------------- | -------------------------------------------------- |
| `to`                | Pool `6ae43d3271ff6888e7fc43fd7321a503ff738951`    |
| `functionSignature` | `"withdraw(address,uint256,address)"`              |
| `args[0]`           | asset address, left-padded to 32 bytes             |
| `args[1]`           | `ff..ff` (max uint256 = withdraw all)              |
| `args[2]`           | vault address (recipient), left-padded to 32 bytes |
| `value`             | `00..00` (32 bytes zero)                           |

**Schema:** `outputDeserializationSchema = [{"name":"amountWithdrawn","type":"uint256"}]`
**Schema:** `respondSerializationSchema = [{"name":"amountWithdrawn","type":"uint256"}]`

## Daml Contract Changes

### New TxSource Variants

```daml
data TxSource
  = DepositSource (ContractId DepositAuthorization)
  | WithdrawalSource (ContractId Erc20Holding)
  | ApproveSource                                    -- NEW
  | AaveSupplySource (ContractId Erc20Holding)       -- NEW
  | AaveWithdrawSource (ContractId AavePosition)     -- NEW
```

### New Template: AavePosition

```daml
template AavePosition
  with
    issuer  : Party
    owner   : Party
    mpc     : Party
    asset   : BytesHex    -- underlying token address (e.g., USDC)
    amount  : BytesHex    -- 32 bytes, amount originally supplied
    pool    : BytesHex    -- Aave Pool address
    vaultId : Text
  where
    signatory issuer
    observer owner, mpc
```

### New Choices on VaultOrchestrator

#### RequestEvmApprove (nonconsuming, issuer-controlled)

Generic ERC-20 approval — reusable for any protocol integration.

```daml
nonconsuming choice RequestEvmApprove : ContractId PendingEvmTx
  with
    token   : BytesHex    -- ERC-20 contract address
    spender : BytesHex    -- protocol contract to approve
    evmParams : EvmTransactionParams
  controller issuer
  do
    assertMsg "must be approve" $
      evmParams.functionSignature == "approve(address,uint256)"
    assertMsg "to must be token" $
      evmParams.to == token

    let requestPath = "root"
        predecessorId = vaultId <> show issuer
        requestId = computeRequestId
          (show issuer) evmParams caip2Id keyVersion
          requestPath algo (show spender) ""

    create PendingEvmTx with
      source = ApproveSource
      path = requestPath
      nonceCidText = ""
      outputDeserializationSchema = "[{\"name\":\"\",\"type\":\"bool\"}]"
      respondSerializationSchema = "[{\"name\":\"\",\"type\":\"bool\"}]"
      ..
```

#### ClaimEvmApprove (nonconsuming)

```daml
nonconsuming choice ClaimEvmApprove : ()
  with
    requester    : Party
    pendingCid   : ContractId PendingEvmTx
    outcomeCid   : ContractId EvmTxOutcomeSignature
    signatureCid : ContractId EcdsaSignature
  controller requester
  do
    pending <- fetch pendingCid
    outcome <- fetch outcomeCid
    sig     <- fetch signatureCid

    -- verify MPC signature on outcome
    assertMsg "requestId mismatch" $ pending.requestId == outcome.requestId
    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "invalid MPC signature" $
      verifyEcdsaSignature mpcPublicKey responseHash outcome.signature

    -- verify approve returned true
    let output = outcome.mpcOutput
    assertMsg "approve failed" $ not (hasErrorPrefix output)
    let decoded = abiDecodeBool (stripErrorPrefix output) 0
    assertMsg "approve returned false" decoded

    archive pendingCid
    archive outcomeCid
    archive signatureCid
```

#### RequestAaveSupply (nonconsuming)

```daml
nonconsuming choice RequestAaveSupply : ContractId PendingEvmTx
  with
    requester  : Party
    holdingCid : ContractId Erc20Holding
    pool       : BytesHex
    evmParams  : EvmTransactionParams
  controller requester
  do
    holding <- fetch holdingCid

    assertMsg "owner mismatch" $ holding.owner == requester
    assertMsg "issuer mismatch" $ holding.issuer == issuer
    assertMsg "must be supply" $
      evmParams.functionSignature == "supply(address,uint256,address,uint16)"
    assertMsg "to must be pool" $ evmParams.to == pool

    archive holdingCid

    let requestPath = "root"
        predecessorId = vaultId <> show issuer
        nonceCidText = show holdingCid
        requestId = computeRequestId
          (show requester) evmParams caip2Id keyVersion
          requestPath algo (show pool) nonceCidText

    create PendingEvmTx with
      source = AaveSupplySource holdingCid
      path = requestPath
      outputDeserializationSchema = "[]"
      respondSerializationSchema = "[]"
      ..
```

#### ClaimAaveSupply (nonconsuming)

```daml
nonconsuming choice ClaimAaveSupply : ContractId AavePosition
  with
    requester    : Party
    pendingCid   : ContractId PendingEvmTx
    outcomeCid   : ContractId EvmTxOutcomeSignature
    signatureCid : ContractId EcdsaSignature
  controller requester
  do
    pending <- fetch pendingCid
    outcome <- fetch outcomeCid

    -- verify MPC signature
    assertMsg "requestId mismatch" $ pending.requestId == outcome.requestId
    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "invalid MPC signature" $
      verifyEcdsaSignature mpcPublicKey responseHash outcome.signature

    -- supply() returns void — just check no error prefix
    assertMsg "supply failed" $ not (hasErrorPrefix outcome.mpcOutput)

    -- extract asset and amount from the original evmParams args
    let asset  = pending.evmParams.args !! 0  -- args[0] = asset address
        amount = pending.evmParams.args !! 1  -- args[1] = amount

    archive pendingCid
    archive outcomeCid
    archive signatureCid

    create AavePosition with
      owner = requester
      pool = pending.evmParams.to
      ..
```

#### RequestAaveWithdraw (nonconsuming)

```daml
nonconsuming choice RequestAaveWithdraw : ContractId PendingEvmTx
  with
    requester   : Party
    positionCid : ContractId AavePosition
    evmParams   : EvmTransactionParams
  controller requester
  do
    position <- fetch positionCid

    assertMsg "owner mismatch" $ position.owner == requester
    assertMsg "must be withdraw" $
      evmParams.functionSignature == "withdraw(address,uint256,address)"
    assertMsg "to must be pool" $ evmParams.to == position.pool

    archive positionCid

    let requestPath = "root"
        nonceCidText = show positionCid
        requestId = computeRequestId
          (show requester) evmParams caip2Id keyVersion
          requestPath algo (show position.pool) nonceCidText

    create PendingEvmTx with
      source = AaveWithdrawSource positionCid
      path = requestPath
      outputDeserializationSchema = "[{\"name\":\"amountWithdrawn\",\"type\":\"uint256\"}]"
      respondSerializationSchema = "[{\"name\":\"amountWithdrawn\",\"type\":\"uint256\"}]"
      ..
```

#### CompleteAaveWithdraw (nonconsuming)

```daml
nonconsuming choice CompleteAaveWithdraw
    : Optional (ContractId Erc20Holding)
  with
    requester    : Party
    pendingCid   : ContractId PendingEvmTx
    outcomeCid   : ContractId EvmTxOutcomeSignature
    signatureCid : ContractId EcdsaSignature
  controller requester
  do
    pending <- fetch pendingCid
    outcome <- fetch outcomeCid

    -- verify MPC signature
    assertMsg "requestId mismatch" $ pending.requestId == outcome.requestId
    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "invalid MPC signature" $
      verifyEcdsaSignature mpcPublicKey responseHash outcome.signature

    archive pendingCid
    archive outcomeCid
    archive signatureCid

    if hasErrorPrefix outcome.mpcOutput then do
      -- withdraw failed — recreate position as refund
      -- (in practice, Aave withdraw rarely fails)
      pure None
    else do
      -- decode actual amount withdrawn (includes yield)
      let withdrawnAmount = abiSlot outcome.mpcOutput 0
          asset = pending.evmParams.args !! 0

      holdingCid <- create Erc20Holding with
        owner = requester
        amount = withdrawnAmount
        erc20Contract = asset
        ..
      pure (Some holdingCid)
```

## MPC Service Changes

**None.** The existing MPC service pipeline (`signAndEnqueue` → `checkPendingTx`) is
fully generic — it processes any `PendingEvmTx` regardless of function signature.

The only consideration is void-returning functions (`supply`). The MPC service's
`extractReturnData` (from the ABI migration) should handle empty return data by
returning an empty hex string. Verify this works for `respondSerializationSchema = "[]"`.

## E2E Test Plan

### Test: `aave-supply-e2e.test.ts`

**Setup (beforeAll, 60s):**

1. `setupVault()` — allocate parties, upload DAR, create VaultOrchestrator
2. Fund vault address with test USDC from Aave faucet (`0xC959...`):
   - Call `faucet.mint(USDC, vaultAddress, 10_000e6)` on Sepolia
3. Start MPC server
4. Execute `RequestEvmApprove` for USDC → Aave Pool (max uint256)
5. Wait for MPC to sign + submit approve tx
6. Exercise `ClaimEvmApprove`

**Test 1: Supply USDC to Aave (300s):**

1. Create `Erc20Holding` via standard deposit flow (or direct create for test)
2. Exercise `RequestAaveSupply` with holding
3. Wait for MPC to sign + submit supply tx
4. Exercise `ClaimAaveSupply`
5. Assert: `AavePosition` created with correct asset/amount/pool
6. Verify on Sepolia: vault address has aUSDC balance > 0

**Test 2: Withdraw from Aave with yield (300s):**

1. Wait a few blocks (yield accrues per block on testnet)
2. Exercise `RequestAaveWithdraw` with position
3. Wait for MPC to sign + submit withdraw tx
4. Exercise `CompleteAaveWithdraw`
5. Assert: new `Erc20Holding` created
6. Assert: holding amount >= original supply amount (yield accrued)
7. Verify on Sepolia: vault aUSDC balance == 0, USDC balance restored

### Env Variables (additions)

```
AAVE_POOL_ADDRESS=0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951
AAVE_FAUCET_ADDRESS=0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D
```

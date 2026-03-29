# Aave V3 Yield — Supply & Withdraw via MPC Vault

## Overview

Extend the vault to **supply ERC-20 tokens to Aave V3** on Sepolia, earning
yield on deposited assets. The user's `Erc20Holding` for the underlying token
(e.g., USDC) is consumed, the vault supplies to Aave and wraps into
**stataUSDC** (Aave's ERC-4626 static aToken), and a new `Erc20Holding` for
the shares token is created on Canton. Later, the user can redeem shares
back into underlying tokens (including accrued yield).

**Why Aave V3:** best testnet coverage on Sepolia — fully deployed, faucet
available, 9 assets supported. StataToken (ERC-4626 wrapper) is deployed on
Sepolia, giving us shares-based yield tracking.

## Design Decisions

### Per-User Derived Addresses (not shared root)

Each Canton user already has their own derived Ethereum address via the MPC
path mechanism (`path = "{sender},{userPath}"`). Instead of pooling all
tokens into a single vault root address, each user's derived address
interacts with Aave independently:

```
Alice: path = "Alice,deposit-1" → 0xABC...  (unique ETH address)
Bob:   path = "Bob,deposit-1"   → 0xDEF...  (unique ETH address)

Alice's 0xABC → supply 100 USDC → Aave tracks balanceOf(0xABC) independently
Bob's   0xDEF → supply 200 USDC → Aave tracks balanceOf(0xDEF) independently
```

**Why:** Aave tracks one balance per address. Sharing a single EOA would
require pro-rata yield accounting on Canton. Per-user addresses give natural
isolation — each user's yield is theirs, no shared balance math needed.

### Shares Model (stataUSDC, not aUSDC)

DeFi yield tokens use one of three fundamental models:

| Model                                           | Balance           | Price         | Canton-friendly?                      |
| ----------------------------------------------- | ----------------- | ------------- | ------------------------------------- |
| **Rebasing** (aUSDC, stETH)                     | Changes over time | Stays ~pegged | No — `Erc20Holding.amount` goes stale |
| **Shares / ERC-4626** (stataUSDC, wstETH, sDAI) | Fixed             | Grows         | Yes — amount is always correct        |
| **Claimable** (CRV gauges, COMP)                | Fixed             | Fixed         | Needs separate claim choice           |

We use **stataUSDC** (Aave's ERC-4626 static aToken wrapper):

- Balance stays constant — `Erc20Holding.amount` is always correct
- Yield accrues in the exchange rate, not the balance
- Standard ERC-20 — composable with Uniswap, Morpho, etc.
- Uniswap V3/V4 explicitly does not support rebasing tokens (yield is lost)

**No new templates needed.** `Erc20Holding` tracks both USDC and stataUSDC
— they're both ERC-20 tokens.

### StaticATokenLM (V1) — ERC-4626 Wrapper on Sepolia

Sepolia deploys the V1 `StaticATokenLM` (from `bgd-labs/static-a-token-v3`),
not the newer `StataTokenV2`. V1 wraps Aave's rebasing aTokens into
non-rebasing ERC-4626 shares with explicit `depositToAave`/`withdrawFromAave`
booleans.

Key functions:

- `deposit(uint256, address, uint16, bool) → uint256` — when
  `depositToAave = true`: takes raw USDC, supplies to Aave internally,
  mints shares. When `false`: takes aUSDC directly.
- `redeem(uint256, address, address, bool) → uint256` — when
  `withdrawFromAave = true`: burns shares, withdraws from Aave, returns raw
  USDC. When `false`: returns aUSDC.
- `rate()` — returns current exchange rate
- `aToken()` — returns the underlying aToken address
- `convertToAssets(shares)` — returns current USDC value including yield
- `claimRewards()` — claim Aave liquidity mining incentives
- No protocol fee for wrapping/unwrapping

**V2 note:** Mainnet uses `StataTokenV2` (from `aave-dao/aave-v3-origin`)
where the standard ERC-4626 `deposit(uint256, address)` handles raw
underlying directly (no boolean needed). If Sepolia is upgraded to V2 in
the future, switch to the 2-arg signatures.

## Sepolia Addresses

| Contract          | Address                                                  |
| ----------------- | -------------------------------------------------------- |
| Aave V3 Pool      | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`             |
| USDC (test)       | `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`             |
| aUSDC (aToken)    | `0x16dA4541aD1807f4443d92D26044C1147406EB80`             |
| StataTokenFactory | `0xd210dFB43B694430B8d31762B5199e30c31266C8` (V1 legacy) |
| stataUSDC         | `0x8A88124522dbBF1E56352ba3DE1d9F78C143751e`             |
| stataDAI          | `0xDE46e43F46ff74A23a65EBb0580cbe3dFE684a17`             |
| stataWETH         | `0x162B500569F42D9eCe937e6a61EDfef660A12E98`             |
| Aave Faucet       | `0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D`             |

**Sepolia deploys V1 (`StaticATokenLM`), not V2 (`StataTokenV2`).** The
function signatures differ — V1 uses 4-arg `deposit`/`redeem` with a
`depositToAave`/`withdrawFromAave` boolean. See EVM Functions below.
Factory lookup: `getStaticAToken(underlying)` (NOT `getStataToken`).

## Sequence Diagram

### Approve (one-time setup)

```
 User                           Canton (VaultOrchestrator)     MPC Service                    Sepolia
 |                              |                              |                              |
 | (user already has Erc20Holding(USDC) from prior deposit)    |                              |
 |                              |                              |                              |
 | 1. RequestEvmApprove         |                              |                              |
 |    (USDC, stataToken, max)   |                              |                              |
 |----------------------------->|                              |                              |
 |                              | creates PendingEvmTx         |                              |
 |                              |   approve(stataToken, max)   |                              |
 |                              |----------------------------->|                              |
 |                              |                              | derive child key (user path) |
 |                              |                              | sign approve tx              |
 |                              |                              |----------------------------->|
 |                              |                              |       USDC.approve(stata,max)|
 |                              |                              |<-----------------------------|
 |                              | SignEvmTx                    |                              |
 |                              |<----- EcdsaSignature --------|                              |
 |                              |                              | re-simulate, extract output  |
 |                              | ProvideEvmOutcomeSig         |                              |
 |                              |<-- EvmTxOutcomeSignature ----|                              |
 |                              |                              |                              |
 | 2. ClaimEvmApprove           |                              |                              |
 |----------------------------->|                              |                              |
 |                              | verify MPC signature         |                              |
 |                              | decode bool (approve=true)   |                              |
 |                              | archive pending + sigs       |                              |
 |                              |                              |                              |
```

### Supply (USDC → stataUSDC)

```
 User                           Canton (VaultOrchestrator)     MPC Service                    Sepolia
 |                              |                              |                              |
 | 3. RequestAaveSupply         |                              |                              |
 |    (holdingCid, stataToken)  |                              |                              |
 |----------------------------->|                              |                              |
 |                              | fetch + archive              |                              |
 |                              |   Erc20Holding(USDC)         |                              |
 |                              | creates PendingEvmTx         |                              |
 |                              |   deposit(amt,addr,0,true)   |                              |
 |                              |----------------------------->|                              |
 |                              |                              | derive child key (user path) |
 |                              |                              | sign deposit tx              |
 |                              |                              |----------------------------->|
 |                              |                              |   stataToken.deposit(...)    |
 |                              |                              |     USDC → Pool.supply()     |
 |                              |                              |     aUSDC → wrap → stataUSDC |
 |                              |                              |<-----------------------------|
 |                              | SignEvmTx                    |                              |
 |                              |<----- EcdsaSignature --------|                              |
 |                              |                              | re-simulate, extract shares  |
 |                              | ProvideEvmOutcomeSig         |                              |
 |                              |<-- EvmTxOutcomeSignature ----|                              |
 |                              |     (mpcOutput = sharesOut)  |                              |
 |                              |                              |                              |
 | 4. ClaimAaveSupply           |                              |                              |
 |----------------------------->|                              |                              |
 |                              | verify MPC signature         |                              |
 |                              | decode uint256 sharesOut     |                              |
 |                              | create Erc20Holding          |                              |
 |                              |   (stataUSDC, sharesOut)     |                              |
 |<---- Erc20Holding(stataUSDC) |                              |                              |
 |                              |                              |                              |
 :   ... time passes ...        :                              :                              :
 :   stataUSDC balance unchanged:                              :                              :
 :   exchange rate grows (yield):                              :                              :
 |                              |                              |                              |
```

### Withdraw (stataUSDC → USDC + yield)

```
 User                           Canton (VaultOrchestrator)     MPC Service                    Sepolia
 |                              |                              |                              |
 | 5. RequestAaveWithdraw       |                              |                              |
 |    (holdingCid)              |                              |                              |
 |----------------------------->|                              |                              |
 |                              | fetch + archive              |                              |
 |                              |   Erc20Holding(stataUSDC)    |                              |
 |                              | creates PendingEvmTx         |                              |
 |                              |   redeem(shares,addr,addr,T) |                              |
 |                              |----------------------------->|                              |
 |                              |                              | derive child key (user path) |
 |                              |                              | sign redeem tx               |
 |                              |                              |----------------------------->|
 |                              |                              |   stataToken.redeem(...)     |
 |                              |                              |     burn stataUSDC → aUSDC   |
 |                              |                              |     Pool.withdraw() → USDC   |
 |                              |                              |     (includes accrued yield) |
 |                              |                              |<-----------------------------|
 |                              | SignEvmTx                    |                              |
 |                              |<----- EcdsaSignature --------|                              |
 |                              |                              | re-simulate, extract assets  |
 |                              | ProvideEvmOutcomeSig         |                              |
 |                              |<-- EvmTxOutcomeSignature ----|                              |
 |                              |     (mpcOutput = assetsOut)  |                              |
 |                              |                              |                              |
 | 6. CompleteAaveWithdraw      |                              |                              |
 |----------------------------->|                              |                              |
 |                              | verify MPC signature         |                              |
 |                              | decode uint256 assetsOut     |                              |
 |                              | create Erc20Holding          |                              |
 |                              |   (USDC, assetsOut)          |                              |
 |                              |   assetsOut >= original amt  |                              |
 |<---- Erc20Holding(USDC) ----|   (yield accrued!)           |                              |
 |                              |                              |                              |
```

## EVM Functions

### 1. ERC-20 `approve` (one-time per token/spender)

```
function approve(address spender, uint256 amount) returns (bool)
selector: 0x095ea7b3
```

**EvmTransactionParams:**

| Field               | Value                                                                            |
| ------------------- | -------------------------------------------------------------------------------- |
| `to`                | USDC token address                                                               |
| `functionSignature` | `"approve(address,uint256)"`                                                     |
| `args[0]`           | stataToken address, left-padded to 32 bytes                                      |
| `args[1]`           | `ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` (max uint256) |
| `value`             | `00..00` (32 bytes zero)                                                         |

**Schema:** `outputDeserializationSchema = [{"name":"","type":"bool"}]`
**Schema:** `respondSerializationSchema = [{"name":"","type":"bool"}]`

### 2. StaticATokenLM `deposit` — V1 (USDC → stataUSDC)

```
function deposit(uint256 assets, address receiver, uint16 referralCode, bool depositToAave)
    returns (uint256 shares)
```

With `depositToAave = true`, the contract:

1. Pulls USDC from caller via `transferFrom`
2. Calls `Pool.supply(USDC, amount, address(this), referralCode)` internally
3. Wraps the resulting aUSDC into stataUSDC shares
4. Mints shares to `receiver`

**EvmTransactionParams:**

| Field               | Value                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `to`                | `8a88124522dbbf1e56352ba3de1d9f78c143751e` (stataUSDC on Sepolia) |
| `functionSignature` | `"deposit(uint256,address,uint16,bool)"`                          |
| `args[0]`           | amount of USDC, left-padded to 32 bytes                           |
| `args[1]`           | receiver = user's derived address, left-padded                    |
| `args[2]`           | `00..00` (referralCode = 0)                                       |
| `args[3]`           | `00..01` (depositToAave = true)                                   |
| `value`             | `00..00` (32 bytes zero)                                          |

**Schema:** `outputDeserializationSchema = [{"name":"shares","type":"uint256"}]`
**Schema:** `respondSerializationSchema = [{"name":"shares","type":"uint256"}]`

### 3. StaticATokenLM `redeem` — V1 (stataUSDC → USDC + yield)

```
function redeem(uint256 shares, address receiver, address owner, bool withdrawFromAave)
    returns (uint256 assets)
```

With `withdrawFromAave = true`, the contract burns shares, calls
`Pool.withdraw()` internally, and returns raw USDC. No separate step.

**EvmTransactionParams:**

| Field               | Value                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `to`                | `8a88124522dbbf1e56352ba3de1d9f78c143751e` (stataUSDC on Sepolia) |
| `functionSignature` | `"redeem(uint256,address,address,bool)"`                          |
| `args[0]`           | shares amount (= `Erc20Holding.amount`), 32 bytes                 |
| `args[1]`           | receiver = user's derived address, left-padded                    |
| `args[2]`           | owner = user's derived address, left-padded                       |
| `args[3]`           | `00..01` (withdrawFromAave = true)                                |
| `value`             | `00..00` (32 bytes zero)                                          |

**Schema:** `outputDeserializationSchema = [{"name":"assets","type":"uint256"}]`
**Schema:** `respondSerializationSchema = [{"name":"assets","type":"uint256"}]`

### Transaction Count Summary

| Operation                             | EVM Transactions | Details                                       |
| ------------------------------------- | ---------------- | --------------------------------------------- |
| Approve (one-time)                    | 1                | `USDC.approve(stataToken, max)`               |
| Supply                                | 1                | `stataToken.deposit(amount, addr, 0, true)`   |
| Withdraw                              | 1                | `stataToken.redeem(shares, addr, addr, true)` |
| **Total for supply + withdraw cycle** | **3**            | (approve is one-time)                         |

## Daml Contract Changes

### New TxSource Variants

```daml
data TxSource
  = DepositSource (ContractId DepositAuthorization)
  | WithdrawalSource (ContractId Erc20Holding)
  | ApproveSource                                    -- NEW
  | AaveSupplySource (ContractId Erc20Holding)       -- NEW
  | AaveWithdrawSource (ContractId Erc20Holding)     -- NEW (stataUSDC holding)
```

No `AavePosition` template. Both USDC and stataUSDC are tracked as
`Erc20Holding` with different `erc20Contract` addresses.

### New Choices on VaultOrchestrator

#### RequestEvmApprove (nonconsuming, issuer-controlled)

Generic ERC-20 approval — reusable across Aave, Uniswap, and future
protocol integrations.

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

    assertMsg "requestId mismatch" $ pending.requestId == outcome.requestId
    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "invalid MPC signature" $
      verifyEcdsaSignature mpcPublicKey responseHash outcome.signature

    assertMsg "approve failed" $ not (hasErrorPrefix outcome.mpcOutput)
    let decoded = abiDecodeBool outcome.mpcOutput 0
    assertMsg "approve returned false" decoded

    archive pendingCid
    archive outcomeCid
    archive signatureCid
```

#### RequestAaveSupply (nonconsuming)

Uses the user's deposit path (not "root") so each user has their own Aave
position via their derived address.

```daml
nonconsuming choice RequestAaveSupply : ContractId PendingEvmTx
  with
    requester     : Party
    holdingCid    : ContractId Erc20Holding
    stataToken    : BytesHex   -- stataUSDC contract address
    evmParams     : EvmTransactionParams
  controller requester
  do
    holding <- fetch holdingCid

    assertMsg "owner mismatch" $ holding.owner == requester
    assertMsg "issuer mismatch" $ holding.issuer == issuer
    assertMsg "must be deposit" $
      evmParams.functionSignature == "deposit(uint256,address,uint16,bool)"
    assertMsg "to must be stataToken" $ evmParams.to == stataToken

    -- validate amount matches holding
    let argsAmount = evmParams.args !! 0
    assertMsg "amount must match holding" $
      argsAmount == holding.amount

    archive holdingCid

    -- use the user's deposit path (per-user derived address)
    let requestPath = show requester <> "," <> "aave-supply"
        predecessorId = vaultId <> show issuer
        nonceCidText = show holdingCid
        requestId = computeRequestId
          (show requester) evmParams caip2Id keyVersion
          requestPath algo (show stataToken) nonceCidText

    create PendingEvmTx with
      source = AaveSupplySource holdingCid
      path = requestPath
      outputDeserializationSchema =
        "[{\"name\":\"shares\",\"type\":\"uint256\"}]"
      respondSerializationSchema =
        "[{\"name\":\"shares\",\"type\":\"uint256\"}]"
      ..
```

#### ClaimAaveSupply (nonconsuming)

Creates `Erc20Holding(stataUSDC, sharesAmount)` — balance stays correct
forever since shares don't rebase.

```daml
nonconsuming choice ClaimAaveSupply : ContractId Erc20Holding
  with
    requester    : Party
    pendingCid   : ContractId PendingEvmTx
    outcomeCid   : ContractId EvmTxOutcomeSignature
    signatureCid : ContractId EcdsaSignature
  controller requester
  do
    pending <- fetch pendingCid
    outcome <- fetch outcomeCid

    assertMsg "requestId mismatch" $ pending.requestId == outcome.requestId
    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "invalid MPC signature" $
      verifyEcdsaSignature mpcPublicKey responseHash outcome.signature

    assertMsg "supply failed" $ not (hasErrorPrefix outcome.mpcOutput)

    -- decode shares minted (ERC-4626 deposit returns uint256 shares)
    let sharesOut = abiSlot outcome.mpcOutput 0
        stataToken = pending.evmParams.to

    archive pendingCid
    archive outcomeCid
    archive signatureCid

    create Erc20Holding with
      owner = requester
      amount = sharesOut           -- shares, not underlying — never stale
      erc20Contract = stataToken   -- stataUSDC address
      ..
```

#### RequestAaveWithdraw (nonconsuming)

Consumes `Erc20Holding(stataUSDC)`, redeems all shares.

```daml
nonconsuming choice RequestAaveWithdraw : ContractId PendingEvmTx
  with
    requester   : Party
    holdingCid  : ContractId Erc20Holding
    evmParams   : EvmTransactionParams
  controller requester
  do
    holding <- fetch holdingCid

    assertMsg "owner mismatch" $ holding.owner == requester
    assertMsg "must be redeem" $
      evmParams.functionSignature == "redeem(uint256,address,address,bool)"

    -- validate shares amount matches holding
    let argsShares = evmParams.args !! 0
    assertMsg "shares must match holding" $
      argsShares == holding.amount

    archive holdingCid

    let requestPath = show requester <> "," <> "aave-supply"
        nonceCidText = show holdingCid
        stataToken = evmParams.to
        requestId = computeRequestId
          (show requester) evmParams caip2Id keyVersion
          requestPath algo (show stataToken) nonceCidText

    create PendingEvmTx with
      source = AaveWithdrawSource holdingCid
      path = requestPath
      outputDeserializationSchema =
        "[{\"name\":\"assets\",\"type\":\"uint256\"}]"
      respondSerializationSchema =
        "[{\"name\":\"assets\",\"type\":\"uint256\"}]"
      ..
```

#### CompleteAaveWithdraw (nonconsuming)

```daml
nonconsuming choice CompleteAaveWithdraw
    : Optional (ContractId Erc20Holding)
  with
    requester    : Party
    underlying   : BytesHex   -- USDC contract address
    pendingCid   : ContractId PendingEvmTx
    outcomeCid   : ContractId EvmTxOutcomeSignature
    signatureCid : ContractId EcdsaSignature
  controller requester
  do
    pending <- fetch pendingCid
    outcome <- fetch outcomeCid

    assertMsg "requestId mismatch" $ pending.requestId == outcome.requestId
    let responseHash = computeResponseHash pending.requestId outcome.mpcOutput
    assertMsg "invalid MPC signature" $
      verifyEcdsaSignature mpcPublicKey responseHash outcome.signature

    archive pendingCid
    archive outcomeCid
    archive signatureCid

    if hasErrorPrefix outcome.mpcOutput then
      pure None  -- redeem failed, no refund (shares already burned on-chain)
    else do
      -- decode actual assets returned (underlying + yield)
      let assetsOut = abiSlot outcome.mpcOutput 0

      holdingCid <- create Erc20Holding with
        owner = requester
        amount = assetsOut          -- includes accrued yield
        erc20Contract = underlying  -- back to USDC
        ..
      pure (Some holdingCid)
```

## MPC Service Changes

**None.** The existing MPC service pipeline is fully generic — it processes
any `PendingEvmTx` regardless of function signature. The path-based key
derivation already works for per-user addresses.

## Composability

Because stataUSDC is a standard ERC-20 with constant balance, the user can:

1. Deposit USDC → `Erc20Holding(USDC)`
2. Supply to Aave → `Erc20Holding(stataUSDC)` (shares, balance never stale)
3. **Swap stataUSDC on Uniswap** → `Erc20Holding(WETH)` (see uniswap-v3-swap.md)
4. Redeem stataUSDC → `Erc20Holding(USDC + yield)`

This would NOT work with raw aUSDC — Uniswap V3/V4 explicitly does not
support rebasing tokens and yield would be permanently lost.

## E2E Test Plan

### Test: `aave-supply-e2e.test.ts`

**Setup (beforeAll, 60s):**

1. `setupVault()` — allocate parties, upload DAR, create VaultOrchestrator
2. Fund user's derived address with test USDC from Aave faucet
3. Start MPC server
4. Execute `RequestEvmApprove` for USDC → stataToken (max uint256)
5. Wait for MPC to sign + submit approve tx
6. Exercise `ClaimEvmApprove`

**Test 1: Supply USDC to Aave via stataToken (300s):**

1. Create `Erc20Holding(USDC)` via standard deposit flow
2. Build `EvmTransactionParams` for `stataToken.deposit(amount, addr, 0, true)`
3. Exercise `RequestAaveSupply` with holding
4. Wait for MPC to sign + submit deposit tx
5. Exercise `ClaimAaveSupply`
6. Assert: `Erc20Holding(stataUSDC)` created with shares > 0
7. Assert: `erc20Contract` == stataToken address
8. Verify on Sepolia: user's derived address has stataUSDC balance > 0

**Test 2: Withdraw from Aave with yield (300s):**

1. Wait a few blocks (yield accrues in exchange rate)
2. Query `stataToken.convertToAssets(shares)` — should be > original USDC
3. Exercise `RequestAaveWithdraw` with stataUSDC holding
4. Wait for MPC to sign + submit redeem tx
5. Exercise `CompleteAaveWithdraw`
6. Assert: new `Erc20Holding(USDC)` created
7. Assert: `amount >= original supply amount` (yield accrued)
8. Verify on Sepolia: stataUSDC balance == 0, USDC balance restored + yield

### Env Variables (additions)

```
AAVE_POOL_ADDRESS=0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951
AAVE_FAUCET_ADDRESS=0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D
STATA_USDC_ADDRESS=0x8A88124522dbBF1E56352ba3DE1d9F78C143751e
```

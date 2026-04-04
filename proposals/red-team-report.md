# Red Team Report: Two-Address Custody Model

Security analysis of the Canton MPC vault with the two-address custody
model (User DeFi Address + Vault Custody Address). Seven independent red
team agents attacked the system in parallel.

**Threat model assumptions:**

- MPC key material is secure — cannot be extracted or used outside the MPC
  protocol
- MPC only signs transactions via Canton — `PendingEvmTx` from the Daml
  ledger is the only path to a signature
- The vault custody address (path="root") never calls `approve()`
- MPC service waits for finality before reporting outcomes to Canton

## Critical (Must Fix Before Production)

### C1: Fee-on-Transfer Insolvency

**Attack:** A token charges a fee on `transfer()` (e.g., 5%). The user
calls `transfer(vault, 1000)`, the vault receives 950 tokens. The MPC
re-simulates at `blockNumber - 1`, gets return value `true`. Canton creates
`Erc20Holding` with `amount = 1000` (from `evmParams.args[1]`), not the
actual 950 received.

Repeated deposits compound the deficit:

```
After 10 deposits of 1000 each (5% fee token):
  Canton holdings total:  10,000
  Vault on-chain balance:  9,500
  Insolvent by:              500
  → The 10th user to withdraw cannot redeem
```

**Root cause:** `ClaimEvmDeposit` at `Erc20Vault.daml:221` uses the
requested amount, not the actual received amount:

```daml
let amount = (pending.evmParams).args !! 1  -- requested, not received
```

**Fix (choose one):**

- **Option A (token allowlist):** Add `allowedTokens : [BytesHex]` to
  `VaultOrchestrator`. Only accept tokens guaranteed to not have
  fee-on-transfer. Simplest for PoC.
- **Option B (balance delta):** MPC service checks
  `balanceOf(vault, token)` before and after the transfer. Reports
  `actualReceived = balanceAfter - balanceBefore` as `mpcOutput`. Canton
  creates holding for the actual received amount.

**References:**

- [Weird ERC20: Fee-on-Transfer](https://github.com/d-xo/weird-erc20#fee-on-transfer)

---

### C2: No Refund Path in ClaimAaveSupply

**Attack:** `RequestAaveSupply` archives the user's `Erc20Holding(USDC)`
immediately. If the supply tx reverts (Aave Pool paused, insufficient gas,
stataToken bug), `ClaimAaveSupply` asserts success and aborts — the holding
is gone with no replacement. The user's USDC is still on their DeFi address
but Canton has no record of it.

**Root cause:** `ClaimAaveSupply` (proposal) only handles the success path:

```daml
assertMsg "supply failed" $ not (hasErrorPrefix outcome.mpcOutput)
-- no 'else' branch, no refund
```

Compare with `CompleteEvmWithdrawal` in `Erc20Vault.daml:276-323` which
properly handles failure by recreating the holding as a refund.

**Fix:** Add refund logic mirroring `CompleteEvmWithdrawal`:

```daml
if hasErrorPrefix outcome.mpcOutput then do
  -- Supply failed — refund original USDC holding
  refundCid <- create Erc20Holding with
    owner = requester
    amount = originalAmount
    erc20Contract = originalToken
    ..
  pure (Left refundCid)   -- Left = refund
else do
  -- Supply succeeded — create stataUSDC holding
  let sharesOut = abiSlot outcome.mpcOutput 0
  holdingCid <- create Erc20Holding with
    owner = requester
    amount = sharesOut
    erc20Contract = stataToken
    ..
  pure (Right holdingCid)  -- Right = success
```

**Same bug exists in:** `RequestAaveWithdraw` (archives stataUSDC holding
before confirming redeem succeeded). Apply the same fix.

---

### C3: Sandwich Attack on Uniswap Swaps

**Attack:** The proposal sets `amountOutMinimum = 0` and
`sqrtPriceLimitX96 = 0` for `exactInputSingle`. This is a textbook
sandwich setup:

1. Attacker front-runs the swap by buying `tokenOut`, moving the price up
2. User's swap executes at the worse price (accepts any output)
3. Attacker back-runs by selling `tokenOut` at the inflated price

Canton records the sandwich loss as the real output — the user's
`Erc20Holding` reflects the extracted value.

**Root cause:** `uniswap-v3-swap.md` line 109:

```
args[5] = amountOutMinimum = 00..00 (0 for PoC; set real value in prod)
```

**Fix:**

- Enforce `amountOutMinimum > 0` in the Daml `RequestUniswapSwap` choice
- Compute minimum from QuoterV2 off-chain (e.g., quoted amount - 1%
  slippage tolerance)
- Add a `minOutputAmount : BytesHex` field to the choice and validate
  `evmParams.args[5] == minOutputAmount` with
  `hexGteUint minOutputAmount someFloor`

---

## High (Should Fix)

### H1: No Token Allowlist

**Attack:** Attacker deploys a malicious ERC-20 where `transfer()` returns
`true` but does not move tokens. Deposits it through Canton. MPC reports
success. Canton creates a phantom `Erc20Holding`.

**Impact:** Inflated Canton ledger. The holding is for a worthless fake
token, but it pollutes the ledger and could confuse downstream systems.

**Root cause:** `RequestEvmDeposit` validates `functionSignature` and
`recipient == vaultAddress` but does not validate `evmParams.to` (the token
address) against a known list.

**Fix:** Add to `VaultOrchestrator`:

```daml
template VaultOrchestrator with
  ...
  allowedTokens : [BytesHex]   -- issuer-managed whitelist
  ...

-- In RequestEvmDeposit / RequestCustodySweep:
assertMsg "Token not allowed" $
  evmParams.to `elem` allowedTokens
```

---

### H2: Token Admin Freeze / Destroy

**Attack:** USDC `blacklist(vault)` freezes all withdrawals permanently.
USDT `destroyBlackFunds(vault)` zeros the balance. Canton holdings exist
but can never be redeemed — functional insolvency.

**Real-world precedent:** Tether destroyed $698M via `destroyBlackFunds` in
2025 alone. Circle blacklisted 44 Tornado Cash addresses in 2022.

**Impact:** All holdings for the affected token become unredeemable.
Canton has no mechanism to write them down.

**Fix:** Accept as a trust assumption for centralized stablecoins.
Document it. Mitigations:

- Diversify across tokens (DAI, WETH have no admin functions)
- Monitor `Blacklisted` / `Paused` events on whitelisted tokens
- Consider an issuer-triggered `WriteDownHoldings` emergency choice

| Token | Freeze             | Destroy                     | Admin Risk       |
| ----- | ------------------ | --------------------------- | ---------------- |
| USDC  | Yes (blacklist)    | No (but upgrade could add)  | High             |
| USDT  | Yes (addBlackList) | **Yes** (destroyBlackFunds) | Critical         |
| DAI   | No                 | No                          | None             |
| WETH  | No                 | No                          | None (immutable) |

---

### H3: DeFi Protocol Proxy Compromise

**Attack:** stataToken or SwapRouter02 proxy is upgraded maliciously
(governance attack, admin key theft). The new implementation calls
`transferFrom()` on every DeFi address that has outstanding approvals.

**Impact:** Total loss of tokens on User DeFi Addresses. **Vault is safe**
(never grants approvals).

**Real-world precedent:** ParaSwap Augustus V6 (March 2024) — $1.1M drained
from users with outstanding approvals.

**Fix:**

- Use exact-amount approvals (not `type(uint256).max`)
- Revoke approval to 0 after each DeFi operation
- Follow the pattern: approve → DeFi op → revoke → sweep to vault
- This limits exposure to the brief window of one operation

---

### H4: MPC Service Trusts Canton Blindly

**Attack:** If the `issuer` party's Canton credentials are compromised, the
attacker can `createCmd PendingEvmTx` directly (bypassing
`VaultOrchestrator` choices). The MPC service signs it because it only
validates `requestId` internal consistency — it does not independently check
function signatures, recipients, or paths.

**Root cause:** `tx-handler.ts` `signAndEnqueue()` validates:

- requestId consistency (good, but only checks internal consistency)
- Key derivation from path

It does NOT validate:

- `functionSignature` is in an allowlist
- Recipient address is known/whitelisted
- Path restrictions (e.g., "root" only for withdrawals)
- Amount bounds

**Fix:** Add MPC-side policy enforcement:

```typescript
// In signAndEnqueue(), before signing:
const ALLOWED_FUNCTIONS = [
  "transfer(address,uint256)",
  "approve(address,uint256)",
  "deposit(uint256,address,uint16,bool)",
  "redeem(uint256,address,address,bool)",
];
if (!ALLOWED_FUNCTIONS.includes(evmParams.functionSignature)) {
  throw new Error(`Blocked function: ${evmParams.functionSignature}`);
}
```

---

## Medium

### M1: No On-Chain Balance Reconciliation

**Attack:** Canton never reads `balanceOf(vault)`. Drift from any cause
(fee-on-transfer, admin actions, reorgs, bugs) goes undetected until a
withdrawal fails.

**Fix:** Periodic reconciliation job:

```typescript
const onChain = await token.balanceOf(vaultAddress);
const cantonTotal = sumAllHoldings(token);
if (onChain < cantonTotal) {
  alert(`INSOLVENCY: on-chain=${onChain} canton=${cantonTotal}`);
}
```

---

### M2: DeFi-to-Sweep Race Window

**Attack:** After a DeFi operation returns tokens to the user's DeFi
address, those tokens sit on an address with outstanding approvals. If the
approved protocol is compromised during this window, tokens are drained.

**Window duration:** 1-3 blocks (time to submit and confirm sweep tx).

**Fix:** Revoke approvals before sweeping:

```
DeFi op → revoke approval(spender, 0) → sweep to vault
```

This eliminates the window entirely.

---

### M3: ERC-4626 Rounding Leakage

**Attack:** Each ERC-4626 `deposit`/`redeem` loses up to 1 wei to rounding
(vault-favoring convention per OpenZeppelin). Compounds over millions of
operations.

**Impact:** Negligible for PoC. In production, over 1M operations this
could leak up to 1M wei (0.000000000001 ETH equivalent).

**Fix:** Monitor. Not actionable for PoC.

---

## Verified Secure (Attacks That Failed)

| Attack                                 | Why It's Blocked                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Double-spend Erc20Holding**          | Daml's atomic `archive` — contract consumed in the same transaction it's referenced. Second attempt gets `CONTRACT_NOT_FOUND`.    |
| **Replay EvmTxOutcomeSignature**       | `requestId` is EIP-712 hash of ALL params including `authCidText` (unique per request). Outcome contract is archived after claim. |
| **Forge MPC signatures**               | Requires root private key. Assumption: secure.                                                                                    |
| **Create fake Erc20Holding**           | Requires `issuer` signatory. Daml authorization model blocks unauthorized `createCmd`.                                            |
| **ABI encoding tricks**                | `abiDecodeBool` correctly interprets any non-zero 32-byte value as `true`. Error prefix `deadbeef` is checked first.              |
| **Flashloan callbacks on EOA**         | EOAs have no code — callbacks are no-ops.                                                                                         |
| **Delegatecall on EOA**                | Only contracts can execute delegatecall.                                                                                          |
| **Reentrancy on EOA**                  | EOAs have no re-entrant functions.                                                                                                |
| **Competing withdrawals**              | First succeeds (EVM nonce), second reverts and gets refunded via `CompleteEvmWithdrawal`.                                         |
| **requestId collision**                | keccak256 birthday bound: 2^-128. Cryptographically infeasible.                                                                   |
| **Nonce-based duplicate PendingEvmTx** | Auth card archived on use — different `authCidText` = different `requestId`. EVM nonce prevents double-execution.                 |

---

## Attack Surface Summary

```
                    ┌─────────────────────────────────────┐
                    │         Canton (Daml Ledger)         │
                    │                                     │
                    │  Erc20Holding ← signatory issuer    │
                    │  (only created via verified sweep)  │
                    │                                     │
                    │  SECURE: double-spend, replay,      │
                    │  forgery, fake creation all blocked  │
                    └──────────────┬──────────────────────┘
                                   │
                         PendingEvmTx
                                   │
                    ┌──────────────▼──────────────────────┐
                    │         MPC Service (Signer)        │
                    │                                     │
                    │  RISK: trusts Canton blindly (H4)   │
                    │  RISK: uses evmParams amount (C1)   │
                    └──────────────┬──────────────────────┘
                                   │
                          signed EVM tx
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
   ┌──────────▼───────────┐              ┌──────────────▼──────────┐
   │  User DeFi Address   │              │  Vault Custody Address  │
   │  (per-user EOA)      │              │  (shared root EOA)      │
   │                      │              │                         │
   │  HAS approvals       │              │  NEVER approves         │
   │  RISK: protocol      │              │  SECURE against         │
   │  compromise (H3)     │              │  transferFrom drain     │
   │  RISK: sandwich (C3) │              │                         │
   │  RISK: race (M2)     │              │  RISK: token admin (H2) │
   │                      │              │  RISK: fee-on-xfer (C1) │
   └──────────────────────┘              └─────────────────────────┘
```

---

## Priority Fix Order

1. **C2: Add refund path to ClaimAaveSupply** — design bug, easy fix,
   prevents permanent loss of Canton-side balances
2. **C1: Token allowlist** — prevents fee-on-transfer and malicious token
   attacks in one change
3. **C3: Enforce amountOutMinimum > 0** — one-line Daml assertion
4. **H4: MPC-side policy enforcement** — function allowlist in the signer
5. **H3: Exact-amount approvals + revoke pattern** — changes to test
   helpers and proposal
6. **M1: Reconciliation job** — background process, not blocking

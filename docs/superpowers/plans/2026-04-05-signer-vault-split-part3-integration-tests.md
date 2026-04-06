# Signer/Vault Split — Part 3: Integration Tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update all integration and E2E tests to work with the new
Signer/Vault contracts and TypeScript MPC service from Parts 1-2.

**Architecture:** Tests exercise the full stack: Daml contracts via Canton
sandbox → TypeScript MPC service → Sepolia (for E2E). All template/choice
names, field names, and party models change.

**Tech Stack:** Vitest, Canton sandbox, Sepolia testnet

**Prerequisites:** Parts 1 and 2 must be complete. DAR rebuilt, codegen
regenerated, TypeScript MPC service updated.

**Spec:** `proposals/signer-vault-split.md`

---

## File Structure

| File                                           | Action      | Changes                                                                |
| ---------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `test/src/test/helpers/e2e-setup.ts`           | **Modify**  | New party model (operators, sigNetwork, sender), create Signer + Vault |
| `test/src/test/visibility-permissions.test.ts` | **Rewrite** | All template/choice names change, observer model changes               |
| `test/src/test/signer.test.ts`                 | **Modify**  | Update for new signer.ts API                                           |
| `test/src/test/address-derivation.test.ts`     | **Modify**  | Update for new predecessorId computation                               |
| `test/src/test/sepolia-e2e.test.ts`            | **Modify**  | Full deposit flow with new contracts                                   |
| `test/src/test/sepolia-withdrawal-e2e.test.ts` | **Modify**  | Full withdrawal flow with new contracts                                |
| `test/src/test/helpers/codegen-types.ts`       | **Create**  | Re-export codegen types for test convenience                           |

## Key Test Changes

| Old Pattern                                                                                | New Pattern                                                                                                 |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `createCmd VaultOrchestrator with issuer; mpc; ...`                                        | `createCmd Signer with sigNetwork` + `createCmd Vault with operators; sigNetwork; ...`                      |
| `exerciseCmd orchCid RequestEvmDeposit with requester; ...`                                | `exerciseCmd vaultCid RequestDeposit with sender; signerCid; ...`                                           |
| `exerciseCmd orchCid SignEvmTx with requester; requestId; r; s; v`                         | `exerciseCmd signerCid Respond with operators; sender; requestId; signature`                                |
| `exerciseCmd orchCid ProvideEvmOutcomeSig with requester; requestId; signature; mpcOutput` | `exerciseCmd signerCid RespondBidirectional with operators; sender; requestId; serializedOutput; signature` |
| `exerciseCmd orchCid ClaimEvmDeposit with requester; pendingCid; outcomeCid; ecdsaCid`     | `exerciseCmd vaultCid ClaimDeposit with sender; pendingDepositCid; outcomeCid; sigCid`                      |
| Party `issuer` acts as vault operator AND MPC                                              | Party `operators[0]` acts as vault operator, `sigNetwork` acts as MPC                                       |

---

### Task 1: Update `e2e-setup.ts`

- [ ] **Step 1: Update party allocation and contract creation**

The setup creates:

- `sigNetwork` party (was: `issuer` served dual role)
- `operator` party (was: part of `issuer`)
- `sender` party (was: `requester`)
- `Signer` contract (signatory: sigNetwork)
- `Vault` contract (signatory: [operator], observer: sigNetwork)

- [ ] **Step 2: Update MpcServer config**

```typescript
new MpcServer({
  parties: [sigNetwork],    // was [issuer]
  signerCid: signerCid,     // was orchCid
  ...
})
```

- [ ] **Step 3: Commit**

```bash
git add test/src/test/helpers/
git commit -m "test: update e2e setup for signer/vault split"
```

---

### Task 2: Rewrite `visibility-permissions.test.ts`

This is the most comprehensive test — it verifies which parties can see
which contracts and exercise which choices. Every assertion changes.

- [ ] **Step 1: Rewrite test for new template/visibility model**

Key visibility changes:

- `Signer`: signatory sigNetwork, no observers → shared via disclosed contracts
- `Vault`: signatory operators, observer sigNetwork
- `SignBidirectionalEvent`: signatory operators + sender, observer sigNetwork
- `SignatureRespondedEvent`: signatory sigNetwork, observer operators + sender
- `RespondBidirectionalEvent`: signatory sigNetwork, observer operators + sender
- `PendingDeposit`: signatory operators, observer sender + sigNetwork
- `Erc20Holding`: signatory operators, observer owner

- [ ] **Step 2: Run tests**

```bash
# Start sandbox in separate terminal
dpm sandbox --json-api-port 7575 --dar daml-packages/daml-vault/.daml/dist/daml-vault-0.0.1.dar

# Run tests
cd test && pnpm test -- --grep "visibility"
```

- [ ] **Step 3: Commit**

```bash
git add test/src/test/visibility-permissions.test.ts
git commit -m "test: rewrite visibility tests for signer/vault split"
```

---

### Task 3: Update Sepolia E2E tests

- [ ] **Step 1: Update deposit E2E**

Update `sepolia-e2e.test.ts` to use new template/choice names.

- [ ] **Step 2: Update withdrawal E2E**

Update `sepolia-withdrawal-e2e.test.ts` similarly.

- [ ] **Step 3: Run E2E (requires .env)**

```bash
cd test && pnpm sepolia:preflight && pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add test/src/test/sepolia-*.test.ts
git commit -m "test: update Sepolia E2E tests for signer/vault split"
```

---

### Task 4: Update remaining unit tests

- [ ] **Step 1: Update `signer.test.ts`**

Update for any changes to `signEvmTxHash` return type or `signMpcResponse`.

- [ ] **Step 2: Update `address-derivation.test.ts`**

Update `predecessorId` computation tests.

- [ ] **Step 3: Run all tests**

```bash
pnpm -r --filter='@canton/*' run test
cd test && pnpm test
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test: complete integration test updates for signer/vault split"
```

# Signer/Vault Split — Part 2: TypeScript MPC Service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the TypeScript MPC service (`ts-packages/canton-sig/`) to
work with the new Signer/Vault Daml contracts from Part 1.

**Architecture:** The MPC service watches for `SignBidirectionalEvent` contracts
(was `PendingEvmTx`), exercises `Signer.Respond` (was `VaultOrchestrator.SignEvmTx`)
and `Signer.RespondBidirectional` (was `VaultOrchestrator.ProvideEvmOutcomeSig`).
The service now holds a `signerCid` instead of `orchCid`.

**Tech Stack:** TypeScript, viem, Daml codegen (`pnpm codegen:daml`)

**Prerequisites:** Part 1 must be complete (Daml contracts compiled, DAR built).

**Spec:** `proposals/signer-vault-split.md` + `proposals/naming-alignment.md`

---

## File Structure

| File                                                   | Action     | Changes                                                                             |
| ------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------- |
| `ts-packages/canton-sig/src/mpc/crypto.ts`             | **Modify** | Update `computeRequestId` for operators + nonceCidText                              |
| `ts-packages/canton-sig/src/mpc-service/tx-handler.ts` | **Modify** | Watch `SignBidirectionalEvent`, exercise `Respond`/`RespondBidirectional` on Signer |
| `ts-packages/canton-sig/src/mpc-service/server.ts`     | **Modify** | Watch `SignBidirectionalEvent` instead of `PendingEvmTx`, hold `signerCid`          |
| `ts-packages/canton-sig/src/mpc-service/signer.ts`     | **Modify** | Update `signEvmTxHash` return type, update `predecessorId` computation              |
| `ts-packages/canton-sig/src/index.ts`                  | **Modify** | Update exports for new template names                                               |
| `test/src/test/helpers/e2e-setup.ts`                   | **Modify** | Update party setup, contract creation                                               |
| `test/package.json`                                    | **Modify** | Codegen scripts may need update                                                     |

## Key Mapping

| Old TS                           | New TS                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| `VaultOrchestrator.templateId`   | `Signer.templateId` (for MPC) + `Vault.templateId` (for client) |
| `PendingEvmTx`                   | `SignBidirectionalEvent`                                        |
| `orchCid`                        | `signerCid`                                                     |
| `"SignEvmTx"` choice             | `"Respond"` choice                                              |
| `"ProvideEvmOutcomeSig"` choice  | `"RespondBidirectional"` choice                                 |
| `requester` field                | `sender` field                                                  |
| `issuer` field                   | `operators` field (list)                                        |
| `evmParams` field                | `evmTxParams` field                                             |
| `mpcOutput` field                | `serializedOutput` field                                        |
| `r, s, v` args                   | `signature : SignatureHex` arg                                  |
| `vaultId + issuer` predecessorId | `vaultId + operatorsId` predecessorId                           |

---

### Task 1: Regenerate Daml codegen

- [ ] **Step 1: Build DAR and regenerate TypeScript types**

```bash
dpm build --all
cd test && pnpm codegen:daml
```

This generates new TypeScript types for `Signer`, `Vault`, `SignBidirectionalEvent`, etc.

- [ ] **Step 2: Verify codegen output**

Check that the generated types include the new templates:

```bash
ls test/src/daml-codegen/daml-vault-0.0.1/lib/Signer/
ls test/src/daml-codegen/daml-vault-0.0.1/lib/Erc20Vault/
```

- [ ] **Step 3: Commit**

```bash
git add test/src/daml-codegen/
git commit -m "chore: regenerate Daml codegen for signer/vault split"
```

---

### Task 2: Update `crypto.ts` — new `computeRequestId`

- [ ] **Step 1: Update the TypeScript `computeRequestId`**

The function signature changes to accept `operatorTexts: string[]` and
`sender: string` separately, and includes `operatorsHash` + `params` + `nonceCidText`.

The EIP-712 type hash MUST match the Daml `requestTypeHash` exactly.

**File:** `ts-packages/canton-sig/src/mpc/crypto.ts`

Update `computeRequestId` to:

- Take `operatorTexts: string[]` as first arg
- Take `sender: string` as second arg
- Compute `operatorsHash = keccak256(concat(sort(operatorTexts).map(t => keccak256(toHex(t)))))`
- Use the new EIP-712 type: `CantonMpcSignRequest(bytes32 operatorsHash,string sender,...)`
- Add `params` and `nonceCidText` fields

- [ ] **Step 2: Update crypto tests**

Update `daml-packages/daml-eip712/test/crypto.test.ts` and any TS crypto
oracle tests to use the new function signature.

- [ ] **Step 3: Run TS tests**

```bash
pnpm -r --filter='@canton/*' run test
```

- [ ] **Step 4: Commit**

```bash
git add ts-packages/canton-sig/src/mpc/crypto.ts
git commit -m "feat(ts): update computeRequestId for operators multi-sig"
```

---

### Task 3: Update `tx-handler.ts` — new contract/choice names

- [ ] **Step 1: Update imports and types**

Replace:

```typescript
import {
  VaultOrchestrator,
  type PendingEvmTx,
} from "@daml.js/daml-vault-0.0.1/lib/Erc20Vault/module";
```

With:

```typescript
import {
  Vault,
  type SignBidirectionalEvent,
} from "@daml.js/daml-vault-0.0.1/lib/Erc20Vault/module";
import { Signer } from "@daml.js/daml-vault-0.0.1/lib/Signer/module";
```

Update `VAULT_ORCHESTRATOR` → `SIGNER_TEMPLATE`:

```typescript
const SIGNER_TEMPLATE = Signer.templateId;
```

- [ ] **Step 2: Update `MpcServiceConfig`**

```typescript
export interface MpcServiceConfig {
  canton: CantonClient;
  signerCid: string; // was orchCid
  userId: string;
  actAs: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
}
```

- [ ] **Step 3: Update `signAndEnqueue`**

The function reads `SignBidirectionalEvent` fields (was `PendingEvmTx`):

- `sender` (was `requester`)
- `operators` (was `issuer`)
- `evmTxParams` (was `evmParams`)
- `nonceCidText` (unchanged)
- `vaultId` + `operators` available on event — MPC computes `predecessorId` off-chain

Exercises `Signer.Respond` (was `VaultOrchestrator.SignEvmTx`):

- Choice args: `{ operators, sender, requestId, signature }` (DER-encoded, was `r, s, v`)

- [ ] **Step 4: Update `reportOutcome`**

Exercises `Signer.RespondBidirectional` (was `VaultOrchestrator.ProvideEvmOutcomeSig`):

- Choice args: `{ operators, sender, requestId, serializedOutput, signature }`
  (was `{ requester, requestId, signature, mpcOutput }`)

- [ ] **Step 5: Run TS tests**

```bash
cd ts-packages/canton-sig && pnpm build && pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add ts-packages/canton-sig/src/mpc-service/tx-handler.ts
git commit -m "feat(ts): update tx-handler for signer/vault split"
```

---

### Task 4: Update `server.ts` — watch `SignBidirectionalEvent`

- [ ] **Step 1: Update imports and template filter**

Replace `PendingEvmTx` with `SignBidirectionalEvent`:

```typescript
import { SignBidirectionalEvent } from "@daml.js/daml-vault-0.0.1/lib/Signer/module";
const SIGN_EVENT_SUFFIX = templateSuffix(SignBidirectionalEvent.templateId);
```

- [ ] **Step 2: Update `MpcServerConfig`**

```typescript
export interface MpcServerConfig {
  canton: CantonClient;
  signerCid: string; // was orchCid
  userId: string;
  parties: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
}
```

- [ ] **Step 3: Update event dispatch**

In the stream handler, change `PENDING_TX_SUFFIX` → `SIGN_EVENT_SUFFIX`
and update the catch-up query to use the new template ID.

- [ ] **Step 4: Commit**

```bash
git add ts-packages/canton-sig/src/mpc-service/server.ts
git commit -m "feat(ts): update MPC server to watch SignBidirectionalEvent"
```

---

### Task 5: Update `signer.ts` — predecessorId computation

- [ ] **Step 1: Update `predecessorId` computation**

Currently: `const predecessorId = \`${vaultId}${issuer}\`;`New: compute from`vaultId`+ sorted operators (both fields on`SignBidirectionalEvent`)

```typescript
import { keccak256, toBytes } from "viem";

const operatorsHash = keccak256(toBytes(operators.sort().join("")));
const predecessorId = `${vaultId}${operatorsHash}`;
```

`vaultId` and `operators` are both fields on `SignBidirectionalEvent`, so
the MPC computes `predecessorId = vaultId + keccak256(sort(operators))` off-chain.

- [ ] **Step 2: Commit**

```bash
git add ts-packages/canton-sig/src/mpc-service/signer.ts
git commit -m "feat(ts): update signer for new predecessorId computation"
```

---

### Task 6: Update `index.ts` exports

- [ ] **Step 1: Update re-exports**

Replace old template/type exports with new names.

- [ ] **Step 2: Build and verify**

```bash
cd ts-packages/canton-sig && pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add ts-packages/canton-sig/src/index.ts
git commit -m "feat(ts): update canton-sig exports for signer/vault split"
```

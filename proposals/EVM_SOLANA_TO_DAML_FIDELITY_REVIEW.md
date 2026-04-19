# EVM/Solana → DAML Translation Fidelity Review

Review of the DAML implementation in `canton-mpc-poc/daml-packages/` against the EVM reference (`signet.sol/`) and Solana reference (`signet-solana-program/` + `solana-contract-examples/erc20_vault.rs`).

---

## Critical fidelity risk (fix first)

**`computeResponseHash` double-hashes `serializedOutput`.**

- `Erc20Vault.daml:182,283` calls `RequestId.daml:63-65`, which uses `eip712EncodeBytes` — and `eip712EncodeBytes` wraps the input in `keccak256`.
- Result: DAML computes `keccak256(requestId ‖ keccak256(serializedOutput))`.
- The MPC node (`mpc/chain-signatures/node/src/respond_bidirectional.rs:179-189`) signs `keccak256(requestId ‖ serializedOutput)` — no inner `keccak256`. This matches Solana (`erc20_vault.rs:450-456`).

**Impact:** every MPC-produced `RespondBidirectional` signature will fail `secp256k1WithEcdsaOnly` verification on `Vault.ClaimDeposit` and `Vault.CompleteWithdrawal` until one side is aligned.

**Fix options:**

1. Drop the `eip712EncodeBytes` wrapping in `computeResponseHash` (DAML-side change — preferred).
2. Add a Canton-specific branch in the MPC's `calculate_respond_bidirectional_hash_message` that pre-hashes `serializedOutput`.

---

## Function / instruction / choice parity

| Solana                                                                    | EVM                 | DAML                                               | Fidelity                                                                                                                                                   |
| ------------------------------------------------------------------------- | ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sign(payload, key_version, path, algo, dest, params)`                    | `sign(SignRequest)` | —                                                  | ❌ missing                                                                                                                                                 |
| `sign_bidirectional(...)` (10 args)                                       | —                   | `Signer.SignBidirectional` → `SignRequest.Execute` | ⚠️ partial — drops `program_id`, `deposit`; adds `operators`, `sigNetwork`, `nonceCidText`; `serialized_transaction: Vec<u8>` → typed `txParams: TxParams` |
| `respond(request_ids, signatures)` batched                                | —                   | `Signer.Respond` single-item                       | ⚠️ not batched; adds `operators` + `requester`                                                                                                             |
| `respond_bidirectional`                                                   | —                   | `Signer.RespondBidirectional`                      | ⚠️ adds party metadata; otherwise tail-matches                                                                                                             |
| `respond_error` / `SignatureErrorEvent`                                   | —                   | —                                                  | ❌ dropped                                                                                                                                                 |
| `initialize`, `update_deposit`, `withdraw_funds`, `get_signature_deposit` | —                   | —                                                  | ❌ dropped (admin surface absent)                                                                                                                          |

---

## Event parity

| Solana event                                                        | DAML template                        | Fidelity                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SignatureRequestedEvent` (10 fields)                               | —                                    | ❌ no unidirectional sign                                                                                                                                                  |
| `SignBidirectionalEvent` (12 fields)                                | `SignBidirectionalEvent` (15 fields) | ⚠️ drops `deposit`, `program_id`; replaces `serialized_transaction` with `txParams`; adds `operators`, `requester`, `sigNetwork`, `nonceCidText`; snake → camel throughout |
| `SignatureRespondedEvent`                                           | `SignatureRespondedEvent`            | ⚠️ 3 extra authority fields prepended                                                                                                                                      |
| `RespondBidirectionalEvent`                                         | `RespondBidirectionalEvent`          | ⚠️ 3 extra authority fields prepended                                                                                                                                      |
| `SignatureErrorEvent`, `DepositUpdatedEvent`, `FundsWithdrawnEvent` | —                                    | ❌ all missing                                                                                                                                                             |

---

## Signature type — biggest type-level divergence

**EVM / Solana:**

```
Signature {
  AffinePoint bigR { x, y };   // 64 bytes
  bytes32 s;                   // 32 bytes
  uint8 recoveryId;            // 1 byte
}
```

Total: **97 bytes, RSV-affine**.

**DAML (`Signer.daml:23`):**

```
EcdsaSigData {
  der : SignatureHex;   // DER-encoded (r, s)
  recoveryId : Int;     // unbounded Int
}
-- wrapped in a union: Signature = EcdsaSig EcdsaSigData | …
```

### Differences

- `bigR.y` coordinate is **dropped**.
- Encoding is **DER** instead of flat RSV-affine.
- `recoveryId` widened from `uint8` / `u8` to unbounded `Int`.
- Wrapped in a union type to future-proof for EdDSA (Solana/Sui) and Schnorr (Bitcoin Taproot).

### Consequences

- Signatures must be **transcoded at every boundary** (EVM ↔ DAML, Solana ↔ DAML).
- The DAML signature is **not drop-in for `ecrecover`** on EVM.
- Deliberate trade-off: DAML lacks byte-manipulation primitives, and `secp256k1WithEcdsaOnly` requires DER input.

---

## Summary of fidelity gaps

- ❌ **Missing entry points:** unidirectional `sign`, `respond_error`, `initialize`, `update_deposit`, `withdraw_funds`, `get_signature_deposit`.
- ❌ **Missing events:** `SignatureRequestedEvent`, `SignatureErrorEvent`, `DepositUpdatedEvent`, `FundsWithdrawnEvent`.
- ⚠️ **Signature wire format reshaped** (DER vs affine RSV, `bigR.y` dropped).
- ⚠️ **Added Canton authority fields** on every event (`operators`, `sigNetwork`, `requester`, `nonceCidText`).
- ⚠️ **`serialized_transaction: Vec<u8>` → typed `txParams: TxParams`** — richer but EVM-only; no route for non-EVM destinations today.
- 🔴 **`computeResponseHash` double-hash** — integration-blocking; must be resolved before end-to-end signature verification works.

# EVM/Solana → DAML Translation Fidelity Review

Review of the DAML implementation in `canton-mpc-poc/daml-packages/` against the EVM reference (`signet.sol/`) and Solana reference (`signet-solana-program/` + `solana-contract-examples/erc20_vault.rs`).


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

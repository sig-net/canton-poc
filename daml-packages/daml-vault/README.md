# daml-vault

ERC-20 custody vault contracts for the Canton MPC protocol. Domain-specific consumer of the generic [`daml-signer`](../daml-signer/README.md) layer — this package implements deposit/withdrawal/holding templates where the signing is delegated to the Signer, and the MPC signature is verified on-chain via `secp256k1WithEcdsaOnly` at claim time.

For the end-to-end flows (lifecycle diagrams, Vault choice bodies, crypto reference, ABI-encoded `mpcOutput` interpretation), see:

- [`proposals/E2E_DEPOSIT_PLAN_COMPACT.md`](../../proposals/E2E_DEPOSIT_PLAN_COMPACT.md)
- [`proposals/E2E_WITHDRAWAL_PLAN_COMPACT.md`](../../proposals/E2E_WITHDRAWAL_PLAN_COMPACT.md)

For the Signer layer, authority delegation flow, MPC service flow, KDF chain ID, and security model, see [`daml-signer/README.md`](../daml-signer/README.md).

## Modules

- `Erc20Vault` — `Vault`, `VaultProposal`, `PendingDeposit`, `PendingWithdrawal`, `Erc20Holding`, and all deposit/withdrawal choices.

## Templates (overview)

| Template            | Signatory   | Purpose                                                                  |
| ------------------- | ----------- | ------------------------------------------------------------------------ |
| `VaultProposal`     | `alreadySigned` | Multi-party agreement; each operator signs in sequence until finalized |
| `Vault`             | `operators` | ERC-20 custody singleton; holds `evmMpcPublicKey` (per-vault KDF-derived key) |
| `PendingDeposit`    | `operators` | In-flight deposit anchor; archived in `ClaimDeposit` (single-use)         |
| `PendingWithdrawal` | `operators` | In-flight withdrawal anchor; archived in `CompleteWithdrawal` (single-use, refund-on-failure) |
| `Erc20Holding`      | `operators` | On-ledger ERC-20 balance. `sigNetwork` is deliberately NOT an observer — domain contracts stay decoupled from MPC infrastructure |

Full template definitions and choice bodies are in the E2E plan docs linked above.

## Dependencies

- `daml-prim`, `daml-stdlib`, `daml-script`
- `daml-abi` (via `data-dependencies`) — ABI decoding (`abiSlot`, `abiSlotCount`, `abiDecodeBool`, `abiDecodeUint`, `abiHasErrorPrefix`)
- `daml-eip712` (via `data-dependencies`) — EIP-712 primitive encoders (`chainIdToDecimalText`)
- `daml-signer` (via `data-dependencies`) — Signer layer templates and `signatureDer` helper

## Usage

Add to your `daml.yaml`:

```yaml
data-dependencies:
  - ../daml-vault/.daml/dist/daml-vault-0.0.1.dar
  - ../daml-signer/.daml/dist/daml-signer-0.0.1.dar
  - ../daml-abi/.daml/dist/daml-abi-0.0.1.dar
  - ../daml-eip712/.daml/dist/daml-eip712-0.0.1.dar
```

## Build & Test

```bash
dpm build
dpm test
```

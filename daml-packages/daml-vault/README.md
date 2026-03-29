# daml-vault

ERC-20 custody vault contracts for the Canton MPC protocol. Implements on-ledger deposit/withdrawal flows with MPC-signed EVM transaction verification.

## Modules

- `Erc20Vault` -- templates and choices for the vault lifecycle
- `RequestId` (from `daml-eip712`) -- deterministic request ID computation

## Templates

### `VaultOrchestrator`

The main entry point. Created by the issuer; holds the MPC public key and vault address. All user-facing operations are nonconsuming choices on this template.

| Field          | Type           | Description                          |
| -------------- | -------------- | ------------------------------------ |
| `issuer`       | `Party`        | Vault operator (signatory)           |
| `mpc`          | `Party`        | MPC service party (observer)         |
| `mpcPublicKey` | `PublicKeyHex` | SPKI-encoded secp256k1 public key    |
| `vaultAddress` | `BytesHex`     | On-chain vault address               |
| `vaultId`      | `Text`         | Discriminator for MPC key derivation |

**Choices:**

- `RequestDepositAuth` -- user requests deposit authorization (creates `DepositAuthProposal`)
- `ApproveDepositAuth` -- issuer approves proposal (creates `DepositAuthorization` with usage limit)
- `RequestEvmDeposit` -- user submits EVM deposit tx (consumes auth, creates `PendingEvmTx`)
- `SignEvmTx` -- issuer publishes ECDSA signature (creates `EcdsaSignature`)
- `ProvideEvmOutcomeSig` -- issuer publishes MPC outcome signature (creates `EvmTxOutcomeSignature`)
- `ClaimEvmDeposit` -- user claims deposit after MPC confirms success (creates `Erc20Holding`)
- `RequestEvmWithdrawal` -- user initiates withdrawal (consumes `Erc20Holding`, creates `PendingEvmTx`)
- `CompleteEvmWithdrawal` -- user completes withdrawal; refunds `Erc20Holding` if EVM tx failed

### Supporting Templates

- `DepositAuthProposal` -- pending authorization request (issuer + owner)
- `DepositAuthorization` -- approved authorization with remaining-use counter
- `Erc20Holding` -- on-ledger token balance (issuer, owner, erc20Address, amount)
- `PendingEvmTx` -- in-flight EVM transaction with full request metadata
- `EcdsaSignature` -- ECDSA (r, s, v) signature for an EVM transaction
- `EvmTxOutcomeSignature` -- MPC DER signature over the response hash + mpcOutput

### `TxSource`

Variant tagging the origin of a `PendingEvmTx`:

- `DepositSource (ContractId DepositAuthorization)`
- `WithdrawalSource (ContractId Erc20Holding)`

## Deposit Flow

1. User calls `RequestDepositAuth` to create a `DepositAuthProposal`
2. Issuer calls `ApproveDepositAuth` to grant a `DepositAuthorization`
3. User calls `RequestEvmDeposit` with EVM params (must be `transfer` to vault address)
4. Issuer calls `SignEvmTx` and `ProvideEvmOutcomeSig` after MPC execution
5. User calls `ClaimEvmDeposit` -- verifies MPC signature, creates `Erc20Holding`

## Withdrawal Flow

1. User calls `RequestEvmWithdrawal` (consumes their `Erc20Holding`, full withdrawal only)
2. Issuer calls `SignEvmTx` and `ProvideEvmOutcomeSig` after MPC execution
3. User calls `CompleteEvmWithdrawal` -- on EVM failure or `false` return, refunds `Erc20Holding`

## Dependencies

- `daml-prim`, `daml-stdlib`, `daml-script`
- `daml-abi` (via `data-dependencies`) -- ABI decoding (`hasErrorPrefix`, `abiDecodeBool`)
- `daml-eip712` (via `data-dependencies`) -- EIP-712 hashing (`computeRequestId`, `computeResponseHash`)
- `daml-evm-types` (via `data-dependencies`) -- `EvmTransactionParams`

## Usage

Add to your `daml.yaml`:

```yaml
data-dependencies:
  - ../daml-vault/.daml/dist/daml-vault-0.0.1.dar
  - ../daml-abi/.daml/dist/daml-abi-0.0.1.dar
  - ../daml-eip712/.daml/dist/daml-eip712-0.0.1.dar
  - ../daml-evm-types/.daml/dist/daml-evm-types-0.0.1.dar
```

## Build & Test

```bash
dpm build
dpm test
```

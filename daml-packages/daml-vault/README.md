# daml-vault

ERC-20 custody vault contracts for the Canton MPC protocol. Implements on-ledger deposit/withdrawal flows with MPC-signed EVM transaction verification.

## Modules

- `Erc20Vault` -- templates and choices for the vault lifecycle
- `RequestId` -- EIP-712 struct hashing for deterministic request ID computation

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

| Choice                  | Controller  | Description                                                                  |
| ----------------------- | ----------- | ---------------------------------------------------------------------------- |
| `RequestDepositAuth`    | `requester` | Creates `DepositAuthProposal`                                                |
| `ApproveDepositAuth`    | `issuer`    | Archives proposal, creates `DepositAuthorization` with usage limit           |
| `RequestEvmDeposit`     | `requester` | Decrements or consumes auth, creates `PendingEvmTx`                          |
| `SignEvmTx`             | `issuer`    | Creates `EcdsaSignature` (r, s, v)                                           |
| `ProvideEvmOutcomeSig`  | `issuer`    | Creates `EvmTxOutcomeSignature` (DER sig + mpcOutput)                        |
| `ClaimEvmDeposit`       | `requester` | Verifies MPC signature, creates `Erc20Holding`                               |
| `RequestEvmWithdrawal`  | `requester` | Consumes `Erc20Holding`, creates `PendingEvmTx`                              |
| `CompleteEvmWithdrawal` | `requester` | Success returns `None` (tokens left vault); failure returns `Some refundCid` |

### Supporting Templates

- `DepositAuthProposal` -- pending authorization request (issuer + owner)
- `DepositAuthorization` -- approved authorization with remaining-use counter
- `Erc20Holding` -- on-ledger token balance (issuer, owner, erc20Address, amount)
- `PendingEvmTx` -- in-flight EVM transaction with full request metadata (see fields below)
- `EcdsaSignature` -- ECDSA (r, s, v) signature for an EVM transaction
- `EvmTxOutcomeSignature` -- MPC DER signature over the response hash + mpcOutput

### `PendingEvmTx` Fields

| Field                         | Type                   | Description                                                                |
| ----------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| `issuer`                      | `Party`                | Vault operator (signatory)                                                 |
| `requester`                   | `Party`                | User who initiated the tx                                                  |
| `mpc`                         | `Party`                | MPC service party (observer)                                               |
| `requestId`                   | `BytesHex`             | Deterministic EIP-712 request ID                                           |
| `path`                        | `Text`                 | MPC derivation path (`sender,path` for deposits, `"root"` for withdrawals) |
| `evmParams`                   | `EvmTransactionParams` | Full EVM transaction parameters                                            |
| `vaultId`                     | `Text`                 | Issuer-controlled discriminator for MPC key derivation                     |
| `nonceCidText`                | `Text`                 | Source contract ID as text (nonce for requestId)                           |
| `source`                      | `TxSource`             | `DepositSource authCid` or `WithdrawalSource balanceCid`                   |
| `keyVersion`                  | `Int`                  | MPC key version                                                            |
| `algo`                        | `Text`                 | Signing algorithm                                                          |
| `dest`                        | `Text`                 | Destination identifier                                                     |
| `outputDeserializationSchema` | `Text`                 | JSON ABI type array for decoding EVM return data                           |
| `respondSerializationSchema`  | `Text`                 | JSON ABI type array for re-encoding the response                           |

### `TxSource`

Variant tagging the origin of a `PendingEvmTx`:

- `DepositSource (ContractId DepositAuthorization)`
- `WithdrawalSource (ContractId Erc20Holding)`

### RequestId Exports

- `computeRequestId : Text -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex` -- EIP-712 hash of a `CantonMpcDepositRequest` struct
- `computeResponseHash : BytesHex -> BytesHex -> BytesHex` -- EIP-712 hash of a `CantonMpcResponse(bytes32 requestId, bytes mpcOutput)`
- `hashEvmParams : EvmTransactionParams -> BytesHex` -- hash an `EvmTransactionParams` struct per EIP-712
- `evmParamsTypeHash`, `requestTypeHash`, `responseTypeHash` -- pre-computed type hashes

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

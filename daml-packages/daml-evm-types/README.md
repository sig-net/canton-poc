# daml-evm-types

Base EVM data types shared across the Canton MPC Daml packages. Defines the canonical representation for EVM transaction parameters and shared test fixtures.

## Modules

- `EvmTypes` -- `EvmTransactionParams` record
- `TestFixtures` -- shared test constants (keys, signatures, ABI-encoded values, sample transactions)

## API Reference

### `EvmTransactionParams`

Record representing a fully-specified EVM transaction:

| Field               | Type         | Description                         |
| ------------------- | ------------ | ----------------------------------- |
| `to`                | `BytesHex`   | 20-byte destination address         |
| `functionSignature` | `Text`       | e.g., `"transfer(address,uint256)"` |
| `args`              | `[BytesHex]` | per-argument hex values             |
| `value`             | `BytesHex`   | 32-byte ETH value                   |
| `nonce`             | `BytesHex`   | 32-byte nonce                       |
| `gasLimit`          | `BytesHex`   | 32-byte gas limit                   |
| `maxFeePerGas`      | `BytesHex`   | 32-byte EIP-1559 max fee            |
| `maxPriorityFee`    | `BytesHex`   | 32-byte EIP-1559 priority fee       |
| `chainId`           | `BytesHex`   | 32-byte chain ID                    |

### TestFixtures

Shared constants for Daml Script tests:

- `testPubKeyHex`, `testSignatureHex`, `testMessageHex` -- SPKI secp256k1 key and DER signature
- `claimTestPubKey`, `claimTestSignature`, `claimTestRequestId` -- deposit claim test data
- `refundTestSignature`, `boolFalseTestSignature` -- withdrawal refund/failure test data
- `boolTrueMpcOutput`, `boolFalseMpcOutput`, `errorPrefixMpcOutput` -- ABI-encoded return values
- `sampleEvmParams`, `sampleWithdrawalEvmParams` -- pre-built `EvmTransactionParams`

## Dependencies

- `daml-prim`, `daml-stdlib`, `daml-script`

## Usage

Add to your `daml.yaml`:

```yaml
data-dependencies:
  - ../daml-evm-types/.daml/dist/daml-evm-types-0.0.1.dar
```

```daml
import EvmTypes (EvmTransactionParams(..))

let tx = EvmTransactionParams with
      to = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
      functionSignature = "transfer(address,uint256)"
      args = [recipientHex, amountHex]
      value = "00..00"
      ...
```

## Build & Test

```bash
dpm build
dpm test
```

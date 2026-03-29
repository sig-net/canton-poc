# daml-eip712

EIP-712 typed structured data hashing for Daml. Implements the domain separator and struct hashing used to compute deterministic request IDs and response hashes for the Canton MPC protocol.

## Modules

- `Eip712` -- domain separator, struct hashing, keccak256 helpers
- `RequestId` -- EIP-712 struct hashing for `CantonMpcDepositRequest` and `CantonMpcResponse`

## API Reference

### Eip712

- `eip712Hash : BytesHex -> BytesHex` -- compute `keccak256("\x19\x01" || domainSeparator || structHash)`
- `domainSeparator : BytesHex` -- pre-computed domain separator for `EIP712Domain(string name, string version)` with name `"CantonMpc"`, version `"1"`
- `domainTypeHash : BytesHex` -- keccak256 of the domain type string
- `safeKeccak256 : BytesHex -> BytesHex` -- keccak256 that returns the empty-input hash for `""`
- `hashText : Text -> BytesHex` -- keccak256 of UTF-8 encoded text
- `hashBytesList : [BytesHex] -> BytesHex` -- hash a list of byte strings (keccak each, then keccak the concatenation)
- `padLeft : BytesHex -> Int -> BytesHex` -- left-pad hex to byte width
- `assertBytes32 : BytesHex -> BytesHex` -- assert value is exactly 32 bytes
- `chainIdToDecimalText : BytesHex -> Text` -- convert hex chain ID to decimal string

### RequestId

- `computeRequestId : Text -> EvmTransactionParams -> Text -> Int -> Text -> Text -> Text -> Text -> BytesHex` -- EIP-712 hash of a `CantonMpcDepositRequest` struct
- `computeResponseHash : BytesHex -> BytesHex -> BytesHex` -- EIP-712 hash of a `CantonMpcResponse(bytes32 requestId, bytes mpcOutput)`
- `hashEvmParams : EvmTransactionParams -> BytesHex` -- hash an `EvmTransactionParams` struct per EIP-712
- `evmParamsTypeHash`, `requestTypeHash`, `responseTypeHash` -- pre-computed type hashes

## Dependencies

- `daml-prim`, `daml-stdlib`, `daml-script`
- `daml-evm-types` (via `data-dependencies`) -- provides `EvmTransactionParams`

## Usage

Add to your `daml.yaml`:

```yaml
data-dependencies:
  - ../daml-eip712/.daml/dist/daml-eip712-0.0.1.dar
  - ../daml-evm-types/.daml/dist/daml-evm-types-0.0.1.dar
```

```daml
import Eip712 (eip712Hash, domainSeparator, hashText)
import RequestId (computeRequestId, computeResponseHash)

let reqId = computeRequestId sender evmParams caip2Id keyVersion path algo dest nonceCid
let respHash = computeResponseHash reqId mpcOutput
```

## Build & Test

```bash
dpm build
dpm test
```

# daml-eip712

EIP-712 typed structured data hashing for Daml. Implements the domain separator and struct hashing used to compute deterministic request IDs and response hashes for the Canton MPC protocol.

## Modules

- `Eip712` -- domain separator, struct hashing, keccak256 helpers

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

## Dependencies

- `daml-prim`, `daml-stdlib`, `daml-script`

## Usage

Add to your `daml.yaml`:

```yaml
data-dependencies:
  - ../daml-eip712/.daml/dist/daml-eip712-0.0.1.dar
```

```daml
import Eip712 (eip712Hash, domainSeparator, hashText)

let structHash = keccak256 (myTypeHash <> hashText myField)
let digest = eip712Hash structHash
```

## Build & Test

```bash
dpm build
dpm test
```

# daml-abi

EVM ABI encoding and decoding for Daml. Provides slot-based access to ABI-encoded calldata and return data, covering static types (uint, int, bool, address, bytesN), dynamic types (bytes, string, arrays), and nested tuples.

## Modules

- `Abi` -- slot-based ABI decoder and calldata helpers

## API Reference

### Calldata

- `abiSelector : BytesHex -> BytesHex` -- extract 4-byte function selector
- `abiStripSelector : BytesHex -> BytesHex` -- strip selector, leaving ABI payload

### Slot Access

- `abiSlot : BytesHex -> Int -> BytesHex` -- read the i-th 32-byte slot (0-indexed)
- `abiSlotCount : BytesHex -> Int` -- number of 32-byte slots in the data

### Static Type Decoders

- `abiDecodeUint : BytesHex -> Int -> BytesHex` -- decode uint (any width) at slot i
- `abiDecodeInt : BytesHex -> Int -> BytesHex` -- decode int (two's complement) at slot i
- `abiDecodeBool : BytesHex -> Int -> Bool` -- decode bool at slot i
- `abiDecodeAddress : BytesHex -> Int -> BytesHex` -- decode address at slot i (20 bytes)
- `abiDecodeBytesN : BytesHex -> Int -> Int -> BytesHex` -- decode bytesN at slot i (second Int is the byte count n)

### Dynamic Type Decoders

- `abiReadOffset : BytesHex -> Int -> Int` -- read offset pointer at slot i
- `abiDecodeBytes : BytesHex -> Int -> BytesHex` -- decode dynamic bytes at byte offset
- `abiDecodeString : BytesHex -> Int -> Text` -- decode dynamic string (UTF-8) at byte offset
- `abiDecodeArrayLen : BytesHex -> Int -> Int` -- array length at byte offset
- `abiDecodeArrayElem : BytesHex -> Int -> Int -> BytesHex` -- j-th element of static-element array
- `abiDecodeArrayDynElem : BytesHex -> Int -> Int -> Int` -- resolve j-th element of dynamic-element array
- `abiDecodeFixedArrayDynElem : BytesHex -> Int -> Int -> Int` -- resolve j-th element of fixed-size dynamic-element array
- `abiDecodeTupleDynMember : BytesHex -> Int -> Int -> Int` -- resolve dynamic member within a tuple

### Error Handling

- `hasErrorPrefix : BytesHex -> Bool` -- check for `deadbeef` error magic prefix
- `stripErrorPrefix : BytesHex -> BytesHex` -- strip 4-byte error prefix

## Dependencies

- `daml-prim`, `daml-stdlib`, `daml-script`

## Usage

Add to your `daml.yaml`:

```yaml
data-dependencies:
  - ../daml-abi/.daml/dist/daml-abi-0.0.1.dar
```

```daml
import Abi (abiDecodeBool, abiDecodeAddress, abiStripSelector)

let payload = abiStripSelector calldata
let recipient = abiDecodeAddress payload 0
let success = abiDecodeBool payload 1
```

## Build & Test

```bash
dpm build
dpm test
```

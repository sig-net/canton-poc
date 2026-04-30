# Migrate to ABI-Encoded Return Data (Fakenet Pattern)

Replace the hardcoded `"01"`/`"00"` `mpcOutput` with ABI-encoded EVM return data,
aligning Canton's MPC service with the pattern established in
`signet-solana-program/fakenet-signer`.

## Motivation

Today the MPC service reduces EVM execution results to a single boolean:
`"01"` (success) or `"00"` (failure). The Daml contract checks
`outcome.mpcOutput == "01"` and trusts it blindly — it never sees the actual
EVM return data.

The fakenet signer already solves this: after a transaction confirms, it
**re-simulates the call** to extract the ABI-encoded return value, posts it
back as `serialized_output`, and signs `keccak256(requestId || output)`. The
on-chain consumer then decodes and interprets the return data itself.

Canton should adopt this pattern because:

1. **Richer on-chain logic** — the Daml contract can inspect actual return
   values (e.g. `balanceOf` amounts, swap outputs, multi-return structs),
   not just pass/fail
2. **`Abi.daml` is already built** — the full ABI decoding library
   (`abiDecodeBool`, `abiDecodeUint`, `abiDecodeAddress`, dynamic types,
   etc.) is ready and tested
3. **Protocol alignment** — Canton's MPC service matches the same interface
   as the Solana fakenet, making it straightforward to swap in the real
   signet MPC network later
4. **Error prefix convention** — the `0xDEADBEEF` prefix used by fakenet
   provides an unambiguous failure signal that is cleaner than a magic
   hex string

## Current vs Proposed

| Aspect                  | Current                                                           | Proposed                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mpcOutput` content     | `"01"` or `"00"`                                                  | ABI-encoded return data (e.g. `0000...0001` for `bool true`)                                                                                                                 |
| Error signal            | `mpcOutput == "00"`                                               | 4-byte `deadbeef` prefix                                                                                                                                                     |
| Deposit claim check     | `outcome.mpcOutput == "01"`                                       | `not (hasErrorPrefix mpcOutput) && abiDecodeBool mpcOutput 0`                                                                                                                |
| Withdrawal refund check | `outcome.mpcOutput /= "01"`                                       | `hasErrorPrefix mpcOutput \|\| not (abiDecodeBool mpcOutput 0)`                                                                                                              |
| Return data extraction  | Not done — checks receipt status + Transfer event                 | Re-simulate call at `blockNumber - 1`, ABI decode result                                                                                                                     |
| Schema system           | None                                                              | `PendingEvmTx` carries two schemas: `outputDeserializationSchema` + `respondSerializationSchema` (JSON `[{name,type}]` arrays, same format as Solana's `sign_bidirectional`) |
| Response hash input     | `keccak256(responseTypeHash \|\| requestId \|\| keccak256("01"))` | `keccak256(responseTypeHash \|\| requestId \|\| keccak256(abiEncodedOutput))`                                                                                                |

## Three Failure Modes

The design handles three distinct failure scenarios:

1. **TX-level failure** (reverted, nonce replaced, timed out) — MPC sends
   `deadbeef` prefix + ABI-encoded `{ error: true }`. The Daml contract
   sees the prefix and refunds immediately without decoding the rest.

2. **Successful TX, `transfer()` returned `false`** — some non-standard
   ERC20 tokens signal failure via return value instead of reverting. The
   MPC faithfully sends the ABI-encoded `bool(false)` without any prefix
   (the TX genuinely succeeded). The Daml contract decodes the bool and
   refunds because `abiDecodeBool == False`.

3. **Successful TX, `transfer()` returned `true`** — normal success path.
   MPC sends ABI-encoded `bool(true)`, Daml decodes and accepts.

## Design

### Error Prefix Convention

Adopt the fakenet `0xDEADBEEF` prefix for error signaling:

```
Success: <ABI-encoded return data>        e.g. "0000...0001" (bool true)
Failure: "deadbeef" <> <ABI-encoded error>  e.g. "deadbeef0000...0001" ({ error: true })
```

The Daml contract checks `DA.Text.take 8 mpcOutput == "deadbeef"` before
attempting to decode the return value. The bytes after the prefix encode
the error reason (currently `{ error: true }` stub, reserved for richer
error types in the future).

### Schema on PendingEvmTx

Add two schema fields to `PendingEvmTx`, matching the same two-schema
system used by `sign_bidirectional` on Solana:

```haskell
template PendingEvmTx
  with
    ...
    outputDeserializationSchema : Text  -- JSON ABI type array for decoding EVM return data
    respondSerializationSchema : Text   -- JSON ABI type array for re-encoding the response
  where ...
```

Both schemas use the **same JSON format** as the Solana program — an array
of `{name, type}` objects matching the `AbiSchemaField` type from fakenet:

```json
[{ "name": "", "type": "bool" }]
```

For ERC20 `transfer(address,uint256) returns (bool)`, both schemas are
`[{"name":"","type":"bool"}]`. They diverge for more complex returns — e.g.
a DEX swap might use:

- `outputDeserializationSchema`: `[{"name":"amountOut","type":"uint256"}]`
- `respondSerializationSchema`: `[{"name":"amountOut","type":"uint256"}]`

On Solana, the `respond_serialization_schema` uses Borsh format (since
Solana programs decode Borsh). Canton uses ABI for both schemas because
`Abi.daml` already handles ABI decoding on-ledger.

The MPC service reads `outputDeserializationSchema` from the `PendingEvmTx`
contract to know which ABI types to decode from the re-simulated call
result, then uses `respondSerializationSchema` to ABI-encode the response
posted back as `mpcOutput`.

**Serialization format selection**: The fakenet determines the response
encoding format from the CAIP-2 chain ID of the response destination
(Solana -> Borsh format 0, EVM -> ABI format 1). Canton's MPC service
always uses ABI (format 1) since the Daml ledger decodes ABI via
`Abi.daml`.

### Changes by Layer

#### 1. Daml — `Erc20Vault.daml`

**`PendingEvmTx`** — add `outputDeserializationSchema : Text` and `respondSerializationSchema : Text`

**New helpers** (in `Abi.daml`):

```haskell
hasErrorPrefix : BytesHex -> Bool
hasErrorPrefix hex = DA.Text.length hex >= 8 && DA.Text.take 8 hex == "deadbeef"

stripErrorPrefix : BytesHex -> BytesHex
stripErrorPrefix hex = DA.Text.drop 8 hex
```

**`ClaimEvmDeposit`** — replace:

```haskell
-- before
assertMsg "MPC reported ETH transaction failure"
  (outcome.mpcOutput == "01")
```

with:

```haskell
-- after
assertMsg "MPC reported ETH transaction failure"
  (not (hasErrorPrefix outcome.mpcOutput))
let success = abiDecodeBool outcome.mpcOutput 0
assertMsg "ERC20 transfer returned false" success
```

**`CompleteEvmWithdrawal`** — replace:

```haskell
-- before
if outcome.mpcOutput == "01"
  then return None
  else do ...refund...
```

with:

```haskell
-- after
let shouldRefund =
      if hasErrorPrefix outcome.mpcOutput then True
      else not (abiDecodeBool outcome.mpcOutput 0)
if not shouldRefund
  then return None
  else do ...refund...
```

**`RequestEvmDeposit` / `RequestEvmWithdrawal`** — add schema parameters
to both choices and pass them through to `PendingEvmTx`:

```haskell
nonconsuming choice RequestEvmDeposit : ContractId PendingEvmTx
  with
    ...
    outputDeserializationSchema : Text   -- NEW
    respondSerializationSchema : Text    -- NEW
  controller requester
  do
    ...
    create PendingEvmTx with
      ...; outputDeserializationSchema; respondSerializationSchema
```

Same for `RequestEvmWithdrawal`. Callers pass
`[{"name":"","type":"bool"}]` for both schemas in the ERC20 case.

#### 2. Daml — `RequestId.daml`

**No changes.** `computeResponseHash` already hashes `mpcOutput` generically
via `safeKeccak256 output` — works for any length.

#### 3. TypeScript — `tx-handler.ts` (MPC Service)

**`PendingTx`** — add `evmParams`:

```typescript
export interface PendingTx {
  requestId: string;
  requester: string;
  signedTxHash: Hex;
  fromAddress: Hex;
  nonce: number;
  checkCount: number;
  evmParams: CantonEvmParams; // NEW — needed for re-simulation
}
```

`evmParams` are already available in `signAndEnqueue` from the contract
payload — just pass them through to the return value.

**`checkPendingTx`** — replace the boolean receipt check with return data
extraction:

```typescript
// current
const hasTransferEvent = receipt.logs.some(
  (log) => log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase(),
);
if (receipt.status === "success" && hasTransferEvent) {
  mpcOutput = "01";
} else {
  mpcOutput = "00";
}
```

becomes:

```typescript
// proposed
if (receipt.status === "success") {
  mpcOutput = await extractReturnData(config.rpcUrl, tx);
} else {
  mpcOutput = "deadbeef" + encodeAbiParameters([{ type: "bool" }], [true]).slice(2);
}
```

Note: uses viem's `encodeAbiParameters` (not ethers `AbiCoder`).

The Transfer event check is removed — return data decoding supersedes it.
The Daml contract checks the actual `bool` return value, which catches
both reverted transfers and `transfer() returns false` tokens.

**Known limitation**: tokens that return no value from `transfer()` (e.g.
USDT-style) would produce empty return data, causing `abiDecodeBool` to
fail. Not a concern for the PoC's test token but would need a
`bytes.length == 0 → assume success` fallback for production.

**Nonce-consumed-but-no-receipt** (tx replaced) — also use error prefix:

```typescript
mpcOutput = "deadbeef" + encodeAbiParameters([{ type: "bool" }], [true]).slice(2);
```

**New function `extractReturnData`**:

```typescript
async function extractReturnData(rpcUrl: string, tx: PendingTx): Promise<string> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const receipt = await client.getTransactionReceipt({ hash: tx.signedTxHash });
  const calldata = buildCalldata(tx.evmParams.functionSignature, tx.evmParams.args);
  const result = await client.call({
    to: `0x${tx.evmParams.to}`,
    data: calldata,
    account: tx.fromAddress,
    blockNumber: receipt.blockNumber - 1n,
  });
  return result.data!.slice(2); // strip 0x prefix — Canton uses bare hex
}
```

`buildCalldata` (currently a local helper in `tx-builder.ts`) needs to be
exported.

#### 4. TypeScript — `signer.ts` / `crypto.ts`

**No changes.** Both `signMpcResponse` and `computeResponseHash` already
handle arbitrary-length hex strings for `mpcOutput`.

#### 5. TypeScript — Tests

**`e2e-setup.ts`** — `RequestEvmDeposit` call (line 225) needs schema args:

```typescript
{
  ...existing args,
  outputDeserializationSchema: '[{"name":"","type":"bool"}]',
  respondSerializationSchema: '[{"name":"","type":"bool"}]',
}
```

Same for `RequestEvmWithdrawal` in `sepolia-withdrawal-e2e.test.ts`.

**`sepolia-e2e.test.ts`** — change assertion from `mpcOutput === "01"` to:

```typescript
expect(result.mpcOutput).toBe("0000000000000000000000000000000000000000000000000000000000000001");
```

**`visibility-permissions.test.ts`** — `RequestEvmDeposit` call (line 224)
needs schema args added.

**New unit test** — `abi-return-data.test.ts`:

- Test `extractReturnData` with mocked `client.call` responses
- Test error prefix generation and parsing
- Test round-trip: viem ABI-encodes `bool(true)` -> same hex that Daml
  `abiDecodeBool` decodes (already covered by existing cross-language
  vectors in `abi.test.ts` + `TestAbi.daml`)

#### 6. Daml — `TestFixtures.daml`

**Regenerate DER signatures.** The existing fixtures are signed over
`computeResponseHash(requestId, "01")` and `computeResponseHash(requestId, "00")`.
After migration, three signatures are needed:

| Fixture                        | Signed over                                             | Purpose                            |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------- |
| `claimTestSignature`           | `computeResponseHash(requestId, "0000...0001")`         | Deposit claim (bool true)          |
| `refundTestSignature`          | `computeResponseHash(requestId, "deadbeef0000...0001")` | Withdrawal error (deadbeef prefix) |
| `boolFalseTestSignature` (NEW) | `computeResponseHash(requestId, "0000...0000")`         | Transfer returned false            |

Generate these from the existing TS test private key using `signMpcResponse`.

#### 7. Daml — `TestVault.daml`

Every `ProvideEvmOutcomeSig` and `createCmd PendingEvmTx` needs updating:

- `mpcOutput = "01"` -> `mpcOutput = "0000...0001"` (64 hex chars)
- `mpcOutput = "00"` -> `mpcOutput = "deadbeef0000...0001"` (error prefix)
  or `mpcOutput = "0000...0000"` (bool false, for the new test case)
- Every `createCmd PendingEvmTx with ...` needs schema fields added
  (8 call sites)
- Matching DER signatures must use the regenerated fixtures

Add new test `testClaimRejectsBoolFalse` using the new
`boolFalseTestSignature` fixture — verifies that `abiDecodeBool == False`
is rejected on the claim path.

## Migration Path

This is a **breaking change** to the `mpcOutput` format and `PendingEvmTx`
template (new fields). Since Canton requires a sandbox restart for template
field additions, the migration is straightforward:

1. Add `hasErrorPrefix`, `stripErrorPrefix` to `Abi.daml` with tests
2. Add `outputDeserializationSchema` and `respondSerializationSchema` to `PendingEvmTx`
3. Add schema parameters to `RequestEvmDeposit` and `RequestEvmWithdrawal` choices
4. Update `ClaimEvmDeposit` and `CompleteEvmWithdrawal` to use ABI decoding
5. Export `buildCalldata` from `tx-builder.ts`
6. Update MPC service `checkPendingTx` to extract return data via re-simulation
7. Update MPC service `signAndEnqueue` to carry `evmParams` on `PendingTx`
8. Regenerate DER test fixtures for new mpcOutput values
9. Update all Daml tests (`TestVault.daml`): schema fields, mpcOutput values, signatures
10. Update all TS tests: schema args in choice calls, mpcOutput assertions
11. Restart sandbox, redeploy DAR

All changes ship together — no incremental rollout needed since this is
a PoC with sandbox restarts.

## Future Extensions

Once `mpcOutput` carries real ABI data, these become straightforward:

- **DEX swap results** — schemas = `[{"name":"amountOut","type":"uint256"}]`,
  Daml decodes `abiDecodeUint mpcOutput 0` to get the actual output amount
- **Multi-return functions** — schemas =
  `[{"name":"a","type":"uint256"},{"name":"b","type":"uint256"}]`,
  decode multiple slots
- **Batch operations** — schemas = `[{"name":"results","type":"bool[]"}]`,
  decode dynamic arrays using the existing `Abi.daml` array decoders
- **Arbitrary contract calls** — any Solidity function return type
  can be described in the `[{name,type}]` schema and decoded on-ledger
- **No-return-value tokens** (USDT-style) — MPC service treats empty
  return data as success (schema: `[]` empty array), Daml skips decode

The schema fields on `PendingEvmTx` mean the Daml templates never need
to change — only the choice logic that interprets the decoded values.

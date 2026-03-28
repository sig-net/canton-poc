# UInt256 Limb-Based BigInt for Daml — Implementation Plan

## Context

Daml's native `Int` is 64-bit signed (max ~9.2e18). EVM `uint256` values are up to 2^256-1 (~1.16e77) — 10^58x larger. Today all numeric values are stored as `BytesHex` strings with only text comparison (`HexCompare.daml`). No arithmetic (add/sub/mul/div) exists on-ledger, blocking partial withdrawals, balance merging, and fee validation.

This implements a limb-based `UInt256` type — the same approach used by GMP, Python's `int`, Go's `math/big`, and V8's `BigInt`. Base 2^28 with 10 limbs in a Daml record gives O(1) field access and clean hex conversion (7 hex chars per limb).

---

## Files

| File | Action | Est. LOC |
|------|--------|----------|
| `daml/UInt256.daml` | **Create** — Core type + all arithmetic | ~600 |
| `daml/TestUInt256.daml` | **Create** — Daml Script tests with hardcoded vectors | ~400 |
| `test/src/test/uint256-vectors.test.ts` | **Create** — TS reference tests (same vectors, ground truth from native BigInt) | ~200 |
| **Total** | | **~1,200** |

No existing files are modified. `UInt256.daml` is a standalone module (like `HexCompare.daml`), importable by `Erc20Vault.daml` or `Abi.daml` in future work.

---

## Phase 1: Type + Conversion + Add/Sub/Compare

### 1.1 UInt256 Record Type

```
data UInt256 = UInt256 with
  l0: Int; l1: Int; l2: Int; l3: Int; l4: Int
  l5: Int; l6: Int; l7: Int; l8: Int; l9: Int
  deriving (Eq, Show)
```

- Base B = 2^28 = 268435456, mask M = B-1 = 0x0FFFFFFF
- Little-endian: l0 = least significant, l9 = most significant
- l0..l8: range [0, 2^28-1]. l9: range [0, 15] (only 4 bits: 256 - 9*28 = 4)

### 1.2 Constants

- `uint256Zero` — all limbs 0
- `uint256One` — l0=1, rest 0
- `uint256Max` — l0..l8 = 0x0FFFFFFF, l9 = 15

### 1.3 Hex Conversion

**`uint256FromHex : BytesHex -> UInt256`**
- Left-pad input to 70 chars (prepend `"000000"` to the 64-char input after padding with `hexPadUint256`)
- Chunk from right in groups of 7: chars [63..69] = l0, [56..62] = l1, ..., [0..6] = l9
- Parse each 7-char chunk to Int using a `hexChunkToInt` helper (foldl over code points)
- Reuse existing `hexPadUint256` from `HexCompare.daml` for input normalization

**`uint256ToHex : UInt256 -> BytesHex`**
- Convert l9 to 1 hex char, l8..l0 each to 7 zero-padded hex chars
- Concatenate: 1 + 9*7 = 64 chars exactly
- Use `intToHexChunk : Int -> Int -> Text` helper (converts Int to N hex chars)

**Helpers:**
- `hexCharToInt : Int -> Int` — ASCII code point to 0-15 (0-9: cp-48, a-f: cp-87)
- `intToHexChar : Int -> Text` — 0-15 to hex char
- `hexChunkToInt : Text -> Int` — parse up to 7 hex chars via `DA.Text.toCodePoints` + `foldl`
- `intToHexChunk : Int -> Int -> Text` — Int to N-char zero-padded hex

### 1.4 Addition

**`uint256Add : UInt256 -> UInt256 -> UInt256`** (mod 2^256 wrapping)

Carry propagation through 10 limbs. Thread carry as accumulator:
```
sum_i = a.l_i + b.l_i + carry_in
result.l_i = sum_i % B       (bitwise: sum_i & M)
carry_out = sum_i / B         (bitwise: sum_i >> 28 — but Daml has no bitshift, use div)
```
Max intermediate: M + M + 1 = 2B-1 = 536870911 (30 bits). Fits in Int64.

After l9: truncate result.l9 to 4 bits (result.l9 % 16) for mod 2^256 wrapping. Discard final carry.

**`uint256AddChecked : UInt256 -> UInt256 -> (UInt256, Bool)`** — same but returns overflow flag.

### 1.5 Subtraction

**`uint256Sub : UInt256 -> UInt256 -> UInt256`** (mod 2^256 wrapping)

Borrow propagation:
```
diff_i = a.l_i - b.l_i - borrow_in
if diff_i < 0: result.l_i = diff_i + B, borrow_out = 1
else:          result.l_i = diff_i,     borrow_out = 0
```
Intermediate range: [-B, M]. Fits in Int64.

**`uint256SubChecked : UInt256 -> UInt256 -> (UInt256, Bool)`** — returns underflow flag.

### 1.6 Comparison

**`uint256Compare : UInt256 -> UInt256 -> Ordering`**

Compare limb-by-limb from MSB (l9) to LSB (l0). First unequal limb determines result. 10 comparisons worst case.

**Convenience wrappers** (matching HexCompare naming pattern):
- `uint256Eq`, `uint256Gt`, `uint256Gte`, `uint256Lt`, `uint256Lte`
- `uint256IsZero`

---

## Phase 2: Multiplication + Short Division

### 2.1 Multiplication (Schoolbook)

**`uint256Mul : UInt256 -> UInt256 -> UInt256`** (mod 2^256, truncate to lower 256 bits)

Double loop producing a 20-limb intermediate. Use an internal list `[Int]` of length 20 (not a record — only used transiently):

```
for i = 0..9:
  carry = 0
  for j = 0..9:
    acc = result[i+j] + a[i] * b[j] + carry
    result[i+j] = acc % B
    carry = acc / B
  result[i+10] = carry
```

Max accumulator: M + M*M + B = 2^56 - 1. **Fits in Int64** (7 bits headroom).

Implementation: convert UInt256 to `[Int]` (10 elements), run schoolbook on `[Int]`, build result UInt256 from first 10 elements.

Helper: `mulLimbs : [Int] -> [Int] -> [Int]` — returns 20-element list.

**`uint256MulChecked : UInt256 -> UInt256 -> (UInt256, Bool)`** — overflow if any of limbs [10..19] nonzero or result.l9 > 15.

### 2.2 Short Division

**`uint256DivInt : UInt256 -> Int -> (UInt256, Int)`** — divide uint256 by a single-limb value (0 < d < B). Returns (quotient, remainder).

Scan from MSB to LSB:
```
remainder = 0
for i = 9 downto 0:
  acc = remainder * B + limb[i]
  q[i] = acc / d
  remainder = acc % d
```

Max accumulator: (d-1)*B + M < M*B < 2^56. **Fits in Int64.**

Error on d == 0.

---

## Phase 3: Full Division (Knuth Algorithm D) + Modulo + Shifts

### 3.1 Bit Shifts (helpers for division normalization)

**`shlBits : [Int] -> Int -> [Int]`** — left shift limb list by s bits (0 <= s <= 27). Returns n+1 element list (overflow limb appended).
```
carry = 0
for i = 0..n-1:
  val = limb[i] * (2^s) + carry    -- no bitshift in Daml, use multiplication by power of 2
  result[i] = val % B
  carry = val / B
result[n] = carry
```

**`shrBits : [Int] -> Int -> [Int]`** — right shift by s bits. Similar reverse scan.

**`clz28 : Int -> Int`** — count leading zeros in a 28-bit value. Unrolled binary search (5 comparisons). Needed to compute normalization shift.

### 3.2 Full Division (Knuth Algorithm D)

**`uint256Div : UInt256 -> UInt256 -> UInt256`** — quotient
**`uint256Mod : UInt256 -> UInt256 -> UInt256`** — remainder
**`uint256DivMod : UInt256 -> UInt256 -> (UInt256, UInt256)`** — both

Implementation works on `[Int]` limb lists internally:

**Step D1 — Normalize:** Find shift s = `clz28(v's top nonzero limb)`. Left-shift both u and v by s bits. u gets an extra limb from overflow.

**Step D3 — Trial quotient:**
```
twoLimb = u[j+n] * B + u[j+n-1]     -- max < B^2 = 2^56, FITS
qHat = twoLimb / v[n-1]
rHat = twoLimb % v[n-1]
-- Refine while qHat >= B or qHat * v[n-2] > rHat * B + u[j+n-2]
```

**Step D4 — Multiply and subtract:** Combined loop: `qHat * v[i]` with carry, subtract from u with borrow.

**Step D5 — Add-back:** If subtract went negative, decrement qHat and add v back. Rare (~1 in 134 million) but must be implemented.

**Step D8 — Unnormalize:** Right-shift remainder by s bits.

**Special cases handled at entry:**
- Division by zero: error
- Dividend < divisor: quotient = 0, remainder = dividend
- Divisor fits in one limb: delegate to `uint256DivInt` (Phase 2)

### 3.3 Integration with BytesHex API

Convenience wrappers for direct hex-string arithmetic:
- `hexAddUint256 : BytesHex -> BytesHex -> BytesHex`
- `hexSubUint256 : BytesHex -> BytesHex -> BytesHex`
- `hexMulUint256 : BytesHex -> BytesHex -> BytesHex`
- `hexDivUint256 : BytesHex -> BytesHex -> BytesHex`
- `hexModUint256 : BytesHex -> BytesHex -> BytesHex`

Each: `fromHex -> operate -> toHex`. One-liner wrappers.

---

## Test Plan

### Test vector strategy

Follow the project's existing cross-language pattern:
- Ground truth computed by TypeScript native `BigInt`
- Same vectors hardcoded in both `test/src/test/uint256-vectors.test.ts` and `daml/TestUInt256.daml`
- Comments: `-- Cross-language vectors (oracle: TypeScript BigInt)`
- Daml tests run via `dpm test`, TS tests via `vitest run`

### Test vector categories

Derived from GMP `t-div.c`, CPython `test_long.py`, Go `nat_test.go`, and Elm `elm-bigint`:

#### Category 1: Constants and identity
- `uint256Zero`, `uint256One`, `uint256Max` roundtrip through hex conversion
- `x + 0 == x`, `x - 0 == x`, `x * 1 == x`, `x / 1 == x` for several x values

#### Category 2: Hex round-trip
- `toHex(fromHex(x)) == x` for: zero, one, max, powers of 2, arbitrary values
- Input normalization: short hex strings, odd-length, mixed case

#### Category 3: Limb boundary values
- B-1 = 0x0FFFFFFF (single limb max)
- B = 0x10000000 (crosses into second limb)
- B^k - 1 for k = 1..10 (all-F patterns within limb groups)
- 2^28, 2^56, 2^84, ..., 2^252 (exactly one bit set per limb)

#### Category 4: Addition
- Small + small, large + large
- Carry cascade: (B-1) + 1 at each limb position
- Full carry chain: `0xFFF...F + 1 == 0` (overflow wrap)
- Commutativity: `a + b == b + a`
- Overflow detection: `uint256Max + 1` flags overflow

#### Category 5: Subtraction
- Simple: `a - b` where a > b
- Borrow cascade: `B^k - 1` patterns
- Underflow wrap: `0 - 1 == uint256Max`
- Inverse: `(a + b) - b == a`

#### Category 6: Multiplication
- Small factors: `x * 2`, `x * 256`, `x * B`
- Large factors: values near 2^128 multiplied together
- Commutativity: `a * b == b * a`
- Distributive: `a * (b + c) == a*b + a*c` (for non-overflowing cases)
- Overflow truncation: `(2^128) * (2^128)` wraps to 0 (mod 2^256)
- `uint256Max * uint256Max` mod 2^256 == 1

#### Category 7: Short division
- `x / 1 == x`, `x / x == 1` (when x fits in one limb)
- `0 / d == 0`
- Remainder check: `q * d + r == x`
- Division by zero: error

#### Category 8: Full division (Knuth D edge cases)
Adapted from CPython's `test_long.py` and Go's `nat_test.go`:
- Dividend == divisor: q=1, r=0
- Dividend < divisor: q=0, r=dividend
- Dividend barely > divisor
- Divisor with top limb requiring normalization shift
- Vectors that trigger q_hat refinement (trial quotient too high by 1 or 2)
- Vectors that trigger add-back correction (Step D5) — rare but critical
- Exact division (remainder = 0)
- Invariant: `(a / b) * b + (a % b) == a` for all pairs

#### Category 9: EVM-relevant values
- 1e18 (1 ETH in wei), 1e6 (1 USDC), 1e15 (0.001 token — project's DEPOSIT_AMOUNT)
- 2^160 - 1 (max address), 2^96 (common packed value boundary)
- Gas calculations: `gasLimit * maxFeePerGas` with realistic Sepolia values
- Token transfer amounts from `TestFixtures.daml`: `sampleHoldingAmount`

#### Category 10: Comparison
- Equal values at every limb position
- Differ at l9 only, differ at l0 only
- All orderings (LT, EQ, GT) for each convenience wrapper

### Estimated test counts

| Phase | Daml tests | TS tests | Vectors |
|-------|-----------|----------|---------|
| 1: Core | ~25 `Script ()` functions | ~25 `test()` blocks | ~80 vectors |
| 2: Mul/Div | ~15 | ~15 | ~50 vectors |
| 3: Full Div | ~15 | ~15 | ~40 vectors |
| **Total** | **~55** | **~55** | **~170** |

---

## Implementation Order

### Phase 1 (~350 LOC total)
1. `UInt256` record type + constants
2. `hexCharToInt`/`intToHexChar` lookup helpers
3. `uint256FromHex` + `uint256ToHex`
4. `uint256Add` + `uint256AddChecked`
5. `uint256Sub` + `uint256SubChecked`
6. `uint256Compare` + convenience wrappers + `uint256IsZero`
7. Tests for all of the above (both Daml and TS)
8. Verify: `dpm build && dpm test` and `cd test && pnpm test`

### Phase 2 (~250 LOC total)
1. `toLimbs`/`fromLimbs` helpers (UInt256 <-> [Int])
2. `mulLimbs` schoolbook algorithm
3. `uint256Mul` + `uint256MulChecked`
4. `uint256DivInt` (short division)
5. Tests
6. Verify: `dpm build && dpm test` and `cd test && pnpm test`

### Phase 3 (~400 LOC total)
1. `clz28`, `shlBits`, `shrBits` helpers
2. `divModLimbs` — Knuth Algorithm D
3. `uint256Div`, `uint256Mod`, `uint256DivMod`
4. `hexAddUint256`, `hexSubUint256`, `hexMulUint256`, `hexDivUint256`, `hexModUint256` convenience wrappers
5. Tests (including CPython/Go edge-case vectors)
6. Verify: `dpm build && dpm test` and `cd test && pnpm test`

---

## Verification

After each phase:
1. `cd /Users/felipesousapessina/Documents/signet/currently-working/canton-mpc-poc && dpm build` — DAR compiles
2. `dpm test` — all Daml Script tests pass (including existing TestAbi, TestCrypto, etc.)
3. `cd test && pnpm test` — all TS tests pass (including new uint256-vectors.test.ts)
4. `pnpm check` (root) — lint + types + knip + format all clean

---

## Existing code to reuse

| What | Where | How |
|------|-------|-----|
| `hexPadUint256` | `daml/HexCompare.daml:69` | Normalize hex input before `fromHex` |
| `BytesHex` type | `DA.Crypto.Text` | All hex string types |
| `assertMsg` | `Daml.Script` | Test assertions |
| Test vector pattern | `daml/TestAbi.daml:10-12` | Cross-language comment format |
| `DA.Text.toCodePoints` | Daml stdlib | Hex char parsing without 16-branch match |
| `DA.Text.fromCodePoints` | Daml stdlib | Int to hex char emission |

---

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Knuth Algorithm D off-by-one bugs | Port from CPython's `longobject.c` which is heavily battle-tested; use their exact edge-case test vectors |
| Daml interpreter performance on mul/div | Benchmark after Phase 2; if too slow, consider short-circuiting common cases (multiply by 0/1, divide by 1) |
| Carry/borrow bugs in add/sub | Cross-validate every vector against TypeScript BigInt; include full carry-chain tests |
| `getLimb`/`setLimb` verbosity (10 cases each) | Accept the verbosity — it's a one-time cost and gives O(1) access |
| No Daml bitshift operators | Use `* (power of 2)` for left shift and `/ (power of 2)` for right shift — Daml Int division truncates toward zero, which is correct for non-negative values |

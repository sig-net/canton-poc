import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Cross-language vectors (oracle: TypeScript BigInt)
// Must match daml/TestUInt256.daml
// ---------------------------------------------------------------------------

const UINT256_MAX = (1n << 256n) - 1n;

function toHex256(n: bigint): string {
  return (n & UINT256_MAX).toString(16).padStart(64, "0");
}

// ---------------------------------------------------------------------------
// Vector constants — no 0x prefix, 64 lowercase hex chars (Daml convention)
// ---------------------------------------------------------------------------

const VECTORS = {
  // --- Constants ---
  zero: "0000000000000000000000000000000000000000000000000000000000000000",
  one: "0000000000000000000000000000000000000000000000000000000000000001",
  two: "0000000000000000000000000000000000000000000000000000000000000002",
  three: "0000000000000000000000000000000000000000000000000000000000000003",
  seven: "0000000000000000000000000000000000000000000000000000000000000007",
  twentyOne: "0000000000000000000000000000000000000000000000000000000000000015",
  max: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",

  // --- Limb boundaries (base 2^28) ---
  limbMax: "000000000000000000000000000000000000000000000000000000000fffffff",
  limbBase: "0000000000000000000000000000000000000000000000000000000010000000",

  // --- Powers of two ---
  pow128: "0000000000000000000000000000000100000000000000000000000000000000",
  pow129: "0000000000000000000000000000000200000000000000000000000000000000",

  // --- EVM values ---
  oneEth: "0000000000000000000000000000000000000000000000000de0b6b3a7640000",
  twoEth: "0000000000000000000000000000000000000000000000001bc16d674ec80000",
  oneUsdc: "00000000000000000000000000000000000000000000000000000000000f4240",
  oneTrillion: "000000000000000000000000000000000000000000000000000000e8d4a51000",
  gasPrice20Gwei: "00000000000000000000000000000000000000000000000000000004a817c800",
  gasCost21k: "00000000000000000000000000000000000000000000000000017dfcdece4000",

  // --- Division results ---
  maxDiv2Quotient: "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",

  // --- Addition results ---
  addOnePlusOne: "0000000000000000000000000000000000000000000000000000000000000002",
  addLimbCarry: "0000000000000000000000000000000000000000000000000000000010000000",
  addOverflow: "0000000000000000000000000000000000000000000000000000000000000000",
  addOneEthPlusOneEth: "0000000000000000000000000000000000000000000000001bc16d674ec80000",

  // --- Subtraction results ---
  subTwoMinusOne: "0000000000000000000000000000000000000000000000000000000000000001",
  subLimbBorrow: "000000000000000000000000000000000000000000000000000000000fffffff",
  subUnderflow: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",

  // --- Multiplication results ---
  mulThreeTimesSeven: "0000000000000000000000000000000000000000000000000000000000000015",
  mulOneEthTimesTwo: "0000000000000000000000000000000000000000000000001bc16d674ec80000",
  mulPow128Squared: "0000000000000000000000000000000000000000000000000000000000000000",
  mulMaxTimesMax: "0000000000000000000000000000000000000000000000000000000000000001",

  // --- Short division results ---
  divMaxBy2Quotient: "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  divOneEthBy1e6Quotient: "000000000000000000000000000000000000000000000000000000e8d4a51000",
  divSevenByTwoQuotient: "0000000000000000000000000000000000000000000000000000000000000003",

  // --- Additional powers of two ---
  pow56: toHex256(1n << 56n),
  pow140: toHex256(1n << 140n),
  pow252: toHex256(1n << 252n),
  pow255: toHex256(1n << 255n),

  // --- Limb-range maxima ---
  lower2LimbsMax: toHex256((1n << 56n) - 1n),
  lowerFiveLimbsMax: toHex256((1n << 140n) - 1n),
  lower9LimbsMax: toHex256((1n << 252n) - 1n),

  // --- Alternating bit patterns ---
  patternA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  pattern5: "5555555555555555555555555555555555555555555555555555555555555555",

  // --- 128-bit boundary ---
  pow128MinusOne: toHex256((1n << 128n) - 1n),
  pow128PlusOne: toHex256((1n << 128n) + 1n),

  // --- Multiplication index boundary ---
  limbMaxTimesLimbBase: toHex256(((1n << 28n) - 1n) * (1n << 28n)),

  // --- Short division edge ---
  divMaxByLimbMaxQuotient: "0000001000000100000010000001000000100000010000001000000100000010",

  // --- Audit vectors: addChecked / mulChecked / subChecked ---
  maxMinusOne: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe",
  subThreeMinusSeven: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc",
  oneMinusPow128: "ffffffffffffffffffffffffffffffff00000000000000000000000000000001",

  // --- Audit vectors: Karatsuba ---
  karatsubaResult: "fffffffffffffffffffffffffffffffe00000000000000000000000000000001",

  // --- Audit vectors: powers-of-2 divisors ---
  divMaxBy16Quotient: "0fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  divMaxByPow27Quotient: "0000001fffffffffffffffffffffffffffffffffffffffffffffffffffffffff",

  // --- Audit vectors: random multi-limb addition ---
  randAddA: "c4043e2c4cc49e4d6870103ce7c2ff2d512bf4b1b67553ba410db514ee0af888",
  randAddB: "3bf9c1d3b33b61b2978fefc31843d00d2aed40b4e498aac45bef24aeb11f5877",
  randAddResult: "fffe000000000000000000000006cf3a7c1935669b0dfe7e9cfcd9c39f2a50ff",
  randAdd2A: "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788990aabbccddeeff",
  randAdd2B: "05e4d3c2b1a09f8e7d6c5b4a39281706ffeedccbbaa998877665543210012301",
  randAdd2Result: "a79797979796a6a6a6a6a6a6a6a6a6970100fffffffffffffff5feeddcdf1200",
  randAdd3A: "deadbeefcafebabe1234567890abcdef0011223344556677fedcba9876543210",
  randAdd3B: "1111111111111111111111111111111122222222222222224444444444444444",
  randAdd3Result: "efbed000dc0fcbcf23456789a1bcdf00223344556677889a4320fedcba987654",

  // --- Audit vectors: asymmetric multiplication ---
  mulAsym1A: "deadbeefcafebabe1234567890abcdef0011223344556677fedcba9876543210",
  mulAsym1B: "00000000000000000000000000000000000000000000000000000000000000ff",
  mulAsym1Result: "cf1130db33bc0354222222181b2221111111111111111186ddddddddddddddf0",
  mulAsym2A: "ffffffffffffffffffffffffffffffff00000000000000000000000000000000",
  mulAsym2B: "0000000000000000000000000000000000000000000000000000000000000003",
  mulAsym2Result: "fffffffffffffffffffffffffffffffd00000000000000000000000000000000",
  mulAsym3A: "a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5",
  mulAsym3B: "0000000000000000000000000000000000000000000000000000000000010001",
  mulAsym3Result: "4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4aa5a5",
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UInt256 arithmetic vectors (cross-language ground truth)", () => {
  // -------------------------------------------------------------------------
  // 1. Constants
  // -------------------------------------------------------------------------
  describe("Constants", () => {
    it("zero", () => {
      expect(toHex256(0n)).toBe(VECTORS.zero);
    });

    it("one", () => {
      expect(toHex256(1n)).toBe(VECTORS.one);
    });

    it("max (2^256 - 1)", () => {
      expect(toHex256(UINT256_MAX)).toBe(VECTORS.max);
    });

    it("two", () => {
      expect(toHex256(2n)).toBe(VECTORS.two);
    });

    it("three", () => {
      expect(toHex256(3n)).toBe(VECTORS.three);
    });

    it("seven", () => {
      expect(toHex256(7n)).toBe(VECTORS.seven);
    });

    it("twentyOne (0x15)", () => {
      expect(toHex256(21n)).toBe(VECTORS.twentyOne);
    });

    it("limbMax (2^28 - 1)", () => {
      expect(toHex256((1n << 28n) - 1n)).toBe(VECTORS.limbMax);
    });

    it("limbBase (2^28)", () => {
      expect(toHex256(1n << 28n)).toBe(VECTORS.limbBase);
    });

    it("pow128 (2^128)", () => {
      expect(toHex256(1n << 128n)).toBe(VECTORS.pow128);
    });

    it("pow129 (2^129)", () => {
      expect(toHex256(1n << 129n)).toBe(VECTORS.pow129);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Hex round-trip
  // -------------------------------------------------------------------------
  describe("Hex round-trip", () => {
    const roundTripCases: [string, bigint][] = [
      ["zero", 0n],
      ["one", 1n],
      ["max", UINT256_MAX],
      ["limbMax", (1n << 28n) - 1n],
      ["limbBase", 1n << 28n],
      ["pow128", 1n << 128n],
      ["oneEth", 10n ** 18n],
      ["oneUsdc", 10n ** 6n],
    ];

    for (const [label, value] of roundTripCases) {
      it(`${label}: BigInt -> hex -> BigInt`, () => {
        const hex = toHex256(value);
        const parsed = BigInt("0x" + hex);
        expect(parsed).toBe(value);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 3. Addition
  // -------------------------------------------------------------------------
  describe("Addition", () => {
    it("identity: 1 + 1 = 2", () => {
      const result = toHex256(1n + 1n);
      expect(result).toBe(VECTORS.addOnePlusOne);
      expect(result).toBe(VECTORS.two);
    });

    it("carry: limbMax + 1 = limbBase", () => {
      const result = toHex256((1n << 28n) - 1n + 1n);
      expect(result).toBe(VECTORS.addLimbCarry);
      expect(result).toBe(VECTORS.limbBase);
    });

    it("overflow wrap: max + 1 = 0", () => {
      const result = toHex256(UINT256_MAX + 1n);
      expect(result).toBe(VECTORS.addOverflow);
      expect(result).toBe(VECTORS.zero);
    });

    it("oneEth + oneEth = twoEth", () => {
      const result = toHex256(10n ** 18n + 10n ** 18n);
      expect(result).toBe(VECTORS.addOneEthPlusOneEth);
      expect(result).toBe(VECTORS.twoEth);
    });

    it("commutativity: a + b = b + a", () => {
      const a = 10n ** 18n;
      const b = (1n << 128n) - 1n;
      expect(toHex256(a + b)).toBe(toHex256(b + a));
    });
  });

  // -------------------------------------------------------------------------
  // 4. Subtraction
  // -------------------------------------------------------------------------
  describe("Subtraction", () => {
    it("identity: 2 - 1 = 1", () => {
      const result = toHex256(2n - 1n);
      expect(result).toBe(VECTORS.subTwoMinusOne);
      expect(result).toBe(VECTORS.one);
    });

    it("borrow: limbBase - 1 = limbMax", () => {
      const result = toHex256((1n << 28n) - 1n);
      expect(result).toBe(VECTORS.subLimbBorrow);
      expect(result).toBe(VECTORS.limbMax);
    });

    it("underflow wrap: 0 - 1 = max", () => {
      const result = toHex256(0n - 1n);
      expect(result).toBe(VECTORS.subUnderflow);
      expect(result).toBe(VECTORS.max);
    });

    it("inverse: (a + b) - b = a", () => {
      const a = 10n ** 18n;
      const b = (1n << 128n) - 1n;
      const sum = (a + b) & UINT256_MAX;
      expect(toHex256(sum - b)).toBe(toHex256(a));
    });
  });

  // -------------------------------------------------------------------------
  // 5. Multiplication
  // -------------------------------------------------------------------------
  describe("Multiplication", () => {
    it("identity: 3 * 7 = 21", () => {
      const result = toHex256(3n * 7n);
      expect(result).toBe(VECTORS.mulThreeTimesSeven);
      expect(result).toBe(VECTORS.twentyOne);
    });

    it("by zero: max * 0 = 0", () => {
      expect(toHex256(UINT256_MAX * 0n)).toBe(VECTORS.zero);
    });

    it("small: oneEth * 2 = twoEth", () => {
      const result = toHex256(10n ** 18n * 2n);
      expect(result).toBe(VECTORS.mulOneEthTimesTwo);
      expect(result).toBe(VECTORS.twoEth);
    });

    it("large overflow: 2^128 * 2^128 = 0 (mod 2^256)", () => {
      const result = toHex256((1n << 128n) * (1n << 128n));
      expect(result).toBe(VECTORS.mulPow128Squared);
      expect(result).toBe(VECTORS.zero);
    });

    it("max * max = 1 (mod 2^256)", () => {
      const result = toHex256(UINT256_MAX * UINT256_MAX);
      expect(result).toBe(VECTORS.mulMaxTimesMax);
      expect(result).toBe(VECTORS.one);
    });

    it("commutativity: a * b = b * a", () => {
      const a = 10n ** 18n;
      const b = 12345n;
      expect(toHex256(a * b)).toBe(toHex256(b * a));
    });
  });

  // -------------------------------------------------------------------------
  // 6. Short division
  // -------------------------------------------------------------------------
  describe("Short division", () => {
    it("max / 2 = (2^255 - 1, remainder 1)", () => {
      const q = UINT256_MAX / 2n;
      const r = UINT256_MAX % 2n;
      expect(toHex256(q)).toBe(VECTORS.divMaxBy2Quotient);
      expect(toHex256(q)).toBe(VECTORS.maxDiv2Quotient);
      expect(r).toBe(1n);
    });

    it("1e18 / 1e6 = (1e12, remainder 0)", () => {
      const q = 10n ** 18n / 10n ** 6n;
      const r = 10n ** 18n % 10n ** 6n;
      expect(toHex256(q)).toBe(VECTORS.divOneEthBy1e6Quotient);
      expect(toHex256(q)).toBe(VECTORS.oneTrillion);
      expect(r).toBe(0n);
    });

    it("7 / 2 = (3, remainder 1)", () => {
      const q = 7n / 2n;
      const r = 7n % 2n;
      expect(toHex256(q)).toBe(VECTORS.divSevenByTwoQuotient);
      expect(toHex256(q)).toBe(VECTORS.three);
      expect(r).toBe(1n);
    });

    it("invariant: q * d + r == x", () => {
      const x = UINT256_MAX;
      const d = 2n;
      const q = x / d;
      const r = x % d;
      expect(q * d + r).toBe(x);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Comparison
  // -------------------------------------------------------------------------
  describe("Comparison", () => {
    const pairs: [string, bigint, string, bigint][] = [
      ["zero", 0n, "one", 1n],
      ["one", 1n, "max", UINT256_MAX],
      ["pow128", 1n << 128n, "max", UINT256_MAX],
      ["oneEth", 10n ** 18n, "twoEth", 2n * 10n ** 18n],
      ["oneUsdc", 10n ** 6n, "oneEth", 10n ** 18n],
    ];

    for (const [labelA, a, labelB, b] of pairs) {
      it(`${labelA} < ${labelB}`, () => {
        expect(a < b).toBe(true);
      });

      it(`${labelB} > ${labelA}`, () => {
        expect(b > a).toBe(true);
      });
    }

    it("equal: max == max", () => {
      const a = UINT256_MAX;
      const b = (1n << 256n) - 1n;
      expect(a === b).toBe(true);
    });

    it("equal: zero == zero", () => {
      const a = 0n;
      const b = UINT256_MAX + 1n - UINT256_MAX - 1n;
      expect(a === b).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 8. EVM values
  // -------------------------------------------------------------------------
  describe("EVM values", () => {
    it("1 ETH = 10^18 wei", () => {
      expect(toHex256(10n ** 18n)).toBe(VECTORS.oneEth);
    });

    it("2 ETH = 2 * 10^18 wei", () => {
      expect(toHex256(2n * 10n ** 18n)).toBe(VECTORS.twoEth);
    });

    it("1 USDC = 10^6", () => {
      expect(toHex256(10n ** 6n)).toBe(VECTORS.oneUsdc);
    });

    it("1 trillion = 10^12", () => {
      expect(toHex256(10n ** 12n)).toBe(VECTORS.oneTrillion);
    });

    it("gas price: 20 gwei", () => {
      expect(toHex256(20n * 10n ** 9n)).toBe(VECTORS.gasPrice20Gwei);
    });

    it("gas cost: 21000 * 20 gwei = 0.00042 ETH", () => {
      const cost = 21000n * 20n * 10n ** 9n;
      expect(toHex256(cost)).toBe(VECTORS.gasCost21k);
      // Verify it equals 4.2e14 wei
      expect(cost).toBe(420000000000000n);
    });
  });

  // -------------------------------------------------------------------------
  // 9. MulChecked
  // -------------------------------------------------------------------------
  describe("MulChecked", () => {
    it("3 * 7 = 21, no overflow", () => {
      const a = 3n;
      const b = 7n;
      const full = a * b;
      expect(full <= UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.twentyOne);
    });

    it("1e18 * 2, no overflow", () => {
      const a = 10n ** 18n;
      const b = 2n;
      const full = a * b;
      expect(full <= UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.twoEth);
    });

    it("2^128 * 2^128 overflows, result = 0", () => {
      const a = 1n << 128n;
      const b = 1n << 128n;
      const full = a * b;
      expect(full > UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.zero);
    });

    it("max * max overflows, result = 1", () => {
      const full = UINT256_MAX * UINT256_MAX;
      expect(full > UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.one);
    });

    it("(2^128-1) * (2^128+1) = max, NO overflow", () => {
      const a = (1n << 128n) - 1n;
      const b = (1n << 128n) + 1n;
      const full = a * b;
      expect(full).toBe(UINT256_MAX);
      expect(full <= UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.max);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Associativity
  // -------------------------------------------------------------------------
  describe("Associativity", () => {
    it("(a + b) + c == a + (b + c) for 1e18, 2^128-1, 7", () => {
      const a = 10n ** 18n;
      const b = (1n << 128n) - 1n;
      const c = 7n;
      const lhs = toHex256(a + b + c);
      const rhs = toHex256(a + (b + c));
      expect(lhs).toBe(rhs);
    });

    it("(a + b) + c == a + (b + c) for 2^252, 2^128, 1e18", () => {
      const a = 1n << 252n;
      const b = 1n << 128n;
      const c = 10n ** 18n;
      const lhs = toHex256(a + b + c);
      const rhs = toHex256(a + (b + c));
      expect(lhs).toBe(rhs);
    });

    it("(a + b) + c == a + (b + c) with carry propagation", () => {
      const a = (1n << 56n) - 1n;
      const b = 1n;
      const c = (1n << 140n) - (1n << 56n);
      const lhs = toHex256(a + b + c);
      const rhs = toHex256(a + (b + c));
      expect(lhs).toBe(rhs);
      expect(lhs).toBe(VECTORS.pow140);
    });
  });

  // -------------------------------------------------------------------------
  // 11. Distributive
  // -------------------------------------------------------------------------
  describe("Distributive", () => {
    it("a * (b + c) == a*b + a*c for a=1e18, b=2^128, c=7", () => {
      const a = 10n ** 18n;
      const b = 1n << 128n;
      const c = 7n;
      const lhs = toHex256(a * (b + c));
      const rhs = toHex256(a * b + a * c);
      expect(lhs).toBe(rhs);
    });
  });

  // -------------------------------------------------------------------------
  // 12. Carry at every limb boundary
  // -------------------------------------------------------------------------
  describe("Carry at every limb boundary", () => {
    it("(2^56 - 1) + 1 = 2^56 (carry l1 -> l2)", () => {
      const result = toHex256((1n << 56n) - 1n + 1n);
      expect(result).toBe(VECTORS.pow56);
    });

    it("(2^140 - 1) + 1 = 2^140 (carry l4 -> l5)", () => {
      const result = toHex256((1n << 140n) - 1n + 1n);
      expect(result).toBe(VECTORS.pow140);
    });

    it("(2^252 - 1) + 1 = 2^252 (carry l8 -> l9, critical 4-bit boundary)", () => {
      const result = toHex256((1n << 252n) - 1n + 1n);
      expect(result).toBe(VECTORS.pow252);
    });
  });

  // -------------------------------------------------------------------------
  // 13. Borrow at every limb boundary
  // -------------------------------------------------------------------------
  describe("Borrow at every limb boundary", () => {
    it("2^56 - 1 = lower2LimbsMax (borrow from l2)", () => {
      const result = toHex256((1n << 56n) - 1n);
      expect(result).toBe(VECTORS.lower2LimbsMax);
    });

    it("2^140 - 1 = lowerFiveLimbsMax (borrow from l5)", () => {
      const result = toHex256((1n << 140n) - 1n);
      expect(result).toBe(VECTORS.lowerFiveLimbsMax);
    });

    it("2^252 - 1 = lower9LimbsMax (borrow from l9)", () => {
      const result = toHex256((1n << 252n) - 1n);
      expect(result).toBe(VECTORS.lower9LimbsMax);
    });
  });

  // -------------------------------------------------------------------------
  // 14. Alternating bit patterns
  // -------------------------------------------------------------------------
  describe("Alternating bit patterns", () => {
    it("0xAAAA... + 0x5555... = max", () => {
      const a = BigInt("0x" + VECTORS.patternA);
      const b = BigInt("0x" + VECTORS.pattern5);
      expect(toHex256(a + b)).toBe(VECTORS.max);
    });

    it("patternA round-trips through hex", () => {
      const val = BigInt("0x" + VECTORS.patternA);
      expect(toHex256(val)).toBe(VECTORS.patternA);
    });

    it("pattern5 round-trips through hex", () => {
      const val = BigInt("0x" + VECTORS.pattern5);
      expect(toHex256(val)).toBe(VECTORS.pattern5);
    });
  });

  // -------------------------------------------------------------------------
  // 15. Multiplication index boundary
  // -------------------------------------------------------------------------
  describe("Multiplication index boundary", () => {
    it("2^28 * 2^28 = 2^56 (product at limb index 2)", () => {
      const result = toHex256((1n << 28n) * (1n << 28n));
      expect(result).toBe(VECTORS.pow56);
    });

    it("1 * 2^252 = 2^252 (product at limb index 9)", () => {
      const result = toHex256(1n * (1n << 252n));
      expect(result).toBe(VECTORS.pow252);
    });

    it("limbMax * limbBase = 2^56 - 2^28", () => {
      const result = toHex256(((1n << 28n) - 1n) * (1n << 28n));
      expect(result).toBe(VECTORS.limbMaxTimesLimbBase);
      expect(result).toBe(toHex256((1n << 56n) - (1n << 28n)));
    });
  });

  // -------------------------------------------------------------------------
  // 16. Short division edge cases
  // -------------------------------------------------------------------------
  describe("Short division edge cases", () => {
    it("max / (2^28 - 1): max valid divisor, remainder < divisor", () => {
      const d = (1n << 28n) - 1n;
      const q = UINT256_MAX / d;
      const r = UINT256_MAX % d;
      expect(toHex256(q)).toBe(VECTORS.divMaxByLimbMaxQuotient);
      expect(r < d).toBe(true);
    });

    it("q * d + r == max using BigInt", () => {
      const d = (1n << 28n) - 1n;
      const q = UINT256_MAX / d;
      const r = UINT256_MAX % d;
      expect(q * d + r).toBe(UINT256_MAX);
    });
  });

  // -------------------------------------------------------------------------
  // 17. Cross-operation round-trips
  // -------------------------------------------------------------------------
  describe("Cross-operation round-trips", () => {
    it("(a * d) / d == a for small d", () => {
      const a = 10n ** 18n;
      const d = 7n;
      const product = (a * d) & UINT256_MAX;
      expect(toHex256(product / d)).toBe(toHex256(a));
    });

    it("(a - b) + b == a", () => {
      const a = 10n ** 18n;
      const b = 7n;
      const diff = (a - b) & UINT256_MAX;
      expect(toHex256(diff + b)).toBe(toHex256(a));
    });

    it("(a / d) * d + (a % d) == a with d near limit", () => {
      const a = UINT256_MAX;
      const d = (1n << 28n) - 1n;
      const q = a / d;
      const r = a % d;
      expect(q * d + r).toBe(a);
      expect(toHex256(q * d + r)).toBe(VECTORS.max);
    });
  });

  // -------------------------------------------------------------------------
  // 18. AddChecked: MAX + MAX
  // -------------------------------------------------------------------------
  describe("AddChecked: MAX + MAX", () => {
    it("max + max = max-1 with overflow", () => {
      const full = UINT256_MAX + UINT256_MAX;
      expect(full > UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.maxMinusOne);
    });
  });

  // -------------------------------------------------------------------------
  // 19. MulChecked: MAX * 2
  // -------------------------------------------------------------------------
  describe("MulChecked: MAX * 2", () => {
    it("max * 2 = max-1 with overflow", () => {
      const full = UINT256_MAX * 2n;
      expect(full > UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.maxMinusOne);
    });
  });

  // -------------------------------------------------------------------------
  // 20. MulChecked: 0 * large (no overflow)
  // -------------------------------------------------------------------------
  describe("MulChecked: 0 * large", () => {
    it("0 * max = 0, no overflow", () => {
      const full = 0n * UINT256_MAX;
      expect(full <= UINT256_MAX).toBe(true);
      expect(toHex256(full)).toBe(VECTORS.zero);
    });
  });

  // -------------------------------------------------------------------------
  // 21. SubChecked: general underflow (3 - 7)
  // -------------------------------------------------------------------------
  describe("SubChecked: general underflow", () => {
    it("3 - 7 = max-3 with underflow", () => {
      const result = toHex256(3n - 7n);
      expect(result).toBe(VECTORS.subThreeMinusSeven);
      // 3 < 7 => underflow, wrapped result = 2^256 - 4
      expect(result).toBe(VECTORS.subThreeMinusSeven);
    });
  });

  // -------------------------------------------------------------------------
  // 22. Zero dividend in short division
  // -------------------------------------------------------------------------
  describe("Zero dividend in short division", () => {
    it("0 / 7 = (0, remainder 0)", () => {
      const q = 0n / 7n;
      const r = 0n % 7n;
      expect(toHex256(q)).toBe(VECTORS.zero);
      expect(r).toBe(0n);
    });
  });

  // -------------------------------------------------------------------------
  // 23. Self-division in short division
  // -------------------------------------------------------------------------
  describe("Self-division in short division", () => {
    it("7 / 7 = (1, remainder 0)", () => {
      const q = 7n / 7n;
      const r = 7n % 7n;
      expect(toHex256(q)).toBe(VECTORS.one);
      expect(r).toBe(0n);
    });
  });

  // -------------------------------------------------------------------------
  // 24. Anti-symmetry of subtraction
  // -------------------------------------------------------------------------
  describe("Anti-symmetry of subtraction", () => {
    it("(pow128 - 1) + (1 - pow128) == 0 mod 2^256", () => {
      const a = 1n << 128n;
      const b = 1n;
      const aMinusB = (a - b) & UINT256_MAX;
      const bMinusA = (b - a) & UINT256_MAX;
      const sum = (aMinusB + bMinusA) & UINT256_MAX;
      expect(toHex256(sum)).toBe(VECTORS.zero);
      expect(toHex256(bMinusA)).toBe(VECTORS.oneMinusPow128);
    });
  });

  // -------------------------------------------------------------------------
  // 25. Double-complement
  // -------------------------------------------------------------------------
  describe("Double-complement", () => {
    it("max - (max - oneEth) == oneEth", () => {
      const x = 10n ** 18n;
      const inner = (UINT256_MAX - x) & UINT256_MAX;
      const result = (UINT256_MAX - inner) & UINT256_MAX;
      expect(toHex256(result)).toBe(VECTORS.oneEth);
    });

    it("max - (max - pow128) == pow128", () => {
      const x = 1n << 128n;
      const inner = (UINT256_MAX - x) & UINT256_MAX;
      const result = (UINT256_MAX - inner) & UINT256_MAX;
      expect(toHex256(result)).toBe(VECTORS.pow128);
    });
  });

  // -------------------------------------------------------------------------
  // 26. Remainder bound
  // -------------------------------------------------------------------------
  describe("Remainder bound", () => {
    const divCases: [string, bigint, bigint][] = [
      ["max / 2", UINT256_MAX, 2n],
      ["1e18 / 1e6", 10n ** 18n, 10n ** 6n],
      ["7 / 2", 7n, 2n],
      ["max / (2^28-1)", UINT256_MAX, (1n << 28n) - 1n],
      ["1e18 / 7", 10n ** 18n, 7n],
      ["max / 3", UINT256_MAX, 3n],
      ["0 / 7", 0n, 7n],
      ["7 / 7", 7n, 7n],
      ["max / 16", UINT256_MAX, 16n],
      ["max / 2^27", UINT256_MAX, 1n << 27n],
    ];

    for (const [label, x, d] of divCases) {
      it(`${label}: 0 <= r < d`, () => {
        const r = x % d;
        expect(r >= 0n).toBe(true);
        expect(r < d).toBe(true);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 27. Powers-of-2 divisors
  // -------------------------------------------------------------------------
  describe("Powers-of-2 divisors", () => {
    it("max / 16 = (quotient, remainder 15)", () => {
      const q = UINT256_MAX / 16n;
      const r = UINT256_MAX % 16n;
      expect(toHex256(q)).toBe(VECTORS.divMaxBy16Quotient);
      expect(r).toBe(15n);
      expect(q * 16n + r).toBe(UINT256_MAX);
    });

    it("max / 2^27 = (quotient, remainder 2^27-1)", () => {
      const d = 1n << 27n;
      const q = UINT256_MAX / d;
      const r = UINT256_MAX % d;
      expect(toHex256(q)).toBe(VECTORS.divMaxByPow27Quotient);
      expect(r).toBe(d - 1n);
      expect(q * d + r).toBe(UINT256_MAX);
    });
  });

  // -------------------------------------------------------------------------
  // 28. max * 2 wrapping (explicit wrapping mul)
  // -------------------------------------------------------------------------
  describe("max * 2 wrapping", () => {
    it("max * 2 = max-1 (carry at every position)", () => {
      const result = toHex256(UINT256_MAX * 2n);
      expect(result).toBe(VECTORS.maxMinusOne);
    });
  });

  // -------------------------------------------------------------------------
  // 29. Karatsuba identity
  // -------------------------------------------------------------------------
  describe("Karatsuba identity", () => {
    it("(2^128-1)^2 = 2^256 - 2^129 + 1 mod 2^256", () => {
      const p128m1 = (1n << 128n) - 1n;
      const result = toHex256(p128m1 * p128m1);
      expect(result).toBe(VECTORS.karatsubaResult);
      // Verify the algebraic identity
      const expected = toHex256(UINT256_MAX - (1n << 129n) + 2n);
      expect(result).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // 30. Random multi-limb addition vectors
  // -------------------------------------------------------------------------
  describe("Random multi-limb addition vectors", () => {
    it("randAdd: a + b mod 2^256", () => {
      const a = BigInt("0x" + VECTORS.randAddA);
      const b = BigInt("0x" + VECTORS.randAddB);
      expect(toHex256(a + b)).toBe(VECTORS.randAddResult);
    });

    it("randAdd2: a + b mod 2^256", () => {
      const a = BigInt("0x" + VECTORS.randAdd2A);
      const b = BigInt("0x" + VECTORS.randAdd2B);
      expect(toHex256(a + b)).toBe(VECTORS.randAdd2Result);
    });

    it("randAdd3: a + b mod 2^256", () => {
      const a = BigInt("0x" + VECTORS.randAdd3A);
      const b = BigInt("0x" + VECTORS.randAdd3B);
      expect(toHex256(a + b)).toBe(VECTORS.randAdd3Result);
    });
  });

  // -------------------------------------------------------------------------
  // 31. Asymmetric multiplication vectors
  // -------------------------------------------------------------------------
  describe("Asymmetric multiplication vectors", () => {
    it("large * 0xff (255)", () => {
      const a = BigInt("0x" + VECTORS.mulAsym1A);
      const b = BigInt("0x" + VECTORS.mulAsym1B);
      expect(toHex256(a * b)).toBe(VECTORS.mulAsym1Result);
    });

    it("upper-half-max * 3", () => {
      const a = BigInt("0x" + VECTORS.mulAsym2A);
      const b = BigInt("0x" + VECTORS.mulAsym2B);
      expect(toHex256(a * b)).toBe(VECTORS.mulAsym2Result);
    });

    it("alternating-a5 * 0x10001 (65537)", () => {
      const a = BigInt("0x" + VECTORS.mulAsym3A);
      const b = BigInt("0x" + VECTORS.mulAsym3B);
      expect(toHex256(a * b)).toBe(VECTORS.mulAsym3Result);
    });
  });

  // -------------------------------------------------------------------------
  // Frozen fuzz vectors (generated by generate-uint256-vectors.ts)
  // Seed: keccak256("uint256-fuzz-vectors-v1") -- deterministic, do not edit
  // -------------------------------------------------------------------------

  // prettier-ignore
  const FUZZ_VECTORS = [
    { a: "9c058ff97be1f628cc5322cd50f9a31d3c3ff4262d8dc15d16c6e9491fddf894", b: "20ae049a756ee7f9908caa142556c089c50ea57cadfd31222401770f0b1ae9d5", add: "bcb39493f150de225cdfcce1765063a7014e99a2db8af27f3ac860582af8e269", sub: "7b578b5f06730e2f3bc678b92ba2e29377314ea97f90903af2c5723a14c30ebf", mul: "e32643fd2c4bbaeeedccda02deea7fd93cb78a68f38ecffca8c1cabe25f68724", d: 158520680, divQ: "000000108342b4952007674ac92712a496ab655d4db9c2ea7fa011e60bc6d501", divR: 74160940 },
    { a: "ac5dd667b0fd08fcdaf4dedda8a4bc2b376c3d5624515df31cd7cdac201eba13", b: "41283e3483b2525062153592a0fefb24a36e88af0faa37afd71de468ffa42774", add: "ed86149c34af5b4d3d0a147049a3b74fdadac60533fb95a2f3f5b2151fc2e187", sub: "6b3598332d4ab6ac78dfa94b07a5c10693fdb4a714a7264345b9e943207a929f", mul: "271a591e7dcefd41912c4f87bacfb5bfd2286dc436939ff29bbd1da35d71359c", d: 104384748, divQ: "0000001bb41d9cb4a012e188944d5cb43ec97ad7c0b6a785f56e6d1e850b3100", divR: 59084307 },
    { a: "6d6916f1b93b517b93be4f9ee47375a46591308b7121917b768ff1b752aa84f6", b: "0b9a7c695fe38d30b7133ddd28a5e572c33221b346484a6a74bcb4d79dba914b", add: "7903935b191edeac4ad18d7c0d195b1728c3523eb769dbe5eb4ca68ef0651641", sub: "61ce9a885957c44adcab11c1bbcd9031a25f0ed82ad9471101d33cdfb4eff3ab", mul: "48090a785e099f85b655af38db08191f1fa7e7f51ed00391c053ec9146004a12", d: 254044429, divQ: "0000000739bbd50d7e7a834bccfb5b4d9f1b8141dc0b6c3967ed6fce1c61ec2a", divR: 200035540 },
    { a: "3c4ceb35527f10a3f489c0e5d1978d15f515711594259d690088adf49263e86f", b: "9432156d113eef05ebe687fba72c5ec5d034d25eb212303193e44114d2cee70f", add: "d07f00a263bdffa9e07048e178c3ebdbc54a43744637cd9a946cef096532cf7e", sub: "a81ad5c84140219e08a338ea2a6b2e5024e09eb6e2136d376ca46cdfbf950160", mul: "5cb8f8689666d40be651a0efd1dba9dc249465f3cf694249858bfa28d1e8c781", d: 130287913, divQ: "00000007c3d1231ac1393f5b0f81420892805478fd61747befb931342be82f2d", divR: 118998330 },
    { a: "ecf2ba008d1914841c4930476208de2b5650e7561d207ae111f5aacc68b8be93", b: "18ff11bce0b809427e92691622ee4805787fc36198375b06f8bbf12296c8605c", add: "05f1cbbd6dd11dc69adb995d84f72630ced0aab7b557d5e80ab19beeff811eef", sub: "d3f3a843ac610b419db6c7313f1a9625ddd123f484e91fda1939b9a9d1f05e37", mul: "4c366c5b3fdb5317d6c8ab1700971c3e739f908450f2d75f3ab6cb3feeb39cd4", d: 67901347, divQ: "0000003a8bb176c6098dbae229baf0ee4c1f0968f2875858f5ed4146ed275f1a", divR: 31709957 },
    { a: "f857290e941e6dd8e4ecdcbd118636b36a28bbdd00f7cb5e1f92ba48e9da2fc2", b: "ce1b8017d0228ec8654b29bcaf5c4f749b02f2a7c3f78aeab18e77cf18c45444", add: "c672a9266440fca14a380679c0e28628052bae84c4ef5648d1213218029e8406", sub: "2a3ba8f6c3fbdf107fa1b3006229e73ecf25c9353d0040736e044279d115db7e", mul: "20d22dd109c23ba1d695dc3387b9be2cd6b57feecb4d28332114b37e76285788", d: 231605330, divQ: "00000011fd4f334d37669782836d032260648f10a3e78378039ba98be2763761", divR: 168881840 },
    { a: "07a70702313919dcb81f7af8b67d5a9ab5dc2be38115dc9fae02765fde9c266a", b: "9b628335ea0c120326f1bf175d61e5da669aab6338e4c4d272b9b15a5a9ac4a2", add: "a3098a381b452bdfdf113a1013df40751c76d746b9faa17220bc27ba3936eb0c", sub: "6c4483cc472d07d9912dbbe1591b74c04f418080483117cd3b48c505840161c8", mul: "a986b0394c13a2ad294a1f623f5a90ded5d1b0fff50362e41a2de9cecbfd7714", d: 80635137, divQ: "00000001979a0e52d45e70857c8a43933548a38ec982e0cc26cdbd790492f5c6", divR: 29233828 },
    { a: "74a8106308ae61d7b537e019fbe39b776301ecfc8d77cc2a8925f3c98d39c15c", b: "826cd15010973565f11fb16e13ac3fea8c9c24f0ad88c5a2074a0e1cbb634a02", add: "f714e1b31945973da65791880f8fdb61ef9e11ed3b0091cc907001e6489d0b5e", sub: "f23b3f12f8172c71c4182eabe8375b8cd665c80bdfef068881dbe5acd1d6775a", mul: "9170ce04b868820f5c6895b0178eae31095e0cf18668e5b38f5b2609c6ec1ab8", d: 99745653, divQ: "000000139f227ce0c8868ab20032ec2afb436a4566b51871551ee60e48cecf11", divR: 41037719 },
    { a: "9c9ee64e5745a813ce13958c7c89ce5527382324175a18fd37b9d0d8cfda6e1f", b: "686d5942ce86255eccadb48882372cdb3a928cfe736b58fcf91337a3acf79e30", add: "050c3f9125cbcd729ac14a14fec0fb3061cab0228ac571fa30cd087c7cd20c4f", sub: "34318d0b88bf82b50165e103fa52a179eca59625a3eec0003ea6993522e2cfef", mul: "437dd503573acdd40526ddbf7c4c0caa74c7706ca8581403e79e0d69dcd4c7d0", d: 102863961, divQ: "000000198b84c66a9c26f3ecfe7e7451789ea33e70ca851b3f27a6274d8e2b82", divR: 8660461 },
    { a: "5e16e50de9ccf5d61729e4a4ff1b11658c0df6be9f689bdc79050f68d7c4459e", b: "5a28eb8b14b83866d66fb0db1e44b1749d0af22c7ef6762c5ae69c28cb22b5fd", add: "b83fd098fe852e3ced9995801d5fc2da2918e8eb1e5f1208d3ebab91a2e6fb9b", sub: "03edf982d514bd6f40ba33c9e0d65ff0ef030492207225b01e1e73400ca18fa1", mul: "4e362dd737abd581ebd73fe40c95e9aa3190343df1b5f22dc5f5cf208b2d8326", d: 207102323, divQ: "000000079f433fa6d61aeb755d536f2cd2e7758bfbe0ae0e812dbf50ac4a8747", divR: 40982969 },
    { a: "a5e4e348e567aab7e774468e46da12da21656120bf668492caa898887bd68f9f", b: "89c5fbb4cf92395b9a7818bafec3c9deff29c4201b6b5f4030d77503171b9210", add: "2faadefdb4f9e41381ec5f49459ddcb9208f2540dad1e3d2fb800d8b92f221af", sub: "1c1ee79415d5715c4cfc2dd3481648fb223b9d00a3fb255299d1238564bafd8f", mul: "1ef5d46d4aa303ece72617b569ece48d908e753e1aa1d5501cbd0f8d8a16a7f0", d: 55590016, divQ: "0000003211396c531c6291b1842c52a83f30470299bd85dfc6fbc9bf3d40c5a3", divR: 20023839 },
    { a: "44132646fc108d6be5f1334ec610772457b0b3825443b3d9b6ed90032dd548c1", b: "f74fd91f9c2ef4a195fa3840410bf3ab4ab54c80f6232b967f5dae370aa62de7", add: "3b62ff66983f820d7beb6b8f071c6acfa26600034a66df70364b3e3a387b76a8", sub: "4cc34d275fe198ca4ff6fb0e850483790cfb67015e208843378fe1cc232f1ada", mul: "f183cbf1cced5c34a21afec193310dfe6ffde853d06b0fc651ea5e8890649327", d: 181575059, divQ: "000000064a3ceaa6a5c36136e8aedd0efac3890125171d488d408f6f5abf291c", divR: 81953197 },
    { a: "71355ac2ee31435d6c375597a2bdcba6609086a7ef7375f7d24d4055368d5431", b: "e2efc516c8410cd4b1436782a4327ebcaa0597d1ee271bc565bac54f8654cc00", add: "54251fd9b67250321d7abd1a46f04a630a961e79dd9a91bd380805a4bce22031", sub: "8e4595ac25f03688baf3ee14fe8b4ce9b68aeed6014c5a326c927b05b0388831", mul: "23ed98e70133f4a02fd2888aa164a73d921d0c666848b37d5dc87808e52b0c00", d: 215202269, divQ: "00000008d3648adc5e351b312e93cde88e3ab9ad29e1a8b865062495aeb55d5d", divR: 64783848 },
    { a: "bf8d30492cbc3e6c43a0813cd30e5e2ff3ef874b567165571dfcba7c7a2587a8", b: "63d1d5b8bda73236ea1b7993d9238c90d12ae8e99ca60ce113db8b1e5fba6638", add: "235f0601ea6370a32dbbfad0ac31eac0c51a7034f317723831d8459ad9dfede0", sub: "5bbb5a906f150c35598507a8f9ead19f22c49e61b9cb58760a212f5e1a6b2170", mul: "ec22da77cf6820702c5f87f1eb0af61a7ddb9e7d0350469227212e3194529cc0", d: 201188733, divQ: "0000000ff93b8510fc9614138d27d2faa6d741a4561f9d7ccc9ad96fd9411b9f", divR: 109236229 },
    { a: "63d9f0af55959c75490bc291a539d84799dbfedefeea31bee4eda20f0883d45b", b: "25639f6878c67128697734d42c887da215da8a5d13538e678f116f0a3a09ede3", add: "893d9017ce5c0d9db282f765d1c255e9afb6893c123dc02673ff1119428dc23e", sub: "3e765146dccf2b4cdf948dbd78b15aa584017481eb96a35755dc3304ce79e678", mul: "efc90708301e66e3d2bffa58408c542b0dc2689723efb18b85788983adb08bb1", d: 53348067, divQ: "0000001f66decc63c4e2dec8dabbdc8d5bd2545d35c7b14242d1968f451e00a4", divR: 23948015 },
    { a: "4b163d1cf8bf1a60a9b697133b1b59beab6f44e40e01cbb5d22044ac54c23a91", b: "62daa68f93845e8ae03eccbb4851e0bdec9f50d8c8c8d2cbafeb7802f771c6bf", add: "adf0e3ac8c4378eb89f563ce836d3a7c980e95bcd6ca9e81820bbcaf4c340150", sub: "e83b968d653abbd5c977ca57f2c97900becff40b4538f8ea2234cca95d5073d2", mul: "6be938bb783bb0d520b4d95afa96a5a94a8af9d45fcfc810e81cc3813736d82f", d: 127142639, divQ: "00000009e87cac14cd041585d06601473c1735ed378268cb1b2fe7a99d1436e1", divR: 61486210 },
    { a: "3b9887918f16035b491da1e20962ca58a97f15d6a32469bc2cc1b63bc5a69e0c", b: "7e27c0019e6c85db934dbf42002761a7a78441295b63fc0f8e52947ee07d7f8c", add: "b9c047932d828936dc6b6124098a2c00510356fffe8865cbbb144abaa6241d98", sub: "bd70c78ff0a97d7fb5cfe2a0093b68b101fad4ad47c06dac9e6f21bce5291e80", mul: "65e647478d1cde9bb6f76a781bc81b611d2618d616de9493beb1564b6b626290", d: 253044528, divQ: "00000003f387a3da519f53ebf0ae3ee160624a1a3ddfe0096ae158c4a81686ea", divR: 195931180 },
    { a: "b7b6d9bf46a2e4e813b9fdcbb2319196304d3f7bc8765d5d0d197d1c8c8879d2", b: "1c70af50653dbdf04c44107f914cfc5c43cb03086541745fc27c294f0c45a4f3", add: "d427890fabe0a2d85ffe0e4b437e8df2741842842db7d1bccf95a66b98ce1ec5", sub: "9b462a6ee16526f7c775ed4c20e49539ec823c736334e8fd4a9d53cd8042d4df", mul: "65440a9645ff6c7d12cda044ccf35a19cc4aabb7c540ff1f31f88c6d81302a56", d: 62058811, divQ: "00000031aa7ff1880e61b1bc9652c2116f115257e48a4de99aa7388de3485fce", divR: 23951192 },
    { a: "c7e22e2da0d099aa13511d95af8cdbd2387837c4b602bb80d97f740f498066a1", b: "4e32353972e557c3ac359c5d49c6f9bb9bc79d86aa2e02947ab4255967a42e1d", add: "1614636713b5f16dbf86b9f2f953d58dd43fd54b6030be1554339968b12494be", sub: "79aff8f42deb41e6671b813865c5e2169cb09a3e0bd4b8ec5ecb4eb5e1dc3884", mul: "937f47b50d58d8875c3364956bcd032f01a2fd3ed8e1073b0a559775ec208e3d", d: 157046891, divQ: "000000155a7a086d144181eed3bc4214a30f8200759b42e78b8ed32b9d82a335", divR: 130021242 },
    { a: "e4842a0e27c064a471141bbf43201b00df4948824805e3a0af29fc072e0a3419", b: "5b9956f82030b484863bb3497651328f71a1f36357390006f43fc137e71fee4d", add: "401d810647f11928f74fcf08b9714d9050eb3be59f3ee3a7a369bd3f152a2266", sub: "88ead316078fb01fead86875cccee8716da7551ef0cce399baea3acf46ea45cc", mul: "7d4734ba4c3fb57a630e4a034aff8f77a9f0a3320563c8aef2f84d943387e985", d: 212951332, divQ: "0000001200e4982ecc7d53c5e812d48b75bf36d4518f9ee0ed093bb6bdaee0f9", divR: 101398549 },
    { a: "afffab634fdfd362098b876a491b66e445397166fdc02f50f944e75dbb7722f2", b: "0ffaf3bd9bd1bff893b9271419227a4dc026dc4b7bbcf3191a9afb3b4a87e9ad", add: "bffa9f20ebb1935a9d44ae7e623de13205604db2797d226a13dfe29905ff0c9f", sub: "a004b7a5b40e136975d260562ff8ec968512951b82033c37dea9ec2270ef3945", mul: "771d939f840aa0126144c344b8c6aed0eb83abddcb5f4310e20f49aa7feedf8a", d: 174322955, divQ: "00000010f041273eeb19c57d64e6d1e3571cc3587b5dba9557276ca5f136d195", divR: 149522571 },
    { a: "c187196682222a9e068fb58ca7d71b85195572f26b8a85a1989f6a4a32561e79", b: "10a29c777df4efadad8697c0c66f649e1d020f67264e0ef13ac1e5ee021fbacd", add: "d229b5de00171a4bb4164d4d6e4680233657825991d89492d36150383475d946", sub: "b0e47cef042d3af059091dcbe167b6e6fc53638b453c76b05ddd845c303663ac", mul: "3c6e573083fcf7be96983635a4bacaf27935d826fc03192cb6ce5c2583c150e5", d: 1270667, divQ: "000009fb3cead27c68a9a9925ec26c06ba9d9f38468849041ec3559a61763d56", divR: 560839 },
    { a: "bce82ae8606feee737bb904d5b8c8831df74cb2f058bd95e3ed587c5e5806648", b: "4a3d334748823327aada469a0944ea16cfef8e1830f12484c5da50230736c679", add: "07255e2fa8f2220ee295d6e764d17248af645947367cfde304afd7e8ecb72cc1", sub: "72aaf7a117edbbbf8ce149b352479e1b0f853d16d49ab4d978fb37a2de499fcf", mul: "4009937dce7df89e68789b4309a7cca4fa98e2e99ef13cd8e8c9a3c453fc0808", d: 101669670, divQ: "0000001f2c3efa20b5c12fcb5bcce9b31820afbab3241cd147a9d02cab1eeaca", divR: 60669516 },
    { a: "6bbe5c5f91e1a0f35dfc6535a40f046cc52dfcbb6e1fec186b9eb06bf8b17807", b: "60b16a7d9843cbf638bf77d425898a3aa2aa1462124305daf74dbd2db050a8f0", add: "cc6fc6dd2a256ce996bbdd09c9988ea767d8111d8062f1f362ec6d99a90220f7", sub: "0b0cf1e1f99dd4fd253ced617e857a322283e8595bdce63d7450f33e4860cf17", mul: "4f85133b4417e83df21b1f3188d9bb2115a2b657395b3321fd2e3ea2ef551e90", d: 252623140, divQ: "0000000727ccf5b1da1bb8703e874191615c5f133a91622f24ab5f7ada808c2d", divR: 198917299 },
    { a: "3ae3e4235c3f8bc0bbeef62e901c9b6cd64a2e3c11520ecab85ba5fe66752510", b: "b0cce47da58cd02fe64d4f75de020e6319297dc120ea84c549b323cb379e0398", add: "ebb0c8a101cc5bf0a23c45a46e1ea9cfef73abfd323c9390020ec9c99e1328a8", sub: "8a16ffa5b6b2bb90d5a1a6b8b21a8d09bd20b07af0678a056ea882332ed72178", mul: "84e471895ac8e09f284e8b239891706a3e39ec6f61f7db486188853384dd3180", d: 84406297, divQ: "0000000bb4984df61c7c1fbe5e8f9a4bdf42c6cc8f69fb5dc012cf87d96a65ed", divR: 17301739 },
    { a: "17e8b8e7a082be4b8b1b895e40037e42037b2307b597435bcdf0099fadd38d1a", b: "1af07fd0224cbd362efeda76fe79ba0b2882095c038f7b46193244dc3d36651b", add: "32d938b7c2cf7b81ba1a63d53e7d384d2bfd2c63b926bea1e7224e7beb09f235", sub: "fcf839177e3601155c1caee74189c436daf919abb207c815b4bdc4c3709d27ff", mul: "e5c19201ff3efec0172e6d8bc4778df90a4f922e6c2154762c934102c17723be", d: 127750059, divQ: "0000000323d32d62920fcfcecc7fd1caca1e22a33916a486db0ecce4c990b1c4", divR: 35476270 },
    { a: "c756ccc21371dd5f4ebfc3b35147d53287ec55d354550779f3e6a8429e781e20", b: "6fc9daa0ab7cbc5d9c8d1ebd22c0a6f74c08595640d7994bcee0c762b52a3edb", add: "3720a762beee99bceb4ce27074087c29d3f4af29952ca0c5c2c76fa553a25cfb", sub: "578cf22167f52101b232a4f62e872e3b3be3fc7d137d6e2e2505e0dfe94ddf45", mul: "dc447129c23513e54621d8bb9dc10dcbc81fb65634fa7e9c5d7168a0394d8560", d: 3295678, divQ: "000003f6c5117a037c7c59612274a64e3de8d2e652962f26010503ebd4790c52", divR: 1677124 },
    { a: "ee0823d16bac0b58c0329362551b4d64b632a5f1c144797c98fb58243f40b026", b: "12066e5cf36e06dc9e08e7bc6199b7554d849b3870e5cb29a57fc8982f347187", add: "000e922e5f1a12355e3b7b1eb6b504ba03b7412a322a44a63e7b20bc6e7521ad", sub: "dc01b574783e047c2229aba5f381960f68ae0ab9505eae52f37b8f8c100c3e9f", mul: "f7f24749a916a1f7e76ed954628b01ef202bb3369a025a1e264d7b13aa95aa0a", d: 68067409, divQ: "0000003aab813fb8f576f9c42e1a8300b3669bd2f38b964ef5c7fd00248d2226", divR: 53289504 },
    { a: "ae369761304a1b8675a8729952534f606e5ca71dbe1a12c1c4407b29be6d5f7a", b: "78fcee88cfd50e8357266348e95c460acfa8c8d737ad358cf0da0153d68f7be8", add: "273385ea001f2a09ccced5e23baf956b3e056ff4f5c7484eb51a7c7d94fcdb62", sub: "3539a8d860750d031e820f5068f709559eb3de46866cdd34d36679d5e7dde392", mul: "67ebf43276e80289ac00061c0f38633faab2d0a3ac6ae3835fd6e7c971242490", d: 53006233, divQ: "0000003724145b4cc4957219b04fbd9d4229c98952bec6a9a57058ba696a9e44", divR: 18599126 },
    { a: "0d065430790e2e069c896e8dfe07a222fddc3437c652d73aaa287d678e7ed790", b: "d7e09a0b5fafd9b3e06b0d81f28eb3848b2dd39809b3a6d5c97966ca4f41edfe", add: "e4e6ee3bd8be07ba7cf47c0ff09655a7890a07cfd0067e1073a1e431ddc0c58e", sub: "3525ba25195e5452bc1e610c0b78ee9e72ae609fbc9f3064e0af169d3f3ce992", mul: "eeceab12610fe92a13b9f3616b01f853e25c0c69cb99713809931604fafa30e0", d: 103583608, divQ: "000000021c0ddba3766d3ee0c324f902da2326bdb09f0cfc086ba5af55dac6a8", divR: 102359248 },
    { a: "1a74ff3b3d39310a3ace77f0860aefc67f0de7015675982e3688163f6bd53e48", b: "b73b5c0a16d8b9ec0eb774dae62b962901495ed820195e044e65dadeb0e68ac5", add: "d1b05b455411eaf64985eccb6c3685ef805745d9768ef63284edf11e1cbbc90d", sub: "6339a3312660771e2c1703159fdf599d7dc48829365c3a29e8223b60baeeb383", mul: "b956030c88091fe6ec9801d39b481d9936931ed6c39acc9386321dc6635bbd68", d: 173545696, divQ: "000000028ec468c9d11241e49b65725f6079be2184adc0492056591e6aa8c31e", divR: 126858248 },
    { a: "c96e799460aed2274e79145301f8eb6bd82bc10e460269e8ec65e59b7019f25e", b: "cf1f0950f9fd73fce9258acec4e74c4cee83445e379f876d3cddee1e301cadfc", add: "988d82e55aac4624379e9f21c6e037b8c6af056c7da1f1562943d3b9a036a05a", sub: "fa4f704366b15e2a655389843d119f1ee9a87cb00e62e27baf87f77d3ffd4462", mul: "f78d4b352886edf4981eee4191c3f3b57b8d9b5606daa8e55800fb10049c1a88", d: 125555856, divQ: "0000001aea7e7ef5c2395be9d23f3094f287ed21bb9ce7606742766a4526b59a", divR: 82985918 },
    { a: "4ca80339f808f17f02ca69f55a35268a9fcde1d5ca40a4a0972bf87a2d7882f4", b: "f7769261e9ac53ce0989a90849c791cb7f6239d2782e4df132507c154029d3e7", add: "441e959be1b5454d0c5412fda3fcb8561f301ba8426ef291c97c748f6da256db", sub: "553170d80e5c9db0f940c0ed106d94bf206ba803521256af64db7c64ed4eaf0d", mul: "e80bda2bae60564c7bd92ec61eb0560bfd4abdae773d18a7abfa40c754c1462c", d: 170652439, divQ: "0000000789479efe9774a07975660bfe18f7efc6a7f4bebc1007b8c742e62443", divR: 18786287 },
    { a: "cc67626f006e9d2ba92e0d51045d68426ebc14a83b7e42ad7653d61060d76c27", b: "98e4e1d57b16cf351eae50dddda9a9d9eeec4df8dfefbece3fd7bbd720084652", add: "654c44447b856c60c7dc5e2ee207121c5da862a11b6e017bb62b91e780dfb279", sub: "338280998557cdf68a7fbc7326b3be687fcfc6af5b8e83df367c1a3940cf25d5", mul: "6c7ac0e5842308081c0a204c59e8f98c944af3cd874707b5aeae51bb2dcb4e7e", d: 238459900, divQ: "0000000e619303719e6df19594aa5db272fdad14c64e8a7295a52c8db46fe891", divR: 71873131 },
    { a: "ad28c0033cd8dab71977dc8ff894e09138b5c9d53ac65bc0c6020135d34159ca", b: "51f5ca9dd3293db242d6c640296708cf30586dce409c76e47e22312f8c77d28c", add: "ff1e8aa1100218695c4ea2d021fbe960690e37a37b62d2a5442432655fb92c56", sub: "5b32f56569af9d04d6a1164fcf2dd7c2085d5c06fa29e4dc47dfd00646c9873e", mul: "414be94616ab3a87c24c541ec17f6f196b7e567dcf0c468a91a6e74c584ace78", d: 42014556, divQ: "00000045255165a586c55709e053d0011b9140018075b782309bfeead9c6fcad", divR: 31326366 },
    { a: "24cd6e0611e4d4f0268873fcad306f785fa5bee30939fbee678788fe0d1ff09f", b: "1337317824d4b0d56a0708d23c429e3928facd3c58c966c5ca4481e2c8335349", add: "38049f7e36b985c5908f7ccee9730db188a08c1f620362b431cc0ae0d55343e8", sub: "11963c8ded10241abc816b2a70edd13f36aaf1a6b07095289d43071b44ec9d56", mul: "2ad0daa6128157a7cf42e1d651c14837da0dd09fd367cf2c4a9c8b6a40cc2a57", d: 48638605, divQ: "0000000cb1cad2117fbe90be0ae2db3e3230fc194ac7a7b563a8997afe36b315", divR: 12573710 },
    { a: "7b83d18a647f270858b5cb8a0a5ad1991f4e6c01499f4835047da027c16e82bc", b: "4d895cd621006a6c443f6e9ff27aa50bbedf69f5579094eec0f6128f339b6edc", add: "c90d2e60857f91749cf53a29fcd576a4de2dd5f6a12fdd23c573b2b6f509f198", sub: "2dfa74b4437ebc9c14765cea17e02c8d606f020bf20eb34643878d988dd313e0", mul: "fd6aa47aad3116bcfb952c16a6cd02e2fc3ebda232afd34b2cf6184052f92190", d: 4897629, divQ: "000001a71c31425020f88654134f310cfe4c865ea0d01e97141a6cab48c0fdc1", divR: 2906271 },
    { a: "e9a17fd6ccb161d5ae82bb72f1aeeb011033291864af6d54ec9ac7142b6f504d", b: "6ec17fa9e9f055c37f63c9b5c41c63243aa76684e0d2b202e75a7745e66a7174", add: "5862ff80b6a1b7992de68528b5cb4e254ada8f9d45821f57d3f53e5a11d9c1c1", sub: "7ae0002ce2c10c122f1ef1bd2d9287dcd58bc29383dcbb5205404fce4504ded9", mul: "1163b6597219071087ef98d858a5781f9b252bec84e5f7b03ec88a4d3ec45fe4", d: 214642472, divQ: "0000001242ec1f303c3d896ac0584987f6e40cb626480a412816e3091834139b", divR: 63556373 },
    { a: "6c86c9080d186d1b4ccae6f0496bfeb4ef988fcc37c64379cc7c9598537974ce", b: "54754f2671a07b7833b5c5562a64323f998cb359c34b9eb413d8dc304173f150", add: "c0fc182e7eb8e8938080ac4673d030f489254325fb11e22de05571c894ed661e", sub: "181179e19b77f1a31915219a1f07cc75560bdc72747aa4c5b8a3b9681205837e", mul: "132e5e15c241a617e9a7ca945b0bb13439be811b0897e8cdef596b0733746e60", d: 151384155, divQ: "0000000c070a1b484781fb5894832f2d2fc51cbbc4f0db753c766c3dbed52cdc", divR: 123224730 },
    { a: "09408798fb6da97b04e1ac3e9a226f84fd1990ecba74c5f1e2748649478f624a", b: "f8fd509974fc0c48caa58c5b73c839838c81707a0fd7ab43527fe49d430dad2f", add: "023dd8327069b5c3cf87389a0deaa908899b0166ca4c713534f46ae68a9d0f79", sub: "104336ff86719d323a3c1fe3265a360170982072aa9d1aae8ff4a1ac0481b51b", mul: "abc53173162792bcc66499412f3433aa1872ea79a46c00295ec6853364810d96", d: 153438422, divQ: "0000000102faa1d874f4428c68d28d0aa85b1f04118d05d6c3e885ede467cc4a", divR: 111397998 },
    { a: "a165a63de5725aee491abe18f851e2b4cf3c18358cd947bb31733d1425c1208f", b: "76ec9b75b81b176299de47b565e17671b90e1d42b282a9f76b8cab631d64dac7", add: "185241b39d8d7250e2f905ce5e335926884a35783f5bf1b29cffe8774325fb56", sub: "2a790ac82d57438baf3c766392706c43162dfaf2da569dc3c5e691b1085c45c8", mul: "af0d5a34b461acd0c59081060bc4e6c46879527b8c51ccc3e4605f3db9b61529", d: 71138208, divQ: "000000261057e9b089e78a76a5ea58a3927f31d10020af0416dec6a20aac6614", divR: 36812815 },
    { a: "4a53c69bde6f79a9e532c9d671f632f40b3aab2b9b0a8a2828ddc10bf6348e95", b: "f91e5feb55c0dc5c324c6ca43fec187af4586ba7ad772c383c4988aa4bfc7e8e", add: "4372268734305606177f367ab1e24b6eff9316d34881b660652749b642310d23", sub: "513566b088ae9d4db2e65d32320a1a7916e23f83ed935defec943861aa381007", mul: "37df3539708128843ae6ecec430fb088384a5c1f9b8b77f9580f904471006ca6", d: 24680060, divQ: "0000003286dbfe65524ddcdf5d39e2f9d2fac6118052b9db4830c73989385b8e", divR: 11731405 },
    { a: "252e77cab0956288196c0028ec3270a5041a8f3e84078cce9972f9c813734035", b: "45065911acc8b292d4f6e0939e1390e830df5fb6bd6aa80fb8b4d704ef2385f0", add: "6a34d0dc5d5e151aee62e0bc8a46018d34f9eef5417234de5227d0cd0296c625", sub: "e0281eb903ccaff544751f954e1edfbcd33b2f87c69ce4bee0be22c3244fba45", mul: "241cf5f04a3e03fa96ee80de6e5053518ad98174b5cda712de0fe3345ea6bab0", d: 43051475, divQ: "0000000e7d5c003f094a954a906c9643e050fd6e5146c4ba66258b05104e591a", divR: 19342791 },
    { a: "6bbd6a51bef0bb0a59e08f12aedfda711e38708812738885094d7c7f150fc2d7", b: "b2df8d2af6176639252d93cca46795a4617b3d9750d7fae5bd9405d0eaf02696", add: "1e9cf77cb50821437f0e22df534770157fb3ae1f634b836ac6e1824fffffe96d", sub: "b8dddd26c8d954d134b2fb460a7844ccbcbd32f0c19b8d9f4bb976ae2a1f9c41", mul: "c773ac5e8a596fe3c689365353529638dfc061bd7987fcb89f2e7825ddb813fa", d: 53412814, divQ: "00000021d773c4f3e60ce7865ec2b276241466fad8ef650cc315a98e91dd77b6", divR: 543843 },
    { a: "97e1351e88f5e492998ffbff51a1c7539cb543795edf97cca5eb91484b4f83ad", b: "17bbaf9d56f9d9d5c527a86a0849493840a77b4e800316c039954459355738f4", add: "af9ce4bbdfefbe685eb7a46959eb108bdd5cbec7dee2ae8cdf80d5a180a6bca1", sub: "8025858131fc0abcd468539549587e1b5c0dc82adedc810c6c564cef15f84ab9", mul: "ec6518a47bb9655b290a6826544d10de32899ab290877af879c712cebd6258e4", d: 153508721, divQ: "000000109963d3e0792d3089c499b86442de79a958cc5082bd7ea8a91b37f634", divR: 56580793 },
    { a: "7c33e3bd89806769628ba3e83299768466947d04ae4d215a4206c25286d17674", b: "0f04e8fa52c2b3259a60e0708adec4aa13978d55f06dd2e8197de15fec591e0a", add: "8b38ccb7dc431a8efcec8458bd783b2e7a2c0a5a9ebaf4425b84a3b2732a947e", sub: "6d2efac336bdb443c82ac377a7bab1da52fcefaebddf4e722888e0f29a78586a", mul: "475bd9615b2cac4b4fbfe2f5e2b212f5db7d891b39507fd74d7e2416ee643888", d: 53311952, divQ: "0000002716222be53b5239187ba5cefe1fdb2756e23b0a108e0d76dc63821df8", divR: 5694708 },
    { a: "6c5f8ad5b1d64594e4f60a775f5043db3f9f569a9e6f3b287fde7e776ec71f6a", b: "20f519ba80da0dc281ca96278c67c6a2e163794ec49d4cc8f2eba7c79939f45f", add: "8d54a49032b0535766c0a09eebb80a7e2102cfe9630c87f172ca263f080113c9", sub: "4b6a711b30fc37d2632b744fd2e87d385e3bdd4bd9d1ee5f8cf2d6afd58d2b0b", mul: "5c7202965d53d31cebbc79a7e2a206229cd6b2dbcdcf276e1a7d016a3e6fb056", d: 163096354, divQ: "0000000b25e4630dac5e1406bac062aea69bc75b5b9a4fb895bbfbc7942721c5", divR: 133505088 },
    { a: "7d67edf62adaf3be7e9d765aeff3e64c129fef9f5ba02112f0a77922b254ce61", b: "2e751f3486ab618cb6486883fb2c5575c9b10ef549d6bf9800d947ca6b3ba18b", add: "abdd0d2ab186554b34e5dedeeb203bc1dc50fe94a576e0aaf180c0ed1d906fec", sub: "4ef2cec1a42f9231c8550dd6f4c790d648eee0aa11c9617aefce315847192cd6", mul: "f14848c8312f0f19b944ff9a5964e8396d5499c15a449c2d9606e35645320fab", d: 89706718, divQ: "00000017742c052d005b072745ddda97326e72a37ff0a239d9e864e4e4add16f", divR: 4653087 },
    { a: "00682e071204cadf1030eab0c23f592ba730a7bba8bffc221773e87c747d5c3d", b: "45f63c4aa7022e0a4ee88959c9999ae32b6d570419decff8bdb003be78273f0f", add: "465e6a51b906f8e95f19740a8bd8f40ed29dfebfc29ecc1ad523ec3aeca49b4c", sub: "ba71f1bc6b029cd4c1486156f8a5be487bc350b78ee12c2959c3e4bdfc561d2e", mul: "bcb923212e1184a509ee2b7e9a8c3bd470de394b2ab9648407a0ee9152566a93", d: 9262573, divQ: "00000000bcb32efd55a6da8a463c9091919161597783218c2fe594033621a926", divR: 3941903 },
    { a: "0e62334c95b52eba15cd515c4578b38148b14ab4411293d380714198aab9e9ba", b: "9e59d30104645a90cf7267a95eb4ed7aead6b97f91766ecf09006f0fbbf44455", add: "acbc064d9a19894ae53fb905a42da0fc33880433d28902a28971b0a866ae2e0f", sub: "7008604b9150d429465ae9b2e6c3c6065dda9134af9c25047770d288eec5a565", mul: "e7601352ac6123bfffeb3280b7f3c9221433a05ef36ae6caec7c33ddb51802c2", d: 196657157, divQ: "000000013a22c9c231a12b8a5343013a637d2998ebedb8182e11229fc1840a24", divR: 95074054 },
  ] as const;

  // prettier-ignore
  const BOUNDARY_VECTORS = [
    { label: "l0(0,0)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "0000000000000000000000000000000000000000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l0(0,1)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000001", add: "0000000000000000000000000000000000000000000000000000000000000001", sub: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l0(0,B-2)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "000000000000000000000000000000000000000000000000000000000ffffffe", add: "000000000000000000000000000000000000000000000000000000000ffffffe", sub: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000002", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l0(0,B-1)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "000000000000000000000000000000000000000000000000000000000fffffff", add: "000000000000000000000000000000000000000000000000000000000fffffff", sub: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000001", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l0(1,0)", a: "0000000000000000000000000000000000000000000000000000000000000001", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "0000000000000000000000000000000000000000000000000000000000000001", sub: "0000000000000000000000000000000000000000000000000000000000000001", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l0(1,1)", a: "0000000000000000000000000000000000000000000000000000000000000001", b: "0000000000000000000000000000000000000000000000000000000000000001", add: "0000000000000000000000000000000000000000000000000000000000000002", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000001" },
    { label: "l0(1,B-2)", a: "0000000000000000000000000000000000000000000000000000000000000001", b: "000000000000000000000000000000000000000000000000000000000ffffffe", add: "000000000000000000000000000000000000000000000000000000000fffffff", sub: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000003", mul: "000000000000000000000000000000000000000000000000000000000ffffffe" },
    { label: "l0(1,B-1)", a: "0000000000000000000000000000000000000000000000000000000000000001", b: "000000000000000000000000000000000000000000000000000000000fffffff", add: "0000000000000000000000000000000000000000000000000000000010000000", sub: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000002", mul: "000000000000000000000000000000000000000000000000000000000fffffff" },
    { label: "l0(B-2,0)", a: "000000000000000000000000000000000000000000000000000000000ffffffe", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "000000000000000000000000000000000000000000000000000000000ffffffe", sub: "000000000000000000000000000000000000000000000000000000000ffffffe", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l0(B-2,1)", a: "000000000000000000000000000000000000000000000000000000000ffffffe", b: "0000000000000000000000000000000000000000000000000000000000000001", add: "000000000000000000000000000000000000000000000000000000000fffffff", sub: "000000000000000000000000000000000000000000000000000000000ffffffd", mul: "000000000000000000000000000000000000000000000000000000000ffffffe" },
    { label: "l0(B-2,B-2)", a: "000000000000000000000000000000000000000000000000000000000ffffffe", b: "000000000000000000000000000000000000000000000000000000000ffffffe", add: "000000000000000000000000000000000000000000000000000000001ffffffc", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "00000000000000000000000000000000000000000000000000ffffffc0000004" },
    { label: "l0(B-2,B-1)", a: "000000000000000000000000000000000000000000000000000000000ffffffe", b: "000000000000000000000000000000000000000000000000000000000fffffff", add: "000000000000000000000000000000000000000000000000000000001ffffffd", sub: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", mul: "00000000000000000000000000000000000000000000000000ffffffd0000002" },
    { label: "l0(B-1,0)", a: "000000000000000000000000000000000000000000000000000000000fffffff", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "000000000000000000000000000000000000000000000000000000000fffffff", sub: "000000000000000000000000000000000000000000000000000000000fffffff", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l0(B-1,1)", a: "000000000000000000000000000000000000000000000000000000000fffffff", b: "0000000000000000000000000000000000000000000000000000000000000001", add: "0000000000000000000000000000000000000000000000000000000010000000", sub: "000000000000000000000000000000000000000000000000000000000ffffffe", mul: "000000000000000000000000000000000000000000000000000000000fffffff" },
    { label: "l0(B-1,B-2)", a: "000000000000000000000000000000000000000000000000000000000fffffff", b: "000000000000000000000000000000000000000000000000000000000ffffffe", add: "000000000000000000000000000000000000000000000000000000001ffffffd", sub: "0000000000000000000000000000000000000000000000000000000000000001", mul: "00000000000000000000000000000000000000000000000000ffffffd0000002" },
    { label: "l0(B-1,B-1)", a: "000000000000000000000000000000000000000000000000000000000fffffff", b: "000000000000000000000000000000000000000000000000000000000fffffff", add: "000000000000000000000000000000000000000000000000000000001ffffffe", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "00000000000000000000000000000000000000000000000000ffffffe0000001" },
    { label: "l4(0,0)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "0000000000000000000000000000000000000000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l4(0,1)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000010000000000000000000000000000", add: "0000000000000000000000000000000000010000000000000000000000000000", sub: "ffffffffffffffffffffffffffffffffffff0000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l4(0,B-2)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "00000000000000000000000000000ffffffe0000000000000000000000000000", add: "00000000000000000000000000000ffffffe0000000000000000000000000000", sub: "fffffffffffffffffffffffffffff00000020000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l4(0,B-1)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "00000000000000000000000000000fffffff0000000000000000000000000000", add: "00000000000000000000000000000fffffff0000000000000000000000000000", sub: "fffffffffffffffffffffffffffff00000010000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l4(1,0)", a: "0000000000000000000000000000000000010000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "0000000000000000000000000000000000010000000000000000000000000000", sub: "0000000000000000000000000000000000010000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l4(1,1)", a: "0000000000000000000000000000000000010000000000000000000000000000", b: "0000000000000000000000000000000000010000000000000000000000000000", add: "0000000000000000000000000000000000020000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000100000000000000000000000000000000000000000000000000000000" },
    { label: "l4(1,B-2)", a: "0000000000000000000000000000000000010000000000000000000000000000", b: "00000000000000000000000000000ffffffe0000000000000000000000000000", add: "00000000000000000000000000000fffffff0000000000000000000000000000", sub: "fffffffffffffffffffffffffffff00000030000000000000000000000000000", mul: "0ffffffe00000000000000000000000000000000000000000000000000000000" },
    { label: "l4(1,B-1)", a: "0000000000000000000000000000000000010000000000000000000000000000", b: "00000000000000000000000000000fffffff0000000000000000000000000000", add: "0000000000000000000000000000100000000000000000000000000000000000", sub: "fffffffffffffffffffffffffffff00000020000000000000000000000000000", mul: "0fffffff00000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-2,0)", a: "00000000000000000000000000000ffffffe0000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "00000000000000000000000000000ffffffe0000000000000000000000000000", sub: "00000000000000000000000000000ffffffe0000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-2,1)", a: "00000000000000000000000000000ffffffe0000000000000000000000000000", b: "0000000000000000000000000000000000010000000000000000000000000000", add: "00000000000000000000000000000fffffff0000000000000000000000000000", sub: "00000000000000000000000000000ffffffd0000000000000000000000000000", mul: "0ffffffe00000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-2,B-2)", a: "00000000000000000000000000000ffffffe0000000000000000000000000000", b: "00000000000000000000000000000ffffffe0000000000000000000000000000", add: "00000000000000000000000000001ffffffc0000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "c000000400000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-2,B-1)", a: "00000000000000000000000000000ffffffe0000000000000000000000000000", b: "00000000000000000000000000000fffffff0000000000000000000000000000", add: "00000000000000000000000000001ffffffd0000000000000000000000000000", sub: "ffffffffffffffffffffffffffffffffffff0000000000000000000000000000", mul: "d000000200000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-1,0)", a: "00000000000000000000000000000fffffff0000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "00000000000000000000000000000fffffff0000000000000000000000000000", sub: "00000000000000000000000000000fffffff0000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-1,1)", a: "00000000000000000000000000000fffffff0000000000000000000000000000", b: "0000000000000000000000000000000000010000000000000000000000000000", add: "0000000000000000000000000000100000000000000000000000000000000000", sub: "00000000000000000000000000000ffffffe0000000000000000000000000000", mul: "0fffffff00000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-1,B-2)", a: "00000000000000000000000000000fffffff0000000000000000000000000000", b: "00000000000000000000000000000ffffffe0000000000000000000000000000", add: "00000000000000000000000000001ffffffd0000000000000000000000000000", sub: "0000000000000000000000000000000000010000000000000000000000000000", mul: "d000000200000000000000000000000000000000000000000000000000000000" },
    { label: "l4(B-1,B-1)", a: "00000000000000000000000000000fffffff0000000000000000000000000000", b: "00000000000000000000000000000fffffff0000000000000000000000000000", add: "00000000000000000000000000001ffffffe0000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "e000000100000000000000000000000000000000000000000000000000000000" },
    { label: "l9(0,0)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "0000000000000000000000000000000000000000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(0,1)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "1000000000000000000000000000000000000000000000000000000000000000", add: "1000000000000000000000000000000000000000000000000000000000000000", sub: "f000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(0,14)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "e000000000000000000000000000000000000000000000000000000000000000", add: "e000000000000000000000000000000000000000000000000000000000000000", sub: "2000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(0,15)", a: "0000000000000000000000000000000000000000000000000000000000000000", b: "f000000000000000000000000000000000000000000000000000000000000000", add: "f000000000000000000000000000000000000000000000000000000000000000", sub: "1000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(1,0)", a: "1000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "1000000000000000000000000000000000000000000000000000000000000000", sub: "1000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(1,1)", a: "1000000000000000000000000000000000000000000000000000000000000000", b: "1000000000000000000000000000000000000000000000000000000000000000", add: "2000000000000000000000000000000000000000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(1,14)", a: "1000000000000000000000000000000000000000000000000000000000000000", b: "e000000000000000000000000000000000000000000000000000000000000000", add: "f000000000000000000000000000000000000000000000000000000000000000", sub: "3000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(1,15)", a: "1000000000000000000000000000000000000000000000000000000000000000", b: "f000000000000000000000000000000000000000000000000000000000000000", add: "0000000000000000000000000000000000000000000000000000000000000000", sub: "2000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(14,0)", a: "e000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "e000000000000000000000000000000000000000000000000000000000000000", sub: "e000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(14,1)", a: "e000000000000000000000000000000000000000000000000000000000000000", b: "1000000000000000000000000000000000000000000000000000000000000000", add: "f000000000000000000000000000000000000000000000000000000000000000", sub: "d000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(14,14)", a: "e000000000000000000000000000000000000000000000000000000000000000", b: "e000000000000000000000000000000000000000000000000000000000000000", add: "c000000000000000000000000000000000000000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(14,15)", a: "e000000000000000000000000000000000000000000000000000000000000000", b: "f000000000000000000000000000000000000000000000000000000000000000", add: "d000000000000000000000000000000000000000000000000000000000000000", sub: "f000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(15,0)", a: "f000000000000000000000000000000000000000000000000000000000000000", b: "0000000000000000000000000000000000000000000000000000000000000000", add: "f000000000000000000000000000000000000000000000000000000000000000", sub: "f000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(15,1)", a: "f000000000000000000000000000000000000000000000000000000000000000", b: "1000000000000000000000000000000000000000000000000000000000000000", add: "0000000000000000000000000000000000000000000000000000000000000000", sub: "e000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(15,14)", a: "f000000000000000000000000000000000000000000000000000000000000000", b: "e000000000000000000000000000000000000000000000000000000000000000", add: "d000000000000000000000000000000000000000000000000000000000000000", sub: "1000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
    { label: "l9(15,15)", a: "f000000000000000000000000000000000000000000000000000000000000000", b: "f000000000000000000000000000000000000000000000000000000000000000", add: "e000000000000000000000000000000000000000000000000000000000000000", sub: "0000000000000000000000000000000000000000000000000000000000000000", mul: "0000000000000000000000000000000000000000000000000000000000000000" },
  ] as const;

  describe("Frozen fuzz vectors (50 random pairs)", () => {
    for (const [i, v] of FUZZ_VECTORS.entries()) {
      it(`fuzz[${i}] add`, () => {
        const a = BigInt("0x" + v.a);
        const b = BigInt("0x" + v.b);
        expect(toHex256(a + b)).toBe(v.add);
      });

      it(`fuzz[${i}] sub`, () => {
        const a = BigInt("0x" + v.a);
        const b = BigInt("0x" + v.b);
        expect(toHex256(a - b)).toBe(v.sub);
      });

      it(`fuzz[${i}] mul`, () => {
        const a = BigInt("0x" + v.a);
        const b = BigInt("0x" + v.b);
        expect(toHex256(a * b)).toBe(v.mul);
      });

      it(`fuzz[${i}] div (short, d=${v.d})`, () => {
        const a = BigInt("0x" + v.a);
        const d = BigInt(v.d);
        expect(toHex256(a / d)).toBe(v.divQ);
        expect(Number(a % d)).toBe(v.divR);
      });
    }
  });

  describe("Near-boundary sweep (l0/l4/l9 limb positions)", () => {
    for (const [i, v] of BOUNDARY_VECTORS.entries()) {
      it(`boundary[${i}] ${v.label} add`, () => {
        const a = BigInt("0x" + v.a);
        const b = BigInt("0x" + v.b);
        expect(toHex256(a + b)).toBe(v.add);
      });

      it(`boundary[${i}] ${v.label} sub`, () => {
        const a = BigInt("0x" + v.a);
        const b = BigInt("0x" + v.b);
        expect(toHex256(a - b)).toBe(v.sub);
      });

      it(`boundary[${i}] ${v.label} mul`, () => {
        const a = BigInt("0x" + v.a);
        const b = BigInt("0x" + v.b);
        expect(toHex256(a * b)).toBe(v.mul);
      });
    }
  });
});

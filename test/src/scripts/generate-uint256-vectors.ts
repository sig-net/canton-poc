/**
 * Deterministic fuzz-vector generator for UInt256 test suite.
 *
 * Uses keccak256-based PRNG seeded with a fixed string so output is
 * perfectly reproducible across runs. Writes TS and Daml code fragments
 * to /tmp for insertion into the respective test files.
 *
 * Usage: npx tsx test/src/scripts/generate-uint256-vectors.ts
 */

import { keccak256, toHex } from "viem";
import { writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MOD = 1n << 256n;
const UINT256_MAX = MOD - 1n;
const B = 1n << 28n; // limb base
const SEED = "uint256-fuzz-vectors-v1";

// ---------------------------------------------------------------------------
// Deterministic PRNG: keccak256 chain
// ---------------------------------------------------------------------------

let state: `0x${string}` = keccak256(toHex(SEED, { size: 32 }));

function nextBytes32(): bigint {
  state = keccak256(state);
  return BigInt(state);
}

/** Random uint256. */
function randU256(): bigint {
  return nextBytes32() & UINT256_MAX;
}

/** Random int in [1, max] inclusive, where max < 2^28. */
function randSmallDivisor(max: bigint): number {
  const raw = nextBytes32() & UINT256_MAX;
  return Number((raw % max) + 1n);
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

function toHex256(n: bigint): string {
  return ((n % MOD) + MOD).toString(16).padStart(64, "0").slice(-64);
}

// ---------------------------------------------------------------------------
// 1. Random fuzz pairs (50)
// ---------------------------------------------------------------------------

interface FuzzVector {
  idx: number;
  a: string;
  b: string;
  add: string;
  sub: string;
  mul: string;
  d: number;
  divQ: string;
  divR: number;
}

function generateFuzzVectors(count: number): FuzzVector[] {
  const vectors: FuzzVector[] = [];
  for (let i = 0; i < count; i++) {
    const a = randU256();
    const bVal = randU256();
    const add = (a + bVal) % MOD;
    const sub = (((a - bVal) % MOD) + MOD) % MOD;
    const mul = (a * bVal) % MOD;
    const d = randSmallDivisor(B - 1n); // d in [1, 2^28-1]
    const divQ = a / BigInt(d);
    const divR = Number(a % BigInt(d));
    vectors.push({
      idx: i,
      a: toHex256(a),
      b: toHex256(bVal),
      add: toHex256(add),
      sub: toHex256(sub),
      mul: toHex256(mul),
      d,
      divQ: toHex256(divQ),
      divR,
    });
  }
  return vectors;
}

// ---------------------------------------------------------------------------
// 2. Near-boundary sweep
// ---------------------------------------------------------------------------

interface BoundaryVector {
  label: string;
  a: string;
  b: string;
  add: string;
  sub: string;
  mul: string;
}

function generateBoundarySweep(): BoundaryVector[] {
  const vals = [0n, 1n, B - 2n, B - 1n];
  const labels = ["0", "1", "B-2", "B-1"];
  const vectors: BoundaryVector[] = [];

  // l0 position (no shift)
  for (const [i, av] of vals.entries()) {
    for (const [j, bv] of vals.entries()) {
      vectors.push({
        label: `l0(${labels[i]},${labels[j]})`,
        a: toHex256(av),
        b: toHex256(bv),
        add: toHex256((av + bv) % MOD),
        sub: toHex256((((av - bv) % MOD) + MOD) % MOD),
        mul: toHex256((av * bv) % MOD),
      });
    }
  }

  // l4 position (shift by B^4 = 2^112)
  const shift4 = B ** 4n;
  for (const [i, av] of vals.entries()) {
    for (const [j, bv] of vals.entries()) {
      const a = av * shift4;
      const bVal = bv * shift4;
      vectors.push({
        label: `l4(${labels[i]},${labels[j]})`,
        a: toHex256(a),
        b: toHex256(bVal),
        add: toHex256((a + bVal) % MOD),
        sub: toHex256((((a - bVal) % MOD) + MOD) % MOD),
        mul: toHex256((a * bVal) % MOD),
      });
    }
  }

  // l9 position (shift by B^9 = 2^252, but clamp to 0-15 for the 4-bit top limb)
  const shift9 = B ** 9n; // = 2^252
  const topVals = [0n, 1n, 14n, 15n]; // clamped to [0,15]
  const topLabels = ["0", "1", "14", "15"];
  for (const [i, tv] of topVals.entries()) {
    for (const [j, tu] of topVals.entries()) {
      const a = tv * shift9;
      const bVal = tu * shift9;
      vectors.push({
        label: `l9(${topLabels[i]},${topLabels[j]})`,
        a: toHex256(a),
        b: toHex256(bVal),
        add: toHex256((a + bVal) % MOD),
        sub: toHex256((((a - bVal) % MOD) + MOD) % MOD),
        mul: toHex256((a * bVal) % MOD),
      });
    }
  }

  return vectors;
}

// ---------------------------------------------------------------------------
// Build TS fragment
// ---------------------------------------------------------------------------

function buildTsFragment(fuzz: FuzzVector[], boundary: BoundaryVector[]): string {
  const lines: string[] = [];

  lines.push(`
// ---------------------------------------------------------------------------
// Frozen fuzz vectors (generated by generate-uint256-vectors.ts)
// Seed: keccak256("${SEED}") -- deterministic, do not edit
// ---------------------------------------------------------------------------

const FUZZ_VECTORS = [`);
  for (const v of fuzz) {
    lines.push(
      `  { a: "${v.a}", b: "${v.b}", add: "${v.add}", sub: "${v.sub}", mul: "${v.mul}", d: ${v.d}, divQ: "${v.divQ}", divR: ${v.divR} },`,
    );
  }
  lines.push(`] as const;

const BOUNDARY_VECTORS = [`);
  for (const v of boundary) {
    lines.push(
      `  { label: "${v.label}", a: "${v.a}", b: "${v.b}", add: "${v.add}", sub: "${v.sub}", mul: "${v.mul}" },`,
    );
  }
  lines.push(`] as const;

describe("Frozen fuzz vectors (50 random pairs)", () => {
  for (const [i, v] of FUZZ_VECTORS.entries()) {
    it(\`fuzz[\${i}] add\`, () => {
      const a = BigInt("0x" + v.a);
      const b = BigInt("0x" + v.b);
      expect(toHex256(a + b)).toBe(v.add);
    });

    it(\`fuzz[\${i}] sub\`, () => {
      const a = BigInt("0x" + v.a);
      const b = BigInt("0x" + v.b);
      expect(toHex256(a - b)).toBe(v.sub);
    });

    it(\`fuzz[\${i}] mul\`, () => {
      const a = BigInt("0x" + v.a);
      const b = BigInt("0x" + v.b);
      expect(toHex256(a * b)).toBe(v.mul);
    });

    it(\`fuzz[\${i}] div (short, d=\${v.d})\`, () => {
      const a = BigInt("0x" + v.a);
      const d = BigInt(v.d);
      expect(toHex256(a / d)).toBe(v.divQ);
      expect(Number(a % d)).toBe(v.divR);
    });
  }
});

describe("Near-boundary sweep (l0/l4/l9 limb positions)", () => {
  for (const [i, v] of BOUNDARY_VECTORS.entries()) {
    it(\`boundary[\${i}] \${v.label} add\`, () => {
      const a = BigInt("0x" + v.a);
      const b = BigInt("0x" + v.b);
      expect(toHex256(a + b)).toBe(v.add);
    });

    it(\`boundary[\${i}] \${v.label} sub\`, () => {
      const a = BigInt("0x" + v.a);
      const b = BigInt("0x" + v.b);
      expect(toHex256(a - b)).toBe(v.sub);
    });

    it(\`boundary[\${i}] \${v.label} mul\`, () => {
      const a = BigInt("0x" + v.a);
      const b = BigInt("0x" + v.b);
      expect(toHex256(a * b)).toBe(v.mul);
    });
  }
});`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Build Daml fragment -- uses 10 fuzz vectors + all boundary vectors
// ---------------------------------------------------------------------------

function buildDamlFragment(fuzz: FuzzVector[], boundary: BoundaryVector[]): string {
  const lines: string[] = [];
  const subset = fuzz.slice(0, 10);

  lines.push(`
-- ---------------------------------------------------------------------------
-- Frozen fuzz vectors (generated by generate-uint256-vectors.ts)
-- Seed: keccak256("${SEED}") -- deterministic, do not edit
-- ---------------------------------------------------------------------------
`);

  // Fuzz vector constants
  for (const v of subset) {
    const p = `fuzz${v.idx}`;
    lines.push(`${p}a : BytesHex`);
    lines.push(`${p}a = "${v.a}"`);
    lines.push(`${p}b : BytesHex`);
    lines.push(`${p}b = "${v.b}"`);
    lines.push(`${p}add : BytesHex`);
    lines.push(`${p}add = "${v.add}"`);
    lines.push(`${p}sub : BytesHex`);
    lines.push(`${p}sub = "${v.sub}"`);
    lines.push(`${p}mul : BytesHex`);
    lines.push(`${p}mul = "${v.mul}"`);
    lines.push(`${p}d : Int`);
    lines.push(`${p}d = ${v.d}`);
    lines.push(`${p}divQ : BytesHex`);
    lines.push(`${p}divQ = "${v.divQ}"`);
    lines.push(`${p}divR : Int`);
    lines.push(`${p}divR = ${v.divR}`);
    lines.push(``);
  }

  // Fuzz test function
  lines.push(`-- ---------------------------------------------------------------------------`);
  lines.push(`-- 48. Frozen fuzz vectors (10 of 50)`);
  lines.push(`-- ---------------------------------------------------------------------------`);
  lines.push(``);
  lines.push(`testFrozenFuzz : Script ()`);
  lines.push(`testFrozenFuzz = do`);
  for (const v of subset) {
    const p = `fuzz${v.idx}`;
    lines.push(`  assertMsg "fuzz${v.idx} add" (hexAddUint256 ${p}a ${p}b == ${p}add)`);
    lines.push(`  assertMsg "fuzz${v.idx} sub" (hexSubUint256 ${p}a ${p}b == ${p}sub)`);
    lines.push(`  assertMsg "fuzz${v.idx} mul" (hexMulUint256 ${p}a ${p}b == ${p}mul)`);
    lines.push(`  let (q${v.idx}, r${v.idx}) = uint256DivInt (uint256FromHex ${p}a) ${p}d`);
    lines.push(`  assertMsg "fuzz${v.idx} divQ" (uint256ToHex q${v.idx} == ${p}divQ)`);
    lines.push(`  assertMsg "fuzz${v.idx} divR" (r${v.idx} == ${p}divR)`);
  }

  lines.push(``);
  lines.push(`-- ---------------------------------------------------------------------------`);
  lines.push(`-- Near-boundary sweep constants`);
  lines.push(`-- ---------------------------------------------------------------------------`);
  lines.push(``);

  // Boundary vector constants
  for (const [i, v] of boundary.entries()) {
    const p = `bnd${i}`;
    lines.push(`-- ${v.label}`);
    lines.push(`${p}a : BytesHex`);
    lines.push(`${p}a = "${v.a}"`);
    lines.push(`${p}b : BytesHex`);
    lines.push(`${p}b = "${v.b}"`);
    lines.push(`${p}add : BytesHex`);
    lines.push(`${p}add = "${v.add}"`);
    lines.push(`${p}sub : BytesHex`);
    lines.push(`${p}sub = "${v.sub}"`);
    lines.push(`${p}mul : BytesHex`);
    lines.push(`${p}mul = "${v.mul}"`);
    lines.push(``);
  }

  // Boundary test functions -- split by position to keep functions reasonable
  for (const [group, start, end] of [
    ["l0", 0, 16],
    ["l4", 16, 32],
    ["l9", 32, 48],
  ] as const) {
    const testNum = group === "l0" ? 49 : group === "l4" ? 50 : 51;
    lines.push(`-- ---------------------------------------------------------------------------`);
    lines.push(`-- ${testNum}. Boundary sweep: ${group} position`);
    lines.push(`-- ---------------------------------------------------------------------------`);
    lines.push(``);
    lines.push(`testBoundary${group.charAt(0).toUpperCase() + group.slice(1)} : Script ()`);
    lines.push(`testBoundary${group.charAt(0).toUpperCase() + group.slice(1)} = do`);
    for (let i = start; i < end; i++) {
      const p = `bnd${i}`;
      lines.push(`  assertMsg "bnd${i} add" (hexAddUint256 ${p}a ${p}b == ${p}add)`);
      lines.push(`  assertMsg "bnd${i} sub" (hexSubUint256 ${p}a ${p}b == ${p}sub)`);
      lines.push(`  assertMsg "bnd${i} mul" (hexMulUint256 ${p}a ${p}b == ${p}mul)`);
    }
    lines.push(``);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const fuzz = generateFuzzVectors(50);
const boundary = generateBoundarySweep();

const tsFragment = buildTsFragment(fuzz, boundary);
const damlFragment = buildDamlFragment(fuzz, boundary);

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../..");

writeFileSync(resolve(projectRoot, "uint256-ts-fragment.txt"), tsFragment);
writeFileSync(resolve(projectRoot, "uint256-daml-fragment.txt"), damlFragment);

console.log(`Generated ${fuzz.length} fuzz vectors and ${boundary.length} boundary vectors.`);
console.log(`Wrote ${resolve(projectRoot, "uint256-ts-fragment.txt")}`);
console.log(`Wrote ${resolve(projectRoot, "uint256-daml-fragment.txt")}`);

# daml-abi Property-Based Fuzzing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-language corpus-driven property-based fuzzing to `daml-packages/daml-abi`: a seeded TypeScript generator emits a Daml module containing thousands of randomized ABI inputs (valid + adversarial), and a Daml Script test iterates every case asserting oracle parity, malformed-input rejection, and universal invariants.

**Architecture:** `test/fuzz/run.ts` produces `daml/FuzzCorpus.daml` (auto-generated, gitignored) containing a `fuzzCases : [Case]` list. `daml/TestFuzz.daml` iterates the list, dispatching on case kind. Valid cases are compared against viem-computed oracle values; malformed cases must raise `GeneralError`; universal invariants (slot-aligned offsets, length monotonicity) run on every case. Seeded PRNG makes each run reproducible when `FUZZ_SEED` is logged.

**Tech Stack:** TypeScript (vitest, viem, tsx), Daml 3.4 (Script, DA.Crypto.Text, DA.Foldable). Optional stretch: `fast-check` for automatic shrinking of failing inputs.

---

### Task 1: Scaffold fuzz harness directory + deps + gitignore + npm scripts

**Files:**

- Modify: `daml-packages/daml-abi/package.json` (devDependencies, scripts)
- Create: `daml-packages/daml-abi/.gitignore`
- Create: `daml-packages/daml-abi/test/fuzz/` (directory marker)

- [ ] **Step 1: Add `tsx` as a dev dependency**

From repo root:

```bash
pnpm --filter @canton/daml-abi add -D tsx@^4.19.0
```

- [ ] **Step 2: Update `daml-packages/daml-abi/package.json` scripts**

Edit `daml-packages/daml-abi/package.json`, replace the `scripts` block with:

```json
"scripts": {
  "test": "vitest run",
  "fuzz:gen":  "FUZZ_SEED=${FUZZ_SEED:-$(date +%s)} FUZZ_N=${FUZZ_N:-1000} tsx test/fuzz/run.ts",
  "fuzz:daml": "dpm build && dpm test --files daml/TestFuzz.daml",
  "fuzz":      "pnpm fuzz:gen && pnpm fuzz:daml"
}
```

- [ ] **Step 3: Create `daml-packages/daml-abi/.gitignore`**

```gitignore
daml/FuzzCorpus.daml
```

- [ ] **Step 4: Create the test/fuzz directory with an empty placeholder**

```bash
mkdir -p daml-packages/daml-abi/test/fuzz
touch daml-packages/daml-abi/test/fuzz/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add daml-packages/daml-abi/package.json daml-packages/daml-abi/.gitignore daml-packages/daml-abi/test/fuzz/.gitkeep daml-packages/daml-abi/pnpm-lock.yaml pnpm-lock.yaml
git commit -m "chore(daml-abi): scaffold fuzz harness directory and deps"
```

---

### Task 2: Seeded PRNG (Mulberry32)

**Files:**

- Create: `daml-packages/daml-abi/test/fuzz/prng.ts`
- Create: `daml-packages/daml-abi/test/fuzz/prng.test.ts`

- [ ] **Step 1: Write the failing test**

Create `daml-packages/daml-abi/test/fuzz/prng.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mulberry32 } from "./prng.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 20; i++) {
      expect(a()).toBe(b());
    }
  });

  it("returns values in [0, 1)", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("diverges for different seeds within 10 draws", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const aVals = Array.from({ length: 10 }, () => a());
    const bVals = Array.from({ length: 10 }, () => b());
    expect(aVals).not.toEqual(bVals);
  });
});
```

- [ ] **Step 2: Run test — expect failure (module not found)**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: `Error: Failed to resolve import "./prng.js"` — test fails to import.

- [ ] **Step 3: Implement the PRNG**

Create `daml-packages/daml-abi/test/fuzz/prng.ts`:

```typescript
// Mulberry32: small, fast, seedable PRNG. Returns a function that produces
// a new float in [0, 1) on each call.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convenience: draw an integer in [lo, hi] (inclusive).
export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// Convenience: draw N random bytes as a hex string (lowercase, no 0x).
export function randHex(rng: () => number, nBytes: number): string {
  let out = "";
  for (let i = 0; i < nBytes; i++) {
    out += Math.floor(rng() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: 3 tests pass in `prng.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add daml-packages/daml-abi/test/fuzz/prng.ts daml-packages/daml-abi/test/fuzz/prng.test.ts
git commit -m "feat(daml-abi): add seeded PRNG for fuzz generator"
```

---

### Task 3: FuzzCase TypeScript type + Daml emitter

**Files:**

- Create: `daml-packages/daml-abi/test/fuzz/types.ts`
- Create: `daml-packages/daml-abi/test/fuzz/emit.ts`
- Create: `daml-packages/daml-abi/test/fuzz/emit.test.ts`

- [ ] **Step 1: Define the TS type**

Create `daml-packages/daml-abi/test/fuzz/types.ts`:

```typescript
// Tagged union mirroring the Daml Case ADT in FuzzCorpus.daml.
// All hex strings here are stored WITHOUT the "0x" prefix (the Daml side
// uses bare hex in its BytesHex values).
export type FuzzCase =
  | { kind: "ValidUint256"; hex: string; expected: string }
  | { kind: "ValidAddress"; hex: string; expected: string }
  | { kind: "ValidString"; hex: string; expected: string } // expected = UTF-8 payload hex
  | { kind: "MalformedTruncated"; hex: string }
  | { kind: "MalformedDirtyAddress"; hex: string }
  | { kind: "MalformedOverlongLength"; hex: string }
  | { kind: "MalformedUnalignedOffset"; hex: string }
  | { kind: "MalformedBadUtf8"; hex: string };

// Strip "0x" prefix if present and lowercase.
export function stripHexPrefix(h: string): string {
  return (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();
}
```

- [ ] **Step 2: Write failing test for emitter**

Create `daml-packages/daml-abi/test/fuzz/emit.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { emitDamlCorpus } from "./emit.js";
import type { FuzzCase } from "./types.js";

describe("emitDamlCorpus", () => {
  it("emits header and module declaration", () => {
    const out = emitDamlCorpus([], 42);
    expect(out).toContain("-- AUTO-GENERATED");
    expect(out).toContain("module FuzzCorpus where");
    expect(out).toContain("seed = 42");
    expect(out).toContain("fuzzCases : [Case]");
    expect(out).toContain("fuzzCases = []");
  });

  it("emits ValidUint256 case with two hex args", () => {
    const cases: FuzzCase[] = [{ kind: "ValidUint256", hex: "aabb", expected: "cc" }];
    const out = emitDamlCorpus(cases, 1);
    expect(out).toContain('ValidUint256 "aabb" "cc"');
  });

  it("emits malformed cases with a single hex arg", () => {
    const cases: FuzzCase[] = [{ kind: "MalformedTruncated", hex: "deadbee" }];
    const out = emitDamlCorpus(cases, 1);
    expect(out).toContain('MalformedTruncated "deadbee"');
  });

  it("separates multiple cases with commas", () => {
    const cases: FuzzCase[] = [
      { kind: "ValidUint256", hex: "00", expected: "00" },
      { kind: "MalformedTruncated", hex: "ff" },
    ];
    const out = emitDamlCorpus(cases, 7);
    // Both on separate lines with Daml list comma separator
    expect(out.match(/^\s*,/m)).not.toBeNull();
    expect(out).toContain('ValidUint256 "00" "00"');
    expect(out).toContain('MalformedTruncated "ff"');
  });
});
```

- [ ] **Step 3: Run — expect failure**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: `Failed to resolve import "./emit.js"`.

- [ ] **Step 4: Implement the emitter**

Create `daml-packages/daml-abi/test/fuzz/emit.ts`:

```typescript
import type { FuzzCase } from "./types.js";

const HEADER = `-- AUTO-GENERATED by test/fuzz/run.ts. Do not edit.
-- Regenerate with: pnpm fuzz:gen
module FuzzCorpus where

import DA.Crypto.Text (BytesHex)

data Case
  = ValidUint256 BytesHex BytesHex
  | ValidAddress BytesHex BytesHex
  | ValidString BytesHex BytesHex
  | MalformedTruncated BytesHex
  | MalformedDirtyAddress BytesHex
  | MalformedOverlongLength BytesHex
  | MalformedUnalignedOffset BytesHex
  | MalformedBadUtf8 BytesHex
  deriving (Eq, Show)
`;

function renderCase(c: FuzzCase): string {
  switch (c.kind) {
    case "ValidUint256":
    case "ValidAddress":
    case "ValidString":
      return `${c.kind} "${c.hex}" "${c.expected}"`;
    case "MalformedTruncated":
    case "MalformedDirtyAddress":
    case "MalformedOverlongLength":
    case "MalformedUnalignedOffset":
    case "MalformedBadUtf8":
      return `${c.kind} "${c.hex}"`;
  }
}

export function emitDamlCorpus(cases: FuzzCase[], seed: number): string {
  const body =
    cases.length === 0
      ? "fuzzCases = []"
      : `fuzzCases =\n  [ ${cases.map(renderCase).join("\n  , ")}\n  ]`;

  return `${HEADER}
-- seed = ${seed}
-- count = ${cases.length}
fuzzCases : [Case]
${body}
`;
}
```

- [ ] **Step 5: Run — expect pass**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: emit tests pass.

- [ ] **Step 6: Commit**

```bash
git add daml-packages/daml-abi/test/fuzz/types.ts daml-packages/daml-abi/test/fuzz/emit.ts daml-packages/daml-abi/test/fuzz/emit.test.ts
git commit -m "feat(daml-abi): add FuzzCase type and Daml corpus emitter"
```

---

### Task 4: Valid-case generators (uint256, address, string)

**Files:**

- Create: `daml-packages/daml-abi/test/fuzz/valid-gens.ts`
- Create: `daml-packages/daml-abi/test/fuzz/valid-gens.test.ts`

- [ ] **Step 1: Write failing test**

Create `daml-packages/daml-abi/test/fuzz/valid-gens.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { decodeAbiParameters } from "viem";
import { mulberry32 } from "./prng.js";
import { genValidUint256, genValidAddress, genValidString } from "./valid-gens.js";

describe("valid-gens", () => {
  it("genValidUint256 produces a viem-decodable hex matching expected", () => {
    const rng = mulberry32(123);
    const c = genValidUint256(rng);
    expect(c.kind).toBe("ValidUint256");
    // hex is 64 chars (32 bytes), no 0x
    expect(c.hex).toMatch(/^[0-9a-f]{64}$/);
    // expected matches hex for uint256 (full-slot raw value)
    expect(c.expected).toBe(c.hex);
    // viem agrees: decoded bigint roundtrips to same hex
    const [decoded] = decodeAbiParameters([{ type: "uint256" }], ("0x" + c.hex) as `0x${string}`);
    expect(typeof decoded).toBe("bigint");
  });

  it("genValidAddress produces 32-byte slot with 12 zero bytes + 20-byte address", () => {
    const rng = mulberry32(456);
    const c = genValidAddress(rng);
    expect(c.kind).toBe("ValidAddress");
    expect(c.hex).toMatch(/^0{24}[0-9a-f]{40}$/);
    expect(c.expected).toBe(c.hex.slice(24));
  });

  it("genValidString produces an ABI-encoded string decodable by viem", () => {
    const rng = mulberry32(789);
    const c = genValidString(rng);
    expect(c.kind).toBe("ValidString");
    // expected is the hex of the UTF-8 bytes
    expect(c.expected).toMatch(/^[0-9a-f]*$/);
    // Round-trip: viem decode the hex must give a string whose UTF-8 hex == expected
    const [decoded] = decodeAbiParameters([{ type: "string" }], ("0x" + c.hex) as `0x${string}`);
    expect(Buffer.from(decoded as string, "utf-8").toString("hex")).toBe(c.expected);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: import error for `./valid-gens.js`.

- [ ] **Step 3: Implement generators**

Create `daml-packages/daml-abi/test/fuzz/valid-gens.ts`:

```typescript
import { encodeAbiParameters } from "viem";
import { randHex, randInt } from "./prng.js";
import { stripHexPrefix, type FuzzCase } from "./types.js";

export function genValidUint256(rng: () => number): FuzzCase {
  // 32 random bytes treated as a uint256
  const rawHex = randHex(rng, 32);
  const value = BigInt("0x" + rawHex);
  const encoded = encodeAbiParameters([{ type: "uint256" }], [value]);
  const hex = stripHexPrefix(encoded);
  return { kind: "ValidUint256", hex, expected: hex };
}

export function genValidAddress(rng: () => number): FuzzCase {
  const addr = "0x" + randHex(rng, 20);
  const encoded = encodeAbiParameters([{ type: "address" }], [addr as `0x${string}`]);
  const hex = stripHexPrefix(encoded);
  return {
    kind: "ValidAddress",
    hex,
    expected: hex.slice(24), // 12 bytes of padding × 2 hex chars
  };
}

// Generate a random ASCII-safe string (length 0..100). Restricting to ASCII
// makes the oracle comparison simple (1 char = 1 byte in UTF-8).
export function genValidString(rng: () => number): FuzzCase {
  const len = randInt(rng, 0, 100);
  const chars: string[] = [];
  for (let i = 0; i < len; i++) {
    // Printable ASCII (0x20..0x7e) — excludes control chars for simplicity
    chars.push(String.fromCharCode(randInt(rng, 0x20, 0x7e)));
  }
  const s = chars.join("");
  const encoded = encodeAbiParameters([{ type: "string" }], [s]);
  const hex = stripHexPrefix(encoded);
  const expected = Buffer.from(s, "utf-8").toString("hex");
  return { kind: "ValidString", hex, expected };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: all valid-gen tests pass.

- [ ] **Step 5: Commit**

```bash
git add daml-packages/daml-abi/test/fuzz/valid-gens.ts daml-packages/daml-abi/test/fuzz/valid-gens.test.ts
git commit -m "feat(daml-abi): add valid-case fuzz generators with viem oracle"
```

---

### Task 5: Malformed-case generators (5 kinds)

**Files:**

- Create: `daml-packages/daml-abi/test/fuzz/malformed-gens.ts`
- Create: `daml-packages/daml-abi/test/fuzz/malformed-gens.test.ts`

- [ ] **Step 1: Write failing test**

Create `daml-packages/daml-abi/test/fuzz/malformed-gens.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mulberry32 } from "./prng.js";
import {
  genMalformedTruncated,
  genMalformedDirtyAddress,
  genMalformedOverlongLength,
  genMalformedUnalignedOffset,
  genMalformedBadUtf8,
} from "./malformed-gens.js";

describe("malformed-gens", () => {
  it("truncated drops at least 1 byte from a valid dynamic encoding", () => {
    const rng = mulberry32(1);
    const c = genMalformedTruncated(rng);
    expect(c.kind).toBe("MalformedTruncated");
    expect(c.hex.length % 2).toBe(0);
    // Must be shorter than 3 full slots (offset + length + at least some data)
    expect(c.hex.length).toBeGreaterThan(0);
  });

  it("dirty-address sets non-zero bits in the 12-byte padding region", () => {
    const rng = mulberry32(2);
    const c = genMalformedDirtyAddress(rng);
    expect(c.kind).toBe("MalformedDirtyAddress");
    expect(c.hex).toHaveLength(64);
    expect(c.hex.slice(0, 24)).not.toBe("000000000000000000000000");
  });

  it("overlong-length claims a huge length (>Int64 max) for dynamic bytes", () => {
    const rng = mulberry32(3);
    const c = genMalformedOverlongLength(rng);
    expect(c.kind).toBe("MalformedOverlongLength");
    // slot 0 = offset 32, slot 1 = bogus length — first 2 slots = 128 chars
    expect(c.hex.length).toBeGreaterThanOrEqual(128);
    // Length slot (slot 1) must have at least one bit set above 2^63
    const lengthSlot = c.hex.slice(64, 128);
    expect(BigInt("0x" + lengthSlot)).toBeGreaterThan(2n ** 63n - 1n);
  });

  it("unaligned-offset puts a non-32-aligned offset in slot 0", () => {
    const rng = mulberry32(4);
    const c = genMalformedUnalignedOffset(rng);
    expect(c.kind).toBe("MalformedUnalignedOffset");
    const offset = Number(BigInt("0x" + c.hex.slice(0, 64)));
    expect(offset % 32).not.toBe(0);
    expect(offset).toBeGreaterThan(0);
  });

  it("bad-utf8 encodes a length-prefixed payload containing invalid UTF-8", () => {
    const rng = mulberry32(5);
    const c = genMalformedBadUtf8(rng);
    expect(c.kind).toBe("MalformedBadUtf8");
    // Extract the payload bytes from the string encoding
    const lenHex = c.hex.slice(64, 128);
    const len = Number(BigInt("0x" + lenHex));
    const payload = c.hex.slice(128, 128 + len * 2);
    // Payload must contain a byte that's invalid as UTF-8 start
    const bytes = Buffer.from(payload, "hex");
    expect(() => bytes.toString("utf-8").length).not.toThrow();
    // Key invariant: re-encoding to utf8 loses bytes (replacement char)
    const roundtrip = Buffer.from(bytes.toString("utf-8"), "utf-8").toString("hex");
    expect(roundtrip).not.toBe(payload);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd daml-packages/daml-abi && pnpm test
```

- [ ] **Step 3: Implement**

Create `daml-packages/daml-abi/test/fuzz/malformed-gens.ts`:

```typescript
import { encodeAbiParameters } from "viem";
import { randHex, randInt } from "./prng.js";
import { stripHexPrefix, type FuzzCase } from "./types.js";

// Take a valid dynamic-bytes encoding and drop 1-16 bytes from the end.
export function genMalformedTruncated(rng: () => number): FuzzCase {
  const payloadBytes = randInt(rng, 1, 64);
  const encoded = encodeAbiParameters(
    [{ type: "bytes" }],
    [("0x" + randHex(rng, payloadBytes)) as `0x${string}`],
  );
  const full = stripHexPrefix(encoded);
  const dropBytes = randInt(rng, 1, 16);
  return {
    kind: "MalformedTruncated",
    hex: full.slice(0, full.length - dropBytes * 2),
  };
}

// 32-byte slot: dirty top 12 bytes (non-zero) + 20-byte address
export function genMalformedDirtyAddress(rng: () => number): FuzzCase {
  // Ensure at least one non-zero byte in the padding
  let pad = randHex(rng, 12);
  if (/^0+$/.test(pad)) {
    pad = "01" + pad.slice(2);
  }
  const addr = randHex(rng, 20);
  return { kind: "MalformedDirtyAddress", hex: pad + addr };
}

// bytes payload with length slot set to a value > Int64 max.
// Layout: slot 0 = offset 32, slot 1 = bogus length, slot 2 = small data.
export function genMalformedOverlongLength(rng: () => number): FuzzCase {
  const offset = "0".repeat(62) + "20"; // 32
  // Length = 2^63 + random in [1, 2^20]
  const bigLen = (1n << 63n) + BigInt(randInt(rng, 1, 1 << 20));
  const lenSlot = bigLen.toString(16).padStart(64, "0");
  const tinyData = randHex(rng, 4).padEnd(64, "0");
  return {
    kind: "MalformedOverlongLength",
    hex: offset + lenSlot + tinyData,
  };
}

// Offset pointer that is positive and NOT a multiple of 32.
export function genMalformedUnalignedOffset(rng: () => number): FuzzCase {
  // Pick an offset of form 32k + r where r in [1, 31]
  const k = randInt(rng, 0, 2);
  const r = randInt(rng, 1, 31);
  const offsetVal = k * 32 + r;
  const offset = offsetVal.toString(16).padStart(64, "0");
  const length = "0".repeat(62) + "01"; // 1
  const data = randHex(rng, 1).padEnd(64, "0");
  return {
    kind: "MalformedUnalignedOffset",
    hex: offset + length + data,
  };
}

// String encoding whose payload bytes are invalid UTF-8 (e.g. 0xc0 0xc0).
export function genMalformedBadUtf8(rng: () => number): FuzzCase {
  const offset = "0".repeat(62) + "20";
  // Use an invalid UTF-8 start byte (0xc0 is never legal) + random
  const len = randInt(rng, 2, 8);
  const lenSlot = len.toString(16).padStart(64, "0");
  const payload = ("c0c0" + randHex(rng, len - 2)).padEnd(64, "0");
  return {
    kind: "MalformedBadUtf8",
    hex: offset + lenSlot + payload,
  };
}
```

- [ ] **Step 4: Run — expect pass**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: all malformed-gen tests pass.

- [ ] **Step 5: Commit**

```bash
git add daml-packages/daml-abi/test/fuzz/malformed-gens.ts daml-packages/daml-abi/test/fuzz/malformed-gens.test.ts
git commit -m "feat(daml-abi): add adversarial malformed-case generators"
```

---

### Task 6: Composition entry point (`run.ts`)

**Files:**

- Create: `daml-packages/daml-abi/test/fuzz/run.ts`
- Create: `daml-packages/daml-abi/test/fuzz/run.test.ts`

- [ ] **Step 1: Write failing test**

Create `daml-packages/daml-abi/test/fuzz/run.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildCorpus } from "./run.js";

describe("buildCorpus", () => {
  it("generates the requested count with seeded determinism", () => {
    const a = buildCorpus(100, 42);
    const b = buildCorpus(100, 42);
    expect(a).toEqual(b);
    expect(a).toHaveLength(100);
  });

  it("produces a diverse mix of all 8 case kinds when N is large", () => {
    const cases = buildCorpus(2000, 7);
    const kinds = new Set(cases.map((c) => c.kind));
    expect(kinds.size).toBe(8);
  });

  it("differs across seeds", () => {
    const a = buildCorpus(50, 1);
    const b = buildCorpus(50, 2);
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
cd daml-packages/daml-abi && pnpm test
```

- [ ] **Step 3: Implement `run.ts`**

Create `daml-packages/daml-abi/test/fuzz/run.ts`:

```typescript
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mulberry32, randInt } from "./prng.js";
import { emitDamlCorpus } from "./emit.js";
import type { FuzzCase } from "./types.js";
import { genValidUint256, genValidAddress, genValidString } from "./valid-gens.js";
import {
  genMalformedTruncated,
  genMalformedDirtyAddress,
  genMalformedOverlongLength,
  genMalformedUnalignedOffset,
  genMalformedBadUtf8,
} from "./malformed-gens.js";

type Gen = (rng: () => number) => FuzzCase;

const ALL_GENS: Gen[] = [
  genValidUint256,
  genValidAddress,
  genValidString,
  genMalformedTruncated,
  genMalformedDirtyAddress,
  genMalformedOverlongLength,
  genMalformedUnalignedOffset,
  genMalformedBadUtf8,
];

export function buildCorpus(n: number, seed: number): FuzzCase[] {
  const rng = mulberry32(seed);
  const cases: FuzzCase[] = [];
  for (let i = 0; i < n; i++) {
    const gen = ALL_GENS[randInt(rng, 0, ALL_GENS.length - 1)];
    cases.push(gen(rng));
  }
  return cases;
}

function main(): void {
  const seed = Number(process.env.FUZZ_SEED ?? 1);
  const n = Number(process.env.FUZZ_N ?? 1000);
  if (!Number.isFinite(seed) || !Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid FUZZ_SEED=${process.env.FUZZ_SEED} or FUZZ_N=${process.env.FUZZ_N}`);
  }
  const cases = buildCorpus(n, seed);
  const daml = emitDamlCorpus(cases, seed);
  const out = join(process.cwd(), "daml/FuzzCorpus.daml");
  writeFileSync(out, daml);
  // eslint-disable-next-line no-console
  console.log(`[fuzz] wrote ${cases.length} cases with seed=${seed} to ${out}`);
}

// Run main only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd daml-packages/daml-abi && pnpm test
```

- [ ] **Step 5: Run the generator end-to-end**

```bash
cd daml-packages/daml-abi && FUZZ_SEED=1 FUZZ_N=100 pnpm fuzz:gen
```

Expected: prints `[fuzz] wrote 100 cases with seed=1 to ...` and creates `daml/FuzzCorpus.daml`.

- [ ] **Step 6: Verify the generated file compiles**

```bash
cd daml-packages/daml-abi && dpm build 2>&1 | tail -3
```

Expected: `Created .daml/dist/daml-abi-0.0.1.dar` (no compile errors).

- [ ] **Step 7: Commit (do NOT commit the generated corpus)**

```bash
git add daml-packages/daml-abi/test/fuzz/run.ts daml-packages/daml-abi/test/fuzz/run.test.ts
git commit -m "feat(daml-abi): compose fuzz generators and emit Daml corpus"
```

---

### Task 7: Daml consumer scaffold (`TestFuzz.daml`) — valid cases

**Files:**

- Create: `daml-packages/daml-abi/daml/TestFuzz.daml`

- [ ] **Step 1: Regenerate corpus with a small, known seed**

```bash
cd daml-packages/daml-abi && FUZZ_SEED=42 FUZZ_N=200 pnpm fuzz:gen
```

- [ ] **Step 2: Create `TestFuzz.daml` with valid-case handlers only**

Create `daml-packages/daml-abi/daml/TestFuzz.daml`:

```daml
module TestFuzz where

import Daml.Script
import qualified DA.Text as T
import DA.Crypto.Text (BytesHex)
import DA.Foldable (forA_)
import Abi
import FuzzCorpus

-- Valid-case handler: asserts oracle parity.
-- Malformed cases are handled in the next task — for now they are skipped
-- so this module can be run and iterated independently.
handleCase : Case -> Script ()
handleCase c = case c of
  ValidUint256 hex expected ->
    assertMsg ("uint256 oracle parity: " <> hex)
      (abiDecodeUint hex 0 == expected)
  ValidAddress hex expected ->
    assertMsg ("address oracle parity: " <> hex)
      (abiDecodeAddress hex 0 == expected)
  ValidString hex expected -> do
    let off = abiReadOffset hex 0
    let decodedBytes = abiDecodeBytes hex off
    assertMsg ("string oracle parity: " <> hex)
      (decodedBytes == expected)
  -- Malformed cases: not yet implemented; skip silently.
  _ -> pure ()

testFuzzCorpus : Script ()
testFuzzCorpus = forA_ fuzzCases handleCase
```

- [ ] **Step 3: Run the Daml fuzz test**

```bash
cd daml-packages/daml-abi && dpm test --files daml/TestFuzz.daml
```

Expected: `testFuzzCorpus: ok, 0 active contracts, 0 transactions.`

- [ ] **Step 4: Commit**

```bash
git add daml-packages/daml-abi/daml/TestFuzz.daml
git commit -m "feat(daml-abi): Daml fuzz consumer for valid-case oracle parity"
```

---

### Task 8: Malformed-case handlers in `TestFuzz.daml`

**Files:**

- Modify: `daml-packages/daml-abi/daml/TestFuzz.daml`

Uses the same `try (pure expr) catch (GeneralError _) -> pure "caught"` pattern as the existing error-path tests in `TestAbi.daml` (e.g. `testAbiSlotOutOfBounds`) — consistent with the code style you already have and proven to work with Daml 3.4's Script exception handling.

- [ ] **Step 1: Update imports in `TestFuzz.daml`**

Replace the imports block at the top with:

```daml
import Daml.Script
import qualified DA.Text as T
import DA.Crypto.Text (BytesHex)
import DA.Exception (GeneralError(..))
import DA.Foldable (forA_)
import Abi
import FuzzCorpus
```

- [ ] **Step 2: Replace the whole `handleCase` with the full switch (valid + malformed)**

Replace the entire `handleCase` definition with:

```daml
handleCase : Case -> Script ()
handleCase c = case c of
  ValidUint256 hex expected ->
    assertMsg ("uint256 oracle parity: " <> hex)
      (abiDecodeUint hex 0 == expected)
  ValidAddress hex expected ->
    assertMsg ("address oracle parity: " <> hex)
      (abiDecodeAddress hex 0 == expected)
  ValidString hex expected -> do
    let off = abiReadOffset hex 0
    let decodedBytes = abiDecodeBytes hex off
    assertMsg ("string oracle parity: " <> hex)
      (decodedBytes == expected)
  MalformedTruncated hex -> do
    caught <- try (pure (abiDecodeBytes hex (abiReadOffset hex 0)))
      catch (GeneralError _) -> pure "caught"
    assertMsg ("truncated must be rejected: " <> hex) (caught == "caught")
  MalformedDirtyAddress hex -> do
    caught <- try (pure (abiDecodeAddress hex 0))
      catch (GeneralError _) -> pure "caught"
    assertMsg ("dirty address must be rejected: " <> hex) (caught == "caught")
  MalformedOverlongLength hex -> do
    caught <- try (pure (abiDecodeBytes hex (abiReadOffset hex 0)))
      catch (GeneralError _) -> pure "caught"
    assertMsg ("overlong length must be rejected: " <> hex) (caught == "caught")
  MalformedUnalignedOffset hex -> do
    caught <- try (pure (abiDecodeBytes hex (abiReadOffset hex 0)))
      catch (GeneralError _) -> pure "caught"
    assertMsg ("unaligned offset must be rejected: " <> hex) (caught == "caught")
  MalformedBadUtf8 hex -> do
    caught <- try (pure (abiDecodeString hex (abiReadOffset hex 0)))
      catch (GeneralError _) -> pure "caught"
    assertMsg ("bad UTF-8 must be rejected: " <> hex) (caught == "caught")
```

**Why the `caught == "caught"` comparison works:**

- `BytesHex` is a `Text` alias, so the happy-path return type of the decoder and the string `"caught"` are both `Text`.
- If the decoder succeeds, `caught` holds a hex string that won't equal `"caught"` → assertion fails with a clear message that malformed input was accepted.
- If the decoder throws `GeneralError`, the catch arm returns `"caught"` → assertion passes.

- [ ] **Step 3: Run the Daml fuzz test**

```bash
cd daml-packages/daml-abi && dpm test --files daml/TestFuzz.daml
```

Expected: `testFuzzCorpus: ok`. If it fails:

- "must be rejected" message → decoder wrongly accepted a malformed input (real bug — record seed + hex).
- Other failure → likely generator bug; the supposedly-malformed case was actually well-formed.

- [ ] **Step 4: Commit**

```bash
git add daml-packages/daml-abi/daml/TestFuzz.daml
git commit -m "feat(daml-abi): fuzz test asserts malformed inputs are rejected"
```

---

### Task 9: Universal invariants (alignment + length monotonicity)

**Files:**

- Modify: `daml-packages/daml-abi/daml/TestFuzz.daml`

- [ ] **Step 1: Add invariant checks to every valid case**

Replace the `ValidUint256`, `ValidAddress`, and `ValidString` arms with:

```daml
  ValidUint256 hex expected -> do
    let decoded = abiDecodeUint hex 0
    assertMsg ("uint256 slot is 64 hex chars: " <> hex)
      (T.length decoded == 64)
    assertMsg ("uint256 oracle parity: " <> hex)
      (decoded == expected)
  ValidAddress hex expected -> do
    let decoded = abiDecodeAddress hex 0
    assertMsg ("address is 40 hex chars: " <> hex)
      (T.length decoded == 40)
    assertMsg ("address oracle parity: " <> hex)
      (decoded == expected)
  ValidString hex expected -> do
    let off = abiReadOffset hex 0
    assertMsg ("string offset is slot-aligned: " <> hex)
      (off % 32 == 0)
    let decodedBytes = abiDecodeBytes hex off
    -- Length consistency: decoded hex length equals expected payload hex length.
    -- Stronger than monotonicity (<=) and catches off-by-one in the take arithmetic.
    assertMsg ("string length matches oracle: " <> hex)
      (T.length decodedBytes == T.length expected)
    assertMsg ("string oracle parity: " <> hex)
      (decodedBytes == expected)
```

- [ ] **Step 2: Run test**

```bash
cd daml-packages/daml-abi && dpm test --files daml/TestFuzz.daml
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add daml-packages/daml-abi/daml/TestFuzz.daml
git commit -m "feat(daml-abi): fuzz checks slot-alignment and length monotonicity"
```

---

### Task 10: End-to-end verification with a planted bug

**Files:** (no code changes; verification only)

- [ ] **Step 1: Regenerate corpus with a fresh seed**

```bash
cd daml-packages/daml-abi && FUZZ_SEED=$(date +%s) FUZZ_N=2000 pnpm fuzz:gen
```

Record the printed seed (you'll need it to reproduce if a bug surfaces).

- [ ] **Step 2: Run full fuzz suite**

```bash
cd daml-packages/daml-abi && pnpm fuzz
```

Expected: 2000 cases pass within a single `testFuzzCorpus`. Approximate runtime: 5–15s.

- [ ] **Step 3: Plant a bug and confirm fuzz catches it**

Edit `daml-packages/daml-abi/daml/Abi.daml` — change `abiDecodeUint`:

```daml
abiDecodeUint : BytesHex -> Int -> BytesHex
abiDecodeUint hex i = DA.Text.drop 2 (abiSlot hex i)  -- BUG: drops first byte
```

Run:

```bash
cd daml-packages/daml-abi && pnpm fuzz
```

Expected: `testFuzzCorpus: failed` with an error mentioning `uint256 slot is 64 hex chars` or `uint256 oracle parity`.

- [ ] **Step 4: Revert the planted bug**

```bash
cd daml-packages/daml-abi && git checkout daml/Abi.daml
```

- [ ] **Step 5: Confirm suite is clean again**

```bash
cd daml-packages/daml-abi && pnpm fuzz
```

Expected: `testFuzzCorpus: ok`.

- [ ] **Step 6: Commit documentation of the fuzz workflow**

Append to `daml-packages/daml-abi/README.md` (add a new `## Fuzz testing` section):

````markdown
## Fuzz testing

Seed-based property fuzzing using viem as oracle. Generate a corpus of
random valid + adversarial inputs and run the Daml decoder against them.

```bash
# Full pipeline with a random seed (logged to stdout)
pnpm fuzz

# Reproduce a specific failure
FUZZ_SEED=1729 FUZZ_N=2000 pnpm fuzz:gen
pnpm fuzz:daml
```
````

Generated corpus is written to `daml/FuzzCorpus.daml` and is gitignored.
Assertions cover: viem oracle parity for valid inputs, rejection of malformed
inputs (truncated, dirty-address, overlong-length, unaligned-offset, bad-UTF-8),
slot-alignment invariant, and length monotonicity.

````

```bash
git add daml-packages/daml-abi/README.md
git commit -m "docs(daml-abi): document fuzz workflow"
````

---

### Task 11: (Stretch) fast-check shrinker harness for TS-side differential fuzzing

**Files:**

- Create: `daml-packages/daml-abi/test/fuzz/shrink.test.ts`
- Modify: `daml-packages/daml-abi/package.json` (add fast-check)

This task is optional. It adds automatic shrinking **on the TS side only** — useful when the Daml corpus finds a bug and you want a minimal reproducer. Because each shrink iteration costs a full `dpm test` run, this is a "when-a-bug-surfaces" tool, not a per-commit check.

- [ ] **Step 1: Add fast-check**

```bash
pnpm --filter @canton/daml-abi add -D fast-check@^3.23.1
```

- [ ] **Step 2: Write the shrinker harness**

Create `daml-packages/daml-abi/test/fuzz/shrink.test.ts`:

```typescript
import { describe, test, expect } from "vitest";
import fc from "fast-check";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { emitDamlCorpus } from "./emit.js";
import type { FuzzCase } from "./types.js";

// This file is OPT-IN: set FUZZ_SHRINK=1 to enable. It's skipped by default
// because each shrink iteration runs `dpm test` and takes ~10s.
const ENABLED = process.env.FUZZ_SHRINK === "1";

function runDaml(hexCases: FuzzCase[]): "pass" | "fail" {
  writeFileSync("daml/FuzzCorpus.daml", emitDamlCorpus(hexCases, 0));
  try {
    execSync("dpm test --files daml/TestFuzz.daml", { stdio: "pipe" });
    return "pass";
  } catch {
    return "fail";
  }
}

describe.skipIf(!ENABLED)("shrink — only runs with FUZZ_SHRINK=1", () => {
  test("find minimal malformed-bytes payload that evades rejection", async () => {
    // fast-check shrinks to the minimum failing input.
    // Use fc.hexa() to generate lowercase hex; assemble a bytes encoding.
    await fc.assert(
      fc.asyncProperty(fc.hexaString({ minLength: 2, maxLength: 512 }), async (payloadHex) => {
        const hex =
          "0".repeat(62) +
          "20" + // offset=32
          (payloadHex.length / 2).toString(16).padStart(64, "0") + // length
          payloadHex.padEnd(64, "0"); // payload
        const cases: FuzzCase[] = [{ kind: "MalformedTruncated", hex }];
        // Property: the Daml decoder must reject this as malformed
        expect(runDaml(cases)).toBe("pass");
      }),
      { numRuns: 50, seed: Number(process.env.FUZZ_SEED ?? 42) },
    );
  }, 600_000);
});
```

- [ ] **Step 3: Verify the harness is skipped by default**

```bash
cd daml-packages/daml-abi && pnpm test
```

Expected: `shrink.test.ts` shows `skipped` for the describe block.

- [ ] **Step 4: Smoke test with `FUZZ_SHRINK=1`**

```bash
cd daml-packages/daml-abi && FUZZ_SHRINK=1 pnpm test -- shrink.test.ts
```

Expected: runs up to 50 iterations against the Daml decoder; passes if the decoder rejects every shrunk malformed payload.

- [ ] **Step 5: Commit**

```bash
git add daml-packages/daml-abi/test/fuzz/shrink.test.ts daml-packages/daml-abi/package.json pnpm-lock.yaml
git commit -m "feat(daml-abi): optional fast-check shrinker for fuzz repros"
```

---

## Self-Review Notes

- **Spec coverage:** Tasks 1–9 cover the TS generator, Daml consumer, malformed-rejection assertions, and universal invariants from the original sketch. Task 10 adds the planted-bug sanity check. Task 11 adds the shrinker.
- **TDD:** Every task that introduces TS code follows the full write-test / fail / implement / pass / commit cycle. Daml tasks follow the same cycle at the integration level (`dpm test` fails → Daml file added → passes).
- **DRY / YAGNI:** Shared PRNG, case type, and emitter are factored into single files. Shrinker is gated behind an env var rather than running unconditionally.
- **Type consistency:** `FuzzCase["kind"]` values in TS (`"ValidUint256"`, etc.) match Daml ADT constructor names (`ValidUint256`, etc.) one-to-one. Every valid case stores `(hex, expected)`; every malformed case stores `(hex)`. Task 7 introduces the exact constructor names; Tasks 8–11 use only those names.
- **Commit messages:** Conventional commits, <72-char subject, imperative mood, no AI attribution (per user CLAUDE.md).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-daml-abi-fuzzing.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

import { describe, it, expect } from "vitest";
import { keccak256, toBytes } from "viem";
import { recoverAddress } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { signEvmTxHash, signMpcResponse } from "../src/mpc-service/signer.js";
import { computeResponseHash } from "../src/mpc/crypto.js";
import { chainIdHexToCaip2 } from "../src/mpc/address-derivation.js";

// Hardhat account #0 — well-known test key
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

// Arbitrary 32-byte hash for signing tests
const TEST_TX_HASH = keccak256(toBytes("test-transaction"));

describe("signEvmTxHash", () => {
  it("returns r, s, v with correct formats", () => {
    const { r, s, v } = signEvmTxHash(TEST_PRIVATE_KEY, TEST_TX_HASH);

    // r and s are 64 hex chars (32 bytes), bare hex without 0x
    expect(r).toMatch(/^[0-9a-f]{64}$/);
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    // v is recovery id: 0 or 1
    expect([0, 1]).toContain(v);
  });

  it("is deterministic", () => {
    const sig1 = signEvmTxHash(TEST_PRIVATE_KEY, TEST_TX_HASH);
    const sig2 = signEvmTxHash(TEST_PRIVATE_KEY, TEST_TX_HASH);

    expect(sig1).toEqual(sig2);
  });

  it("recovers to the correct address", async () => {
    const sig = signEvmTxHash(TEST_PRIVATE_KEY, TEST_TX_HASH);
    const expectedAddress = privateKeyToAddress(TEST_PRIVATE_KEY);
    const recovered = await recoverAddress({
      hash: TEST_TX_HASH,
      signature: {
        r: `0x${sig.r}`,
        s: `0x${sig.s}`,
        v: BigInt(sig.v === 0 ? 27 : 28),
      },
    });
    expect(recovered.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });
});

describe("signMpcResponse", () => {
  // Bare hex values (no 0x) matching the function's expected input format
  const requestId = "abcd".padStart(64, "0");
  const mpcOutput = "deadbeef";

  it("returns CantonSignature with DER-encoded hex starting with '30'", () => {
    const sig = signMpcResponse(TEST_PRIVATE_KEY, requestId, mpcOutput);

    expect(sig.tag).toBe("EcdsaSig");
    // DER-encoded ECDSA signature starts with SEQUENCE tag 0x30
    expect(sig.value.der.startsWith("30")).toBe(true);
    // DER is bare hex (no 0x prefix)
    expect(sig.value.der.startsWith("0x")).toBe(false);
    // Must be valid hex
    expect(sig.value.der).toMatch(/^[0-9a-f]+$/);
    // recoveryId must be 0 or 1
    expect([0, 1]).toContain(sig.value.recoveryId);
  });

  it("is deterministic", () => {
    const sig1 = signMpcResponse(TEST_PRIVATE_KEY, requestId, mpcOutput);
    const sig2 = signMpcResponse(TEST_PRIVATE_KEY, requestId, mpcOutput);

    expect(sig1).toEqual(sig2);
  });

  it("verifies against the root public key", () => {
    const sig = signMpcResponse(TEST_PRIVATE_KEY, requestId, mpcOutput);
    const derBytes = Uint8Array.from(Buffer.from(sig.value.der, "hex"));
    // Derive uncompressed public key from the private key
    const pubKey = secp256k1.getPublicKey(toBytes(TEST_PRIVATE_KEY), false);
    // Compute the response hash the same way the function does internally
    const responseHash = computeResponseHash(requestId, mpcOutput);
    // v2.0 verify: DER format + prehash: false since responseHash is already keccak256'd
    expect(
      secp256k1.verify(derBytes, toBytes(responseHash), pubKey, {
        format: "der",
        prehash: false,
      }),
    ).toBe(true);
  });
});

describe("chainIdHexToCaip2", () => {
  it("converts Sepolia chain ID (left-padded)", () => {
    // Sepolia = 11155111 = 0xaa36a7, padded to 64 hex chars
    const sepoliaHex = "aa36a7".padStart(64, "0");
    expect(chainIdHexToCaip2(sepoliaHex)).toBe("eip155:11155111");
  });

  it("converts mainnet chain ID (left-padded)", () => {
    const mainnetHex = "1".padStart(64, "0");
    expect(chainIdHexToCaip2(mainnetHex)).toBe("eip155:1");
  });

  it("handles short hex without padding", () => {
    expect(chainIdHexToCaip2("1")).toBe("eip155:1");
  });
});

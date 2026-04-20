import { describe, it, expect } from "vitest";
import { computeRequestId, computeResponseHash, type EvmTransactionParams } from "canton-sig";

const sampleEvmParams: EvmTransactionParams = {
  to: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  functionSignature: "transfer(address,uint256)",
  encodedArgs:
    "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045" +
    "0000000000000000000000000000000000000000000000000000000005f5e100",
  value: "0000000000000000000000000000000000000000000000000000000000000000",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas: "00000000000000000000000000000000000000000000000000000001dcd65000",
  maxPriorityFeePerGas: "000000000000000000000000000000000000000000000000000000003b9aca00",
  chainId: "0000000000000000000000000000000000000000000000000000000000aa36a7",
};

const SENDER = "Issuer::1220abcdef";
const CAIP2_ID = "eip155:11155111";
const KEY_VERSION = 1;
const PATH = "m/44/60/0/0";

// ---------------------------------------------------------------------------
// Cross-language vectors (must match Daml TestRequestId.daml)
// computeResponseHash is the exact-value cross-check; computeRequestId is
// verified structurally + via the e2e tests, since both sides use the same
// concat-keccak256 formulation.
// ---------------------------------------------------------------------------
const VECTORS = {
  responseHash01: "0x0344a8df5db02fe0579ff283081b60d9e6f3956594facfc6ea2befd5890366f4",
  responseHashEmpty: "0x20ee8f1366f06926e9e8771d8fb9007a8537c8dfdb6a3f8c2cfd64db19d2ec90",
};

const KNOWN_REQUEST_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// computeRequestId
// ---------------------------------------------------------------------------
describe("computeRequestId", () => {
  it("returns a 32-byte hex hash", () => {
    const rid = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    expect(rid).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const a = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    const b = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    expect(a).toBe(b);
  });

  it("changes with different sender (operator set)", () => {
    const a = computeRequestId(
      "operatorSetA",
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    const b = computeRequestId(
      "operatorSetB",
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    expect(a).not.toBe(b);
  });

  it("changes with different params", () => {
    const a = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "params-a",
    );
    const b = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "params-b",
    );
    expect(a).not.toBe(b);
  });

  it("changes with different keyVersion", () => {
    const a = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      1,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    const b = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      256,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    expect(a).not.toBe(b);
  });

  it("changes with empty encodedArgs", () => {
    const emptyArgsParams = { ...sampleEvmParams, encodedArgs: "" };
    const a = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      1,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    const b = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: emptyArgsParams },
      CAIP2_ID,
      1,
      PATH,
      "ECDSA",
      "ethereum",
      "",
    );
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// computeResponseHash
// ---------------------------------------------------------------------------
describe("computeResponseHash", () => {
  it("matches cross-language vector (mpcOutput=01)", () => {
    expect(computeResponseHash(KNOWN_REQUEST_ID, "01")).toBe(VECTORS.responseHash01);
  });

  it("matches cross-language vector (empty mpcOutput)", () => {
    expect(computeResponseHash(KNOWN_REQUEST_ID, "")).toBe(VECTORS.responseHashEmpty);
  });

  it("is deterministic", () => {
    const a = computeResponseHash(KNOWN_REQUEST_ID, "01");
    const b = computeResponseHash(KNOWN_REQUEST_ID, "01");
    expect(a).toBe(b);
  });

  it("changes with different output", () => {
    const a = computeResponseHash(KNOWN_REQUEST_ID, "01");
    const b = computeResponseHash(KNOWN_REQUEST_ID, "00");
    expect(a).not.toBe(b);
  });
});

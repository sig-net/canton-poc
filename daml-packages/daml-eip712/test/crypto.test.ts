import { describe, it, expect } from "vitest";
import { computeRequestId, computeResponseHash, type EvmTransactionParams } from "canton-sig";

const sampleEvmParams: EvmTransactionParams = {
  to: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  functionSignature: "transfer(address,uint256)",
  args: [
    "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045",
    "0000000000000000000000000000000000000000000000000000000005f5e100",
  ],
  value: "0000000000000000000000000000000000000000000000000000000000000000",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
  maxFeePerGas: "00000000000000000000000000000000000000000000000000000001dcd65000",
  maxPriorityFee: "000000000000000000000000000000000000000000000000000000003b9aca00",
  chainId: "0000000000000000000000000000000000000000000000000000000000aa36a7",
};

const SENDER = "Issuer::1220abcdef";
const CAIP2_ID = "eip155:11155111";
const KEY_VERSION = 1;
const PATH = "m/44/60/0/0";

// ---------------------------------------------------------------------------
// Cross-language vectors (must match Daml TestRequestId.daml)
// Uses flat keccak256(concat(encoded fields)) — no EIP-712 domain/type hashes.
// ---------------------------------------------------------------------------
const VECTORS = {
  requestIdKv1: "0xab592010331a78defa4ba5f84daf1bb95b0f2572da0cc3e16f9f52b7e98d702d",
  responseHash01: "0xe4f5b08c4c816896be4b121dad39b8910c8a0875ef14f1a1275a037416fea55d",
  responseHashEmpty: "0x411ab826623d7ba0be7b366112614d65632617e47325d33ec2cbfbf89186f775",
};

const KNOWN_REQUEST_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// computeRequestId
// ---------------------------------------------------------------------------
describe("computeRequestId", () => {
  it("matches golden vector (kv=1)", () => {
    const rid = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "",
      "",
    );
    expect(rid).toBe(VECTORS.requestIdKv1);
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
      "",
    );
    expect(a).toBe(b);
  });

  it("changes with different nonceCidText", () => {
    const a = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      KEY_VERSION,
      PATH,
      "ECDSA",
      "ethereum",
      "",
      "nonce1",
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
      "nonce2",
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
      "params-b",
      "",
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
      "",
    );
    expect(a).not.toBe(b);
  });

  it("changes with empty args", () => {
    const emptyArgsParams = { ...sampleEvmParams, args: [] as string[] };
    const a = computeRequestId(
      SENDER,
      { tag: "EvmTxParams", value: sampleEvmParams },
      CAIP2_ID,
      1,
      PATH,
      "ECDSA",
      "ethereum",
      "",
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

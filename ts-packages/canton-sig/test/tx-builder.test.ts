import { describe, it, expect } from "vitest";
import { parseTransaction, type Hex } from "viem";
import {
  buildCalldata,
  buildTxRequest,
  serializeUnsignedTx,
  reconstructSignedTx,
  type CantonEvmParams,
} from "canton-sig";

// Matches Daml TestFixtures.sampleEvmParams exactly
const sampleEvmParams: CantonEvmParams = {
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

describe("buildCalldata", () => {
  it("produces 4-byte selector + concatenated args", () => {
    const data = buildCalldata(
      sampleEvmParams.functionSignature,
      sampleEvmParams.args.map((a): Hex => `0x${a}`),
    );
    // transfer(address,uint256) selector = 0xa9059cbb
    expect(data).toMatch(/^0xa9059cbb/);
    // 4 bytes selector + 2 x 32 bytes args = 68 bytes = 136 hex chars + "0x" prefix
    expect(data.length).toBe(2 + 136);
  });

  it("returns just the selector when args are empty", () => {
    const data = buildCalldata("transfer(address,uint256)", []);
    expect(data).toMatch(/^0xa9059cbb$/);
    expect(data.length).toBe(2 + 8); // "0x" + 4-byte selector
  });
});

describe("buildTxRequest", () => {
  it("converts Canton hex params to viem EIP-1559 fields", () => {
    const tx = buildTxRequest(sampleEvmParams);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(11155111);
    expect(tx.nonce).toBe(1);
    expect(tx.maxFeePerGas).toBe(8000000000n);
    expect(tx.maxPriorityFeePerGas).toBe(1000000000n);
    expect(tx.gas).toBe(50000n);
    expect(tx.value).toBe(0n);
    expect(tx.to).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(tx.accessList).toEqual([]);
    // calldata = 0xa9059cbb + arg0 + arg1
    const expectedData =
      "0xa9059cbb" +
      "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045" +
      "0000000000000000000000000000000000000000000000000000000005f5e100";
    expect(tx.data).toBe(expectedData);
  });
});

describe("serializeUnsignedTx", () => {
  it("returns an RLP-encoded hex string starting with 0x02 (EIP-1559 type)", () => {
    const raw = serializeUnsignedTx(sampleEvmParams);
    expect(raw).toMatch(/^0x02/);
    // Should be a valid hex string
    expect(raw).toMatch(/^0x[0-9a-f]+$/);
  });

  it("round-trips through parseTransaction", () => {
    const serialized = serializeUnsignedTx(sampleEvmParams);
    const parsed = parseTransaction(serialized);
    expect(parsed.chainId).toBe(11155111);
    expect(parsed.nonce).toBe(1);
    expect(parsed.gas).toBe(50000n);
  });
});

describe("reconstructSignedTx", () => {
  it("returns a longer RLP blob than the unsigned tx (includes signature)", () => {
    const unsigned = serializeUnsignedTx(sampleEvmParams);
    const signed = reconstructSignedTx(sampleEvmParams, {
      r: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      s: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      v: 0,
    });
    expect(signed).toMatch(/^0x02/);
    expect(signed.length).toBeGreaterThan(unsigned.length);
  });

  it("embeds signature that can be parsed back by viem", () => {
    const r = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
    const s = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
    const v = 1;

    const signed = reconstructSignedTx(sampleEvmParams, { r, s, v });
    const parsed = parseTransaction(signed);

    expect(parsed.r).toBe(r);
    expect(parsed.s).toBe(s);
    expect(parsed.yParity).toBe(v);
    expect(parsed.chainId).toBe(11155111);
  });
});

import { describe, it, expect } from "vitest";
import { parseTransaction, type Hex } from "viem";
import {
  buildTxRequest,
  serializeUnsignedTx,
  reconstructSignedTx,
  type CantonEvmType2Params,
} from "../src/evm/tx-builder.js";

// Matches Daml TestFixtures.sampleEvmType2Params exactly.
const sampleEvmType2Params: CantonEvmType2Params = {
  chainId: "0000000000000000000000000000000000000000000000000000000000aa36a7",
  nonce: "0000000000000000000000000000000000000000000000000000000000000001",
  maxPriorityFeePerGas: "000000000000000000000000000000000000000000000000000000003b9aca00",
  maxFeePerGas: "00000000000000000000000000000000000000000000000000000001dcd65000",
  gasLimit: "000000000000000000000000000000000000000000000000000000000000c350",
  to: "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  value: "0000000000000000000000000000000000000000000000000000000000000000",
  calldata:
    "a9059cbb" +
    "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045" +
    "0000000000000000000000000000000000000000000000000000000005f5e100",
  accessList: [],
};

const sampleEthTransferParams: CantonEvmType2Params = {
  ...sampleEvmType2Params,
  nonce: "0000000000000000000000000000000000000000000000000000000000000002",
  gasLimit: "0000000000000000000000000000000000000000000000000000000000005208",
  to: "1111111111111111111111111111111111111111",
  value: "00000000000000000000000000000000000000000000000000038d7ea4c68000",
  calldata: "",
};

const sampleAccessListParams: CantonEvmType2Params = {
  ...sampleEvmType2Params,
  accessList: [
    {
      address: "2222222222222222222222222222222222222222",
      storageKeys: [
        "0000000000000000000000000000000000000000000000000000000000000000",
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      ],
    },
  ],
};

describe("buildTxRequest", () => {
  it("converts Canton hex params without narrowing 256-bit fields", () => {
    const tx = buildTxRequest(sampleEvmType2Params);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(11155111n);
    expect(tx.nonce).toBe(1n);
    expect(tx.maxFeePerGas).toBe(8000000000n);
    expect(tx.maxPriorityFeePerGas).toBe(1000000000n);
    expect(tx.gas).toBe(50000n);
    expect(tx.value).toBe(0n);
    expect(tx.to).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(tx.accessList).toEqual([]);
    expect(tx.data).toBe(
      "0xa9059cbb" +
        "000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045" +
        "0000000000000000000000000000000000000000000000000000000005f5e100",
    );
  });

  it("represents contract creation with no recipient", () => {
    const tx = buildTxRequest({ ...sampleEvmType2Params, to: null });
    expect(tx.to).toBeNull();
  });
});

describe("serializeUnsignedTx", () => {
  it("returns an RLP-encoded hex string starting with 0x02", () => {
    const raw = serializeUnsignedTx(sampleEvmType2Params);
    expect(raw).toMatch(/^0x02/);
    expect(raw).toMatch(/^0x[0-9a-f]+$/);
  });

  it("round-trips normal EIP-1559 fields through viem", () => {
    const serialized = serializeUnsignedTx(sampleEvmType2Params);
    const parsed = parseTransaction(serialized);
    expect(parsed.chainId).toBe(11155111);
    expect(parsed.nonce).toBe(1);
    expect(parsed.gas).toBe(50000n);
    expect(parsed.data).toBe(`0x${sampleEvmType2Params.calldata}`);
  });

  it("supports plain ETH transfers with empty calldata", () => {
    const serialized = serializeUnsignedTx(sampleEthTransferParams);
    const parsed = parseTransaction(serialized);
    expect(parsed.to).toBe("0x1111111111111111111111111111111111111111");
    expect(parsed.value).toBe(1000000000000000n);
    expect(parsed.data ?? "0x").toBe("0x");
  });

  it("serializes access lists", () => {
    const serialized = serializeUnsignedTx(sampleAccessListParams);
    const parsed = parseTransaction(serialized);
    expect(parsed.accessList).toEqual([
      {
        address: "0x2222222222222222222222222222222222222222",
        storageKeys: [
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        ],
      },
    ]);
  });

  it("does not reject valid 256-bit quantity values", () => {
    const maxUint256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const serialized = serializeUnsignedTx({
      ...sampleEvmType2Params,
      chainId: maxUint256,
      nonce: maxUint256,
      maxPriorityFeePerGas: maxUint256,
      maxFeePerGas: maxUint256,
      gasLimit: maxUint256,
      value: maxUint256,
    });
    expect(serialized).toMatch(/^0x02/);
  });
});

describe("reconstructSignedTx", () => {
  it("returns a longer RLP blob than the unsigned tx", () => {
    const unsigned = serializeUnsignedTx(sampleEvmType2Params);
    const signed = reconstructSignedTx(sampleEvmType2Params, {
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

    const signed = reconstructSignedTx(sampleEvmType2Params, { r, s, v });
    const parsed = parseTransaction(signed);

    expect(parsed.r).toBe(r);
    expect(parsed.s).toBe(s);
    expect(parsed.yParity).toBe(v);
    expect(parsed.chainId).toBe(11155111);
  });
});

import {
  createPublicClient,
  http,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { sepolia } from "viem/chains";
import { cantonHexToHex } from "./hex.js";

export interface CantonEvmAccessListEntry {
  address: string;
  storageKeys: string[];
}

/** Canton-format EIP-1559 params (lowercase canonical hex, no 0x prefix). Daml validates shapes upstream. */
export interface CantonEvmType2Params {
  chainId: string;
  nonce: string;
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  gasLimit: string;
  to: string | null;
  value: string;
  calldata: string;
  accessList: CantonEvmAccessListEntry[];
}

/** Decoded EIP-1559 fields. chainId is bigint to admit the full Canton uint256 domain (viem narrows to number). */
export interface Eip1559TxFields {
  type: "eip1559";
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  to: Hex | null;
  value: bigint;
  data: Hex;
  accessList: { address: Hex; storageKeys: Hex[] }[];
}

const toBig = (hex: string): bigint => BigInt(`0x${hex || "0"}`);

export function buildTxRequest(p: CantonEvmType2Params): Eip1559TxFields {
  return {
    type: "eip1559",
    chainId: toBig(p.chainId),
    nonce: toBig(p.nonce),
    maxPriorityFeePerGas: toBig(p.maxPriorityFeePerGas),
    maxFeePerGas: toBig(p.maxFeePerGas),
    gas: toBig(p.gasLimit),
    to: p.to === null ? null : `0x${p.to}`,
    value: toBig(p.value),
    data: cantonHexToHex(p.calldata),
    accessList: p.accessList.map((e) => ({
      address: `0x${e.address}`,
      storageKeys: e.storageKeys.map((k): Hex => `0x${k}`),
    })),
  };
}

// viem's TS narrows chainId to `number`; runtime numberToHex accepts bigint, so casting at the call site is a pure type escape.
export function serializeUnsignedTx(p: CantonEvmType2Params): Hex {
  return serializeTransaction(buildTxRequest(p) as unknown as TransactionSerializableEIP1559);
}

export function reconstructSignedTx(
  p: CantonEvmType2Params,
  signature: { r: Hex; s: Hex; v: number },
): Hex {
  if (signature.v !== 0 && signature.v !== 1) {
    throw new Error("EIP-1559 yParity must be 0 or 1");
  }
  return serializeTransaction(buildTxRequest(p) as unknown as TransactionSerializableEIP1559, {
    r: signature.r,
    s: signature.s,
    yParity: signature.v,
  });
}

export async function submitRawTransaction(rpcUrl: string, raw: Hex): Promise<Hex> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  return client.sendRawTransaction({ serializedTransaction: raw });
}

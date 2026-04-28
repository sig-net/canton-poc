import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";

export interface CantonEvmAccessListEntry {
  address: string;
  storageKeys: string[];
}

/** Canton-format EIP-1559 transaction params (hex strings without 0x prefix). */
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

function assertHexNoPrefix(field: string, value: string): void {
  if (value.length % 2 !== 0) throw new Error(`${field} must have an even hex length`);
  if (!/^[0-9a-fA-F]*$/.test(value)) throw new Error(`${field} must be hex without 0x prefix`);
}

function normalizeHex(field: string, value: string): string {
  assertHexNoPrefix(field, value);
  return value.toLowerCase();
}

function toHexValue(field: string, value: string): Hex {
  const normalized = normalizeHex(field, value);
  return normalized === "" ? "0x" : `0x${normalized}`;
}

function toQuantityHex(field: string, value: string): string {
  const normalized = normalizeHex(field, value).replace(/^0+/, "");
  return normalized === "" ? "" : normalized.length % 2 === 0 ? normalized : `0${normalized}`;
}

function toBigIntQuantity(field: string, value: string): bigint {
  const normalized = normalizeHex(field, value).replace(/^0+/, "") || "0";
  return BigInt(`0x${normalized}`);
}

function assertFixedBytes(field: string, value: string, byteLength: number): string {
  const normalized = normalizeHex(field, value);
  if (normalized.length !== byteLength * 2) {
    throw new Error(`${field} must be ${byteLength} bytes`);
  }
  return normalized;
}

function encodeLength(length: number, offset: number): string {
  if (length <= 55) return (offset + length).toString(16).padStart(2, "0");
  const rawLengthHex = length.toString(16);
  const lengthHex = rawLengthHex.length % 2 === 0 ? rawLengthHex : `0${rawLengthHex}`;
  const lengthOfLength = lengthHex.length / 2;
  return (offset + 55 + lengthOfLength).toString(16).padStart(2, "0") + lengthHex;
}

function rlpBytes(hexNoPrefix: string): string {
  const normalized = normalizeHex("rlp bytes", hexNoPrefix);
  const byteLength = normalized.length / 2;
  if (byteLength === 1 && Number.parseInt(normalized, 16) < 0x80) return normalized;
  return encodeLength(byteLength, 0x80) + normalized;
}

function rlpList(encodedItems: string[]): string {
  const payload = encodedItems.join("");
  return encodeLength(payload.length / 2, 0xc0) + payload;
}

function encodeAccessList(accessList: CantonEvmAccessListEntry[]): string {
  return rlpList(
    accessList.map((entry, entryIndex) => {
      const address = assertFixedBytes(`accessList[${entryIndex}].address`, entry.address, 20);
      const storageKeys = rlpList(
        entry.storageKeys.map((storageKey, storageKeyIndex) =>
          rlpBytes(
            assertFixedBytes(
              `accessList[${entryIndex}].storageKeys[${storageKeyIndex}]`,
              storageKey,
              32,
            ),
          ),
        ),
      );
      return rlpList([rlpBytes(address), storageKeys]);
    }),
  );
}

function encodeTxPayload(
  evmParams: CantonEvmType2Params,
  signature?: { r: Hex; s: Hex; v: number },
): string {
  const to = evmParams.to === null ? "" : assertFixedBytes("to", evmParams.to, 20);

  const fields = [
    rlpBytes(toQuantityHex("chainId", evmParams.chainId)),
    rlpBytes(toQuantityHex("nonce", evmParams.nonce)),
    rlpBytes(toQuantityHex("maxPriorityFeePerGas", evmParams.maxPriorityFeePerGas)),
    rlpBytes(toQuantityHex("maxFeePerGas", evmParams.maxFeePerGas)),
    rlpBytes(toQuantityHex("gasLimit", evmParams.gasLimit)),
    rlpBytes(to),
    rlpBytes(toQuantityHex("value", evmParams.value)),
    rlpBytes(normalizeHex("calldata", evmParams.calldata)),
    encodeAccessList(evmParams.accessList),
  ];

  if (signature !== undefined) {
    if (signature.v !== 0 && signature.v !== 1) {
      throw new Error("EIP-1559 yParity must be 0 or 1");
    }
    fields.push(
      rlpBytes(signature.v === 0 ? "" : "01"),
      rlpBytes(toQuantityHex("signature.r", signature.r.slice(2))),
      rlpBytes(toQuantityHex("signature.s", signature.s.slice(2))),
    );
  }

  return rlpList(fields);
}

/** Build a decoded, non-viem EIP-1559 view from CantonEvmType2Params. */
export function buildTxRequest(evmParams: CantonEvmType2Params): Eip1559TxFields {
  return {
    type: "eip1559",
    chainId: toBigIntQuantity("chainId", evmParams.chainId),
    nonce: toBigIntQuantity("nonce", evmParams.nonce),
    maxPriorityFeePerGas: toBigIntQuantity("maxPriorityFeePerGas", evmParams.maxPriorityFeePerGas),
    maxFeePerGas: toBigIntQuantity("maxFeePerGas", evmParams.maxFeePerGas),
    gas: toBigIntQuantity("gasLimit", evmParams.gasLimit),
    to: evmParams.to === null ? null : toHexValue("to", assertFixedBytes("to", evmParams.to, 20)),
    value: toBigIntQuantity("value", evmParams.value),
    data: toHexValue("calldata", evmParams.calldata),
    accessList: evmParams.accessList.map((entry, entryIndex) => ({
      address: toHexValue(
        `accessList[${entryIndex}].address`,
        assertFixedBytes(`accessList[${entryIndex}].address`, entry.address, 20),
      ),
      storageKeys: entry.storageKeys.map((storageKey, storageKeyIndex) =>
        toHexValue(
          `accessList[${entryIndex}].storageKeys[${storageKeyIndex}]`,
          assertFixedBytes(
            `accessList[${entryIndex}].storageKeys[${storageKeyIndex}]`,
            storageKey,
            32,
          ),
        ),
      ),
    })),
  };
}

/** Serialize an unsigned EIP-1559 tx from CantonEvmType2Params. */
export function serializeUnsignedTx(evmParams: CantonEvmType2Params): Hex {
  return `0x02${encodeTxPayload(evmParams)}`;
}

/** Append signature to produce a signed EIP-1559 tx. */
export function reconstructSignedTx(
  evmParams: CantonEvmType2Params,
  signature: { r: Hex; s: Hex; v: number },
): Hex {
  return `0x02${encodeTxPayload(evmParams, signature)}`;
}

/** Submit raw signed tx to Ethereum RPC. */
export async function submitRawTransaction(rpcUrl: string, raw: Hex): Promise<Hex> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  const hash = await client.request({
    method: "eth_sendRawTransaction",
    params: [raw],
  });
  return hash;
}

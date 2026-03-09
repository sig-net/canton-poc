import { keccak256, stringToHex, hashTypedData, type Hex } from "viem";

export interface EvmTransactionParams {
  to: string;
  functionSignature: string;
  args: string[];
  value: string;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFee: string;
  chainId: string;
}

// ---------------------------------------------------------------------------
// EIP-712 type definitions and domain
// ---------------------------------------------------------------------------

export const eip712Types = {
  EvmTransactionParams: [
    { name: "to", type: "address" },
    { name: "functionSignature", type: "string" },
    { name: "args", type: "bytes[]" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "gasLimit", type: "uint256" },
    { name: "maxFeePerGas", type: "uint256" },
    { name: "maxPriorityFee", type: "uint256" },
    { name: "chainId", type: "uint256" },
  ],
  CantonMpcDepositRequest: [
    { name: "sender", type: "string" },
    { name: "evmParams", type: "EvmTransactionParams" },
    { name: "caip2Id", type: "string" },
    { name: "keyVersion", type: "uint32" },
    { name: "path", type: "string" },
    { name: "algo", type: "string" },
    { name: "dest", type: "string" },
    { name: "authCidText", type: "string" },
  ],
  CantonMpcResponse: [
    { name: "requestId", type: "bytes32" },
    { name: "mpcOutput", type: "bytes" },
  ],
} as const;

export const eip712Domain = {
  name: "CantonMpc",
  version: "1",
} as const;

// ---------------------------------------------------------------------------
// EIP-712 struct hash for EvmTransactionParams (cross-language testing)
// ---------------------------------------------------------------------------

const EVM_PARAMS_TYPE_HASH = keccak256(
  stringToHex(
    "EvmTransactionParams(address to,string functionSignature,bytes[] args,uint256 value,uint256 nonce,uint256 gasLimit,uint256 maxFeePerGas,uint256 maxPriorityFee,uint256 chainId)",
  ),
).slice(2);

function hashText(t: string): string {
  return keccak256(stringToHex(t)).slice(2);
}

function hashBytesList(xs: string[]): string {
  if (xs.length === 0) return keccak256("0x").slice(2);
  const inner = xs.map((x) => keccak256(`0x${x}`).slice(2)).join("");
  return keccak256(`0x${inner}`).slice(2);
}

function padHex(hex: string, bytes: number): string {
  return hex.padStart(bytes * 2, "0").slice(-(bytes * 2));
}

/**
 * EIP-712 struct hash for EvmTransactionParams.
 * Mirrors Daml's hashEvmParams in Crypto.daml.
 */
export function hashEvmParams(p: EvmTransactionParams): string {
  const preimage =
    EVM_PARAMS_TYPE_HASH +
    padHex(p.to, 32) +
    hashText(p.functionSignature) +
    hashBytesList(p.args) +
    padHex(p.value, 32) +
    padHex(p.nonce, 32) +
    padHex(p.gasLimit, 32) +
    padHex(p.maxFeePerGas, 32) +
    padHex(p.maxPriorityFee, 32) +
    padHex(p.chainId, 32);
  return keccak256(`0x${preimage}`).slice(2);
}

// ---------------------------------------------------------------------------
// EIP-712 typed data hashing (viem)
// ---------------------------------------------------------------------------

function toEvmParamsMessage(p: EvmTransactionParams) {
  const to: Hex = `0x${p.to}`;
  return {
    to,
    functionSignature: p.functionSignature,
    args: p.args.map((a): Hex => `0x${a}`),
    value: BigInt(`0x${p.value}`),
    nonce: BigInt(`0x${p.nonce}`),
    gasLimit: BigInt(`0x${p.gasLimit}`),
    maxFeePerGas: BigInt(`0x${p.maxFeePerGas}`),
    maxPriorityFee: BigInt(`0x${p.maxPriorityFee}`),
    chainId: BigInt(`0x${p.chainId}`),
  };
}

/**
 * Compute request_id using EIP-712 typed data hashing.
 * Mirrors Daml's computeRequestId in Crypto.daml.
 */
export function computeRequestId(
  sender: string,
  evmParams: EvmTransactionParams,
  caip2Id: string,
  keyVersion: number,
  path: string,
  algo: string,
  dest: string,
  authCidText: string,
): Hex {
  return hashTypedData({
    domain: eip712Domain,
    types: eip712Types,
    primaryType: "CantonMpcDepositRequest",
    message: {
      sender,
      evmParams: toEvmParamsMessage(evmParams),
      caip2Id,
      keyVersion,
      path,
      algo,
      dest,
      authCidText,
    },
  });
}

/**
 * Compute response_hash using EIP-712 typed data hashing.
 * Mirrors Daml's computeResponseHash in Crypto.daml.
 */
export function computeResponseHash(requestId: string, mpcOutput: string): Hex {
  return hashTypedData({
    domain: eip712Domain,
    types: eip712Types,
    primaryType: "CantonMpcResponse",
    message: {
      requestId: `0x${requestId}` as const,
      mpcOutput: `0x${mpcOutput}` as const,
    },
  });
}

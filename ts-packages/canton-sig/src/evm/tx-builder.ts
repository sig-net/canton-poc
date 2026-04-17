import {
  serializeTransaction,
  toFunctionSelector,
  concat,
  createPublicClient,
  http,
  hexToBigInt,
  hexToNumber,
  type Hex,
  type TransactionSerializableEIP1559,
} from "viem";
import { sepolia } from "viem/chains";

/** Canton-format EVM transaction params (hex strings without 0x prefix) */
export interface CantonEvmParams {
  to: string;
  functionSignature: string;
  encodedArgs: string;
  value: string;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFee: string;
  chainId: string;
}

/** Reconstruct calldata from functionSignature + encodedArgs */
export function buildCalldata(functionSignature: string, encodedArgs: string): Hex {
  const selector = toFunctionSelector(`function ${functionSignature}`);
  if (!encodedArgs) return selector;
  const argsHex: Hex = encodedArgs.startsWith("0x")
    ? (encodedArgs as Hex)
    : `0x${encodedArgs}`;
  return concat([selector, argsHex]);
}

/** Build a viem-compatible EIP-1559 tx request from CantonEvmParams */
export function buildTxRequest(evmParams: CantonEvmParams): TransactionSerializableEIP1559 {
  return {
    type: "eip1559",
    chainId: hexToNumber(`0x${evmParams.chainId}`),
    nonce: hexToNumber(`0x${evmParams.nonce}`),
    maxPriorityFeePerGas: hexToBigInt(`0x${evmParams.maxPriorityFee}`),
    maxFeePerGas: hexToBigInt(`0x${evmParams.maxFeePerGas}`),
    gas: hexToBigInt(`0x${evmParams.gasLimit}`),
    to: `0x${evmParams.to}`,
    value: hexToBigInt(`0x${evmParams.value}`),
    data: buildCalldata(evmParams.functionSignature, evmParams.encodedArgs),
    accessList: [],
  };
}

/** Serialize an unsigned EIP-1559 tx from CantonEvmParams */
export function serializeUnsignedTx(evmParams: CantonEvmParams): Hex {
  return serializeTransaction(buildTxRequest(evmParams));
}

/** Append signature to produce a signed EIP-1559 tx */
export function reconstructSignedTx(
  evmParams: CantonEvmParams,
  signature: { r: Hex; s: Hex; v: number },
): Hex {
  return serializeTransaction(buildTxRequest(evmParams), {
    r: signature.r,
    s: signature.s,
    yParity: signature.v,
  });
}

/** Submit raw signed tx to Ethereum RPC */
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

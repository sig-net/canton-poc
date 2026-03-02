import {
  serializeTransaction,
  toFunctionSelector,
  concat,
  createPublicClient,
  http,
  hexToBigInt,
  hexToNumber,
  type Hex,
} from "viem";
import { sepolia } from "viem/chains";

/** Canton-format EVM transaction params (hex strings without 0x prefix) */
export interface CantonEvmParams {
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

/** Reconstruct calldata from functionSignature + args */
function buildCalldata(functionSignature: string, args: Hex[]): Hex {
  const selector = toFunctionSelector(`function ${functionSignature}`);
  // args are already ABI-encoded (32 bytes each), just concatenate
  const encodedArgs =
    args.length > 0 ? concat(args.map((a): Hex => (a.startsWith("0x") ? a : `0x${a}`))) : "0x";
  return concat([selector, encodedArgs]);
}

/** Serialize an unsigned EIP-1559 tx from CantonEvmParams */
export function serializeUnsignedTx(evmParams: CantonEvmParams): Hex {
  const calldata = buildCalldata(
    evmParams.functionSignature,
    evmParams.args.map((a): Hex => `0x${a}`),
  );

  return serializeTransaction({
    type: "eip1559",
    chainId: hexToNumber(`0x${evmParams.chainId}`),
    nonce: hexToNumber(`0x${evmParams.nonce}`),
    maxPriorityFeePerGas: hexToBigInt(`0x${evmParams.maxPriorityFee}`),
    maxFeePerGas: hexToBigInt(`0x${evmParams.maxFeePerGas}`),
    gas: hexToBigInt(`0x${evmParams.gasLimit}`),
    to: `0x${evmParams.to}`,
    value: hexToBigInt(`0x${evmParams.value}`),
    data: calldata,
    accessList: [],
  });
}

/** Reconstruct full signed EVM tx from evmParams + signature */
export function reconstructSignedTx(
  evmParams: CantonEvmParams,
  signature: { r: Hex; s: Hex; v: number },
): Hex {
  const calldata = buildCalldata(
    evmParams.functionSignature,
    evmParams.args.map((a): Hex => `0x${a}`),
  );

  return serializeTransaction(
    {
      type: "eip1559",
      chainId: hexToNumber(`0x${evmParams.chainId}`),
      nonce: hexToNumber(`0x${evmParams.nonce}`),
      maxPriorityFeePerGas: hexToBigInt(`0x${evmParams.maxPriorityFee}`),
      maxFeePerGas: hexToBigInt(`0x${evmParams.maxFeePerGas}`),
      gas: hexToBigInt(`0x${evmParams.gasLimit}`),
      to: `0x${evmParams.to}`,
      value: hexToBigInt(`0x${evmParams.value}`),
      data: calldata,
      accessList: [],
    },
    {
      r: signature.r,
      s: signature.s,
      yParity: signature.v,
    },
  );
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

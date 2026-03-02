import { createPublicClient, http, type Hex, parseAbi, numberToHex } from "viem";
import { sepolia } from "viem/chains";

/**
 * Get the current nonce for an address on Sepolia.
 */
export async function fetchNonce(rpcUrl: string, address: Hex): Promise<number> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  return client.getTransactionCount({ address });
}

/**
 * Get current gas parameters from Sepolia.
 */
export async function fetchGasParams(
  rpcUrl: string,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const block = await client.getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = 1_000_000_000n; // 1 gwei
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/**
 * Check ERC20 balance of an address.
 */
export async function checkErc20Balance(rpcUrl: string, token: Hex, address: Hex): Promise<bigint> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const balance = await client.readContract({
    address: token,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [address],
  });
  return balance;
}

/**
 * Convert a value to Canton's padded hex format (no 0x prefix).
 */
export function toCantonHex(value: bigint | number, bytes: number): string {
  return numberToHex(BigInt(value), { size: bytes }).slice(2);
}

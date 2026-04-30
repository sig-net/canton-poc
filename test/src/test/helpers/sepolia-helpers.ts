import { createPublicClient, createWalletClient, http, type Hex, parseAbi } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export { toCantonHex } from "canton-sig";

export const DEPOSIT_AMOUNT = 1_000_000_000_000_000n; // 0.001 DAI (18 decimals)
const FAUCET_ETH_AMOUNT = 2_000_000_000_000_000n; // 0.002 ETH (~2x ERC20 transfer cost)

const sepoliaPublicClient = (rpcUrl: string) =>
  createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

/** Get the current nonce for an address on Sepolia. */
export async function fetchNonce(rpcUrl: string, address: Hex): Promise<number> {
  return sepoliaPublicClient(rpcUrl).getTransactionCount({ address });
}

/** Get current gas parameters from Sepolia. */
export async function fetchGasParams(
  rpcUrl: string,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await sepoliaPublicClient(rpcUrl).getBlock({ blockTag: "latest" });
  const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
  const maxPriorityFeePerGas = 1_000_000_000n; // 1 gwei
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Check ERC20 balance of an address. */
export async function checkErc20Balance(rpcUrl: string, token: Hex, address: Hex): Promise<bigint> {
  return sepoliaPublicClient(rpcUrl).readContract({
    address: token,
    abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
    functionName: "balanceOf",
    args: [address],
  });
}

/**
 * Fund the target address from a faucet account with ETH (for gas) and ERC20 tokens.
 * Idempotent — skips transfers if target already has sufficient funds.
 */
export async function fundFromFaucet(
  rpcUrl: string,
  faucetPrivateKey: Hex,
  target: Hex,
  erc20Address: Hex,
  erc20Amount: bigint,
): Promise<void> {
  const account = privateKeyToAccount(faucetPrivateKey);
  const publicClient = sepoliaPublicClient(rpcUrl);
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpcUrl) });

  // Fund ETH if below threshold
  const ethBalance = await publicClient.getBalance({ address: target });
  if (ethBalance < FAUCET_ETH_AMOUNT) {
    console.log(`[faucet] Sending ${FAUCET_ETH_AMOUNT} wei ETH to ${target}...`);
    const ethTxHash = await walletClient.sendTransaction({
      to: target,
      value: FAUCET_ETH_AMOUNT,
    });
    await publicClient.waitForTransactionReceipt({ hash: ethTxHash });
    console.log(`[faucet] ETH funded (tx: ${ethTxHash})`);
  } else {
    console.log(`[faucet] ETH sufficient (${ethBalance} wei >= ${FAUCET_ETH_AMOUNT} wei)`);
  }

  // Fund ERC20 if below threshold
  const erc20Balance = await checkErc20Balance(rpcUrl, erc20Address, target);
  if (erc20Balance < erc20Amount) {
    console.log(`[faucet] Sending ${erc20Amount} ERC20 to ${target}...`);
    const erc20TxHash = await walletClient.writeContract({
      address: erc20Address,
      abi: parseAbi(["function transfer(address,uint256) returns (bool)"]),
      functionName: "transfer",
      args: [target, erc20Amount],
    });
    await publicClient.waitForTransactionReceipt({ hash: erc20TxHash });
    console.log(`[faucet] ERC20 funded (tx: ${erc20TxHash})`);
  } else {
    console.log(`[faucet] ERC20 sufficient (${erc20Balance} >= ${erc20Amount})`);
  }
}

/**
 * Pre-flight script for Sepolia e2e test.
 *
 * Connects to Canton, allocates the fixed parties used by the test,
 * derives the deposit address, and prints what needs to be funded.
 *
 * Usage: pnpm sepolia:preflight
 *
 * Requires:
 *   - Canton sandbox running (pnpm daml:sandbox)
 *   - MPC_ROOT_PUBLIC_KEY env var set
 *   - SEPOLIA_RPC_URL env var set (for balance checks)
 *   - ERC20_ADDRESS env var (optional, defaults to test USDC)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { uploadDar, allocateParty } from "../infra/canton-client.js";
import { deriveDepositAddress } from "../mpc/address-derivation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");

const MPC_ROOT_PUBLIC_KEY = process.env.MPC_ROOT_PUBLIC_KEY;
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
const ERC20_ADDRESS = (process.env.ERC20_ADDRESS ??
  "0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D") as Hex;
const PATH = "m/44/60/0/0";
const DEPOSIT_AMOUNT = 100_000_000n;

async function main() {
  if (!MPC_ROOT_PUBLIC_KEY) {
    console.error("MPC_ROOT_PUBLIC_KEY env var is required");
    process.exit(1);
  }

  console.log("── Sepolia E2E Pre-flight ──\n");

  await uploadDar(DAR_PATH);
  const depositor = await allocateParty("SepoliaDepositor");
  console.log(`Canton depositor party: ${depositor}`);

  const depositAddress = deriveDepositAddress(MPC_ROOT_PUBLIC_KEY, depositor, PATH);

  console.log("\n── Addresses to fund on Sepolia ──\n");
  console.log(`  Deposit address: ${depositAddress}`);
  console.log(`    - ERC20 tokens (${ERC20_ADDRESS}): >= ${DEPOSIT_AMOUNT} (smallest unit)`);
  console.log(`    - ETH for gas: ~0.01 ETH`);

  if (SEPOLIA_RPC_URL) {
    console.log("\n── Current balances ──\n");
    const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });

    const ethBalance = await client.getBalance({ address: depositAddress });
    console.log(`  ETH: ${ethBalance} wei (${Number(ethBalance) / 1e18} ETH)`);

    const erc20Balance = await client.readContract({
      address: ERC20_ADDRESS,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [depositAddress],
    });
    console.log(`  ERC20 (${ERC20_ADDRESS}): ${erc20Balance}`);

    const ethOk = ethBalance > 0n;
    const erc20Ok = erc20Balance >= DEPOSIT_AMOUNT;

    console.log("\n── Status ──\n");
    console.log(`  ETH:   ${ethOk ? "OK" : "NEEDS FUNDING"}`);
    console.log(`  ERC20: ${erc20Ok ? "OK" : "NEEDS FUNDING"}`);

    if (ethOk && erc20Ok) {
      console.log("\n  Ready to run: pnpm test:e2e:sepolia");
    }
  } else {
    console.log("\n  Set SEPOLIA_RPC_URL to check live balances.");
  }
}

main().catch((err) => {
  console.error("Pre-flight failed:", err);
  process.exit(1);
});

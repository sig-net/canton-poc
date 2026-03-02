import { type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { utils } from "signet.js";

const { deriveChildPublicKey } = utils.cryptography;

/**
 * CAIP-2 chain identifier used for MPC key derivation.
 *
 * Key derivation uses `eip155:1` (supported by signet.js) regardless of the
 * target EVM chain. This matches the solana-contract-examples pattern where
 * key derivation uses the MPC home chain's CAIP-2 ID, not the target chain.
 * The target chain's CAIP-2 ID (`eip155:11155111` for Sepolia) is used
 * separately in requestId computation.
 */
export const KEY_DERIVATION_CAIP2 = "eip155:1";
export const KEY_VERSION = 1;

/**
 * Derive an Ethereum deposit address from MPC root key + derivation params.
 */
export function deriveDepositAddress(
  rootPubKey: string, // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string,
  path: string,
): Hex {
  const childPubKey = deriveChildPublicKey(
    rootPubKey as `04${string}`,
    predecessorId,
    path,
    KEY_DERIVATION_CAIP2,
    KEY_VERSION,
  );
  return publicKeyToAddress(`0x${childPubKey}`);
}

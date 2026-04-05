import { type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { utils } from "signet.js";

const { deriveChildPublicKey } = utils.cryptography;

/**
 * Canton source chain ID for KDF derivation.
 * The KDF always uses the SOURCE chain (where the request originates).
 * Must match Chain::Canton.caip2_chain_id() in the Rust MPC node.
 */
const KDF_CHAIN_ID = "canton:global";

export const KEY_VERSION = 1;

/**
 * Derive an Ethereum deposit address from MPC root key + derivation params.
 * Uses canton:global for KDF (Canton source chain ID).
 */
export function deriveDepositAddress(
  rootPubKey: string, // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string,
  path: string,
  keyVersion = KEY_VERSION,
): Hex {
  const childPubKey = deriveChildPublicKey(
    rootPubKey as `04${string}`,
    predecessorId,
    path,
    KDF_CHAIN_ID,
    keyVersion,
  );
  return publicKeyToAddress(`0x${childPubKey}`);
}

/**
 * Convert chainId hex (with or without left padding) to CAIP-2 text.
 * Example: "000...aa36a7" -> "eip155:11155111".
 */
export function chainIdHexToCaip2(chainIdHex: string): string {
  const normalized = chainIdHex.replace(/^0+/, "") || "0";
  return `eip155:${BigInt(`0x${normalized}`).toString()}`;
}

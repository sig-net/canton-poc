import { type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";
import { utils } from "signet.js";

const { deriveChildPublicKey } = utils.cryptography;

/**
 * Derive an Ethereum deposit address from MPC root key + derivation params.
 */
export function deriveDepositAddress(
  rootPubKey: string, // "04..." uncompressed secp256k1 (no 0x)
  predecessorId: string,
  path: string,
  caip2Id: string,
  keyVersion: number,
): Hex {
  const childPubKey = deriveChildPublicKey(
    rootPubKey as `04${string}`,
    predecessorId,
    path,
    caip2Id,
    keyVersion,
  );
  return publicKeyToAddress(`0x${childPubKey}`);
}

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { DER } from "@noble/curves/abstract/weierstrass.js";
import { keccak256, toBytes, numberToHex, type Hex } from "viem";
import { sign } from "viem/accounts";
import { computeResponseHash } from "../mpc/crypto.js";

import { constants } from "signet.js";

const EPSILON_DERIVATION_PREFIX = "sig.network v2.0.0 epsilon derivation";
// KDF binds to SOURCE chain (canton:global), NOT destination EVM — must match Chain::Canton.caip2_chain_id() in Rust MPC node
const KDF_CHAIN_ID = constants.KDF_CHAIN_IDS.CANTON;

/** secp256k1 curve order (n). */
const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

/**
 * Derive a child private key for signing EVM transactions.
 * childKey = (rootPrivateKey + epsilon) mod n
 * where epsilon = keccak256("{prefix}:canton:global:{predecessorId}:{path}")
 */
export function deriveChildPrivateKey(
  rootPrivateKey: Hex,
  predecessorId: string,
  path: string,
): Hex {
  const derivationPath = `${EPSILON_DERIVATION_PREFIX}:${KDF_CHAIN_ID}:${predecessorId}:${path}`;
  const epsilon = keccak256(toBytes(derivationPath));

  const rootKey = BigInt(rootPrivateKey);
  const eps = BigInt(epsilon);
  const childKey = (((rootKey + eps) % CURVE_ORDER) + CURVE_ORDER) % CURVE_ORDER;

  return numberToHex(childKey, { size: 32 });
}

/**
 * Sign an EVM transaction hash with a secp256k1 private key.
 * Returns { r, s, v } as bare hex (no 0x) for Canton's EcdsaSignature; v is the recovery id (0 or 1).
 */
export async function signEvmTxHash(
  privateKey: Hex,
  txHash: Hex,
): Promise<{ r: string; s: string; v: number }> {
  const sig = await sign({ hash: txHash, privateKey });
  return { r: sig.r.slice(2), s: sig.s.slice(2), v: sig.yParity ?? 0 };
}

/** Canton Signature union type */
type CantonSignature = { tag: "EcdsaSig"; value: { der: string; recoveryId: number } };

/**
 * Sign the MPC response with the ROOT key (not the child). responseHash = keccak256(requestId ‖ mpcOutput).
 * requestId transitively encodes operatorsHash (via `sender`), so the signature binds to the full operator set.
 */
export async function signMpcResponse(
  rootPrivateKey: Hex,
  requestId: string,
  mpcOutput: string,
): Promise<CantonSignature> {
  const sig = await sign({
    hash: computeResponseHash(requestId, mpcOutput),
    privateKey: rootPrivateKey,
  });
  // DER: Daml's secp256k1WithEcdsaOnly builtin only accepts DER-encoded sigs (no (r,s) variant)
  const der = DER.hexFromSig({ r: BigInt(sig.r), s: BigInt(sig.s) });
  return { tag: "EcdsaSig", value: { der, recoveryId: sig.yParity ?? 0 } };
}

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { DER } from "@noble/curves/abstract/weierstrass.js";
import { keccak256, toBytes, toHex, numberToHex, hexToBigInt, type Hex } from "viem";
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
 * Returns { r, s, v } as bare hex (no 0x) for Canton's EcdsaSignature.
 *
 * Uses @noble/curves v2.0 'recovered' format: [v, r_32bytes, s_32bytes].
 */
export function signEvmTxHash(privateKey: Hex, txHash: Hex): { r: string; s: string; v: number } {
  const msgHash = toBytes(txHash);
  const privKeyBytes = toBytes(privateKey);

  // 'recovered' format: Uint8Array(65) = [recovery_byte, r_32, s_32]
  // prehash: false because txHash is already keccak256'd
  const sig = secp256k1.sign(msgHash, privKeyBytes, {
    format: "recovered",
    prehash: false,
  });

  const v = sig[0]!;
  const r = toHex(sig.slice(1, 33)).slice(2);
  const s = toHex(sig.slice(33, 65)).slice(2);

  return { r, s, v };
}

/** Canton Signature union type */
type CantonSignature = { tag: "EcdsaSig"; value: { der: string; recoveryId: number } };

/**
 * Sign the MPC response with the ROOT key (not the child). responseHash = keccak256(requestId ‖ mpcOutput).
 * requestId transitively encodes operatorsHash (via `sender`), so the signature binds to the full operator set.
 */
export function signMpcResponse(
  rootPrivateKey: Hex,
  requestId: string,
  mpcOutput: string,
): CantonSignature {
  // requestId and mpcOutput are bare hex (no 0x)
  const responseHash = computeResponseHash(requestId, mpcOutput);
  const msgHash = toBytes(responseHash);
  const privKeyBytes = toBytes(rootPrivateKey);

  // 'recovered' format: Uint8Array(65) = [recovery_byte, r_32, s_32]
  const sig = secp256k1.sign(msgHash, privKeyBytes, { format: "recovered", prehash: false });
  const recoveryId = sig[0]!;
  const r = hexToBigInt(toHex(sig.slice(1, 33)));
  const s = hexToBigInt(toHex(sig.slice(33, 65)));

  // DER: Daml's secp256k1WithEcdsaOnly builtin only accepts DER-encoded sigs (no (r,s) variant)
  const der = DER.hexFromSig({ r, s });
  return { tag: "EcdsaSig", value: { der, recoveryId } };
}

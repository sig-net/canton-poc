import { keccak256, toHex, toBytes, pad, concat, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export interface EvmTransactionParams {
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

// ---------------------------------------------------------------------------
// Encoding helpers — mirror Daml's Eip712.daml primitives
// ---------------------------------------------------------------------------

/** keccak256(utf8(text)) — mirrors Daml's hashText */
function hashText(text: string): Hex {
  if (text === "") return keccak256("0x");
  return keccak256(toHex(text));
}

/** Left-pad hex to 32 bytes — mirrors Daml's padLeft */
function padLeft32(hex: Hex): Hex {
  return pad(hex, { size: 32 });
}

/** keccak256(concat(map keccak256 xs)) — mirrors Daml's hashBytesList */
function hashBytesList(items: Hex[]): Hex {
  if (items.length === 0) return keccak256("0x");
  const hashes = items.map((item) => keccak256(item));
  return keccak256(concat(hashes));
}

// ---------------------------------------------------------------------------
// Flat keccak256(concat(encoded fields)) — mirrors Daml's RequestId.daml
// ---------------------------------------------------------------------------

function hashEvmParams(p: EvmTransactionParams): Hex {
  return keccak256(
    concat([
      padLeft32(`0x${p.to}`),
      hashText(p.functionSignature),
      hashBytesList(p.args.map((a): Hex => `0x${a}`)),
      padLeft32(`0x${p.value}`),
      padLeft32(`0x${p.nonce}`),
      padLeft32(`0x${p.gasLimit}`),
      padLeft32(`0x${p.maxFeePerGas}`),
      padLeft32(`0x${p.maxPriorityFee}`),
      padLeft32(`0x${p.chainId}`),
    ]),
  );
}

/**
 * Compute request_id using flat keccak256(concat(encoded fields)).
 * Mirrors Daml's computeRequestId in RequestId.daml.
 */
export function computeRequestId(
  sender: string,
  evmParams: EvmTransactionParams,
  caip2Id: string,
  keyVersion: number,
  path: string,
  algo: string,
  dest: string,
  params: string,
  nonceCidText: string,
): Hex {
  return keccak256(
    concat([
      hashText(sender),
      hashEvmParams(evmParams),
      hashText(caip2Id),
      padLeft32(toHex(keyVersion)),
      hashText(path),
      hashText(algo),
      hashText(dest),
      hashText(params),
      hashText(nonceCidText),
    ]),
  );
}

/**
 * Compute response_hash using flat keccak256(requestId || keccak256(mpcOutput)).
 * Mirrors Daml's computeResponseHash in RequestId.daml.
 */
export function computeResponseHash(requestId: string, mpcOutput: string): Hex {
  const requestIdBytes: Hex = `0x${requestId}`;
  const outputHash = mpcOutput === "" ? keccak256("0x") : keccak256(`0x${mpcOutput}`);
  return keccak256(concat([requestIdBytes, outputHash]));
}

// ---------------------------------------------------------------------------
// Key encoding
// ---------------------------------------------------------------------------

/**
 * Derive the SPKI-encoded public key from an uncompressed secp256k1 public key.
 * Matches the format used by Canton's Signer.mpcPublicKey field.
 */
export function toSpkiPublicKey(uncompressedPubKey: string): string {
  const pubKeyBytes = toBytes(`0x${uncompressedPubKey}`);

  // secp256k1 SPKI header: SEQUENCE { SEQUENCE { OID ecPublicKey, OID secp256k1 }, BIT STRING }
  const spkiHeader = new Uint8Array([
    0x30,
    0x56, // SEQUENCE (86 bytes)
    0x30,
    0x10, // SEQUENCE (16 bytes)
    0x06,
    0x07,
    0x2a,
    0x86,
    0x48,
    0xce,
    0x3d,
    0x02,
    0x01, // OID ecPublicKey
    0x06,
    0x05,
    0x2b,
    0x81,
    0x04,
    0x00,
    0x0a, // OID secp256k1
    0x03,
    0x42,
    0x00, // BIT STRING (66 bytes, 0 unused bits)
    0x04, // uncompressed point marker
  ]);

  // Remove the 0x04 prefix from pubKeyBytes since spkiHeader already includes it
  const rawPoint = pubKeyBytes.slice(1);
  const spki = new Uint8Array(spkiHeader.length + rawPoint.length);
  spki.set(spkiHeader);
  spki.set(rawPoint, spkiHeader.length);

  return toHex(spki).slice(2);
}

/**
 * Derive the uncompressed public key from a private key.
 */
export function derivePublicKey(privateKey: Hex): string {
  const pubKeyBytes = secp256k1.getPublicKey(toBytes(privateKey), false);
  return toHex(pubKeyBytes).slice(2);
}

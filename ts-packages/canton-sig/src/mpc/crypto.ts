import { keccak256, toHex, toBytes, pad, concat, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export interface EvmTransactionParams {
  to: string;
  functionSignature: string;
  encodedArgs: string;
  value: string;
  nonce: string;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFee: string;
  chainId: string;
}

export type TxParams = { tag: "EvmTxParams"; value: EvmTransactionParams };

// ---------------------------------------------------------------------------
// EIP-712 primitive encoding — mirrors Daml's Eip712.daml
// ---------------------------------------------------------------------------

/** EIP-712 string encoding: keccak256(utf8(text)). */
function eip712EncodeString(text: string): Hex {
  if (text === "") return keccak256("0x");
  return keccak256(toHex(text));
}

/** EIP-712 uint256 encoding: left-pad hex to 32 bytes. */
function eip712EncodeUint256(hex: Hex): Hex {
  return pad(hex, { size: 32 });
}

/** EIP-712 address encoding: left-pad hex to 32 bytes. */
function eip712EncodeAddress(hex: Hex): Hex {
  return pad(hex, { size: 32 });
}

/** EIP-712 bytes encoding: keccak256(raw bytes). */
function eip712EncodeBytes(data: Hex): Hex {
  if (data === "0x") return keccak256("0x");
  return keccak256(data);
}

// ---------------------------------------------------------------------------
// Flat keccak256(concat(encoded fields)) — mirrors Daml's RequestId.daml
// ---------------------------------------------------------------------------

function hashTxParams(cp: TxParams): Hex {
  switch (cp.tag) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhaustive switch for future BTC/SOL variants
    case "EvmTxParams":
      return hashEvmParams(cp.value);
  }
}

function hashEvmParams(p: EvmTransactionParams): Hex {
  return keccak256(
    concat([
      eip712EncodeAddress(`0x${p.to}`),
      eip712EncodeString(p.functionSignature),
      eip712EncodeBytes(p.encodedArgs === "" ? "0x" : `0x${p.encodedArgs}`),
      eip712EncodeUint256(`0x${p.value}`),
      eip712EncodeUint256(`0x${p.nonce}`),
      eip712EncodeUint256(`0x${p.gasLimit}`),
      eip712EncodeUint256(`0x${p.maxFeePerGas}`),
      eip712EncodeUint256(`0x${p.maxPriorityFee}`),
      eip712EncodeUint256(`0x${p.chainId}`),
    ]),
  );
}

/**
 * Compute request_id using flat keccak256(concat(encoded fields)).
 * Mirrors Daml's computeRequestId in RequestId.daml.
 */
export function computeRequestId(
  sender: string,
  txParams: TxParams,
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
      eip712EncodeString(sender),
      hashTxParams(txParams),
      eip712EncodeString(caip2Id),
      eip712EncodeUint256(toHex(keyVersion)),
      eip712EncodeString(path),
      eip712EncodeString(algo),
      eip712EncodeString(dest),
      eip712EncodeString(params),
      eip712EncodeString(nonceCidText),
    ]),
  );
}

/**
 * Compute response_hash using flat keccak256(requestId || keccak256(mpcOutput)).
 * Mirrors Daml's computeResponseHash in RequestId.daml.
 */
export function computeResponseHash(requestId: string, mpcOutput: string): Hex {
  const requestIdBytes: Hex = `0x${requestId}`;
  const outputHash = eip712EncodeBytes(mpcOutput === "" ? "0x" : `0x${mpcOutput}`);
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

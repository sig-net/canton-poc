import { keccak256, toHex, toBytes, pad, concat, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export interface EvmAccessListEntry {
  address: string;
  storageKeys: string[];
}

export interface EvmType2TransactionParams {
  chainId: string;
  nonce: string;
  maxPriorityFeePerGas: string;
  maxFeePerGas: string;
  gasLimit: string;
  to: string | null;
  value: string;
  calldata: string;
  accessList: EvmAccessListEntry[];
}

export type TxParams = { tag: "EvmType2TxParams"; value: EvmType2TransactionParams };

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

function hexBytes(hex: string): Hex {
  return hex === "" ? "0x" : `0x${hex}`;
}

function hashOptionalAddress(address: string | null): Hex {
  return address === null ? eip712EncodeBytes("0x") : eip712EncodeAddress(`0x${address}`);
}

function hashStorageKeys(storageKeys: string[]): Hex {
  if (storageKeys.length === 0) return keccak256("0x");
  return keccak256(concat(storageKeys.map((storageKey) => hexBytes(storageKey))));
}

function hashAccessListEntry(entry: EvmAccessListEntry): Hex {
  return keccak256(
    concat([eip712EncodeAddress(`0x${entry.address}`), hashStorageKeys(entry.storageKeys)]),
  );
}

function hashAccessList(accessList: EvmAccessListEntry[]): Hex {
  if (accessList.length === 0) return keccak256("0x");
  return keccak256(concat(accessList.map(hashAccessListEntry)));
}

// ---------------------------------------------------------------------------
// Flat keccak256(concat(encoded fields)) — mirrors Daml's RequestId.daml
// ---------------------------------------------------------------------------

function hashTxParams(cp: TxParams): Hex {
  switch (cp.tag) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhaustive switch for future BTC/SOL variants
    case "EvmType2TxParams":
      return hashEvmType2Params(cp.value);
  }
}

export function hashEvmType2Params(p: EvmType2TransactionParams): Hex {
  return keccak256(
    concat([
      eip712EncodeUint256(`0x${p.chainId}`),
      eip712EncodeUint256(`0x${p.nonce}`),
      eip712EncodeUint256(`0x${p.maxPriorityFeePerGas}`),
      eip712EncodeUint256(`0x${p.maxFeePerGas}`),
      eip712EncodeUint256(`0x${p.gasLimit}`),
      hashOptionalAddress(p.to),
      eip712EncodeUint256(`0x${p.value}`),
      eip712EncodeBytes(hexBytes(p.calldata)),
      hashAccessList(p.accessList),
    ]),
  );
}

/**
 * Compute request_id using flat keccak256(concat(encoded fields)).
 * Three-way consistency required: must match Daml RequestId.daml and Rust indexer_canton::generate_request_id() byte-for-byte.
 */
export function computeRequestId(
  sender: string, // operatorsHash, set on-ledger by SignRequest.Execute (NOT user-supplied)
  txParams: TxParams,
  caip2Id: string,
  keyVersion: number,
  path: string,
  algo: string,
  dest: string,
  params: string,
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
    ]),
  );
}

/**
 * Compute response_hash = keccak256(requestId ‖ mpcOutput).
 * Matches MPC node (respond_bidirectional.rs) and Solana (erc20_vault.rs); mirrored by Daml RequestId.daml.
 */
export function computeResponseHash(requestId: string, mpcOutput: string): Hex {
  const requestIdBytes: Hex = `0x${requestId}`;
  const outputBytes: Hex = mpcOutput === "" ? "0x" : `0x${mpcOutput}`;
  return keccak256(concat([requestIdBytes, outputBytes]));
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

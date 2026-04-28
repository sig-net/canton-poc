import { numberToHex, type Hex } from "viem";

/** Convert Canton-format hex (lowercase, no 0x prefix; "" for empty) into a viem Hex. */
export function cantonHexToHex(hex: string): Hex {
  return hex === "" ? "0x" : `0x${hex}`;
}

/** Encode a number/bigint as Canton-format hex: left-padded to `bytes`, no 0x prefix. */
export function toCantonHex(value: bigint | number, bytes: number): string {
  return numberToHex(BigInt(value), { size: bytes }).slice(2);
}

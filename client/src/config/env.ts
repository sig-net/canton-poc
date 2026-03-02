import * as z from "zod";
import { type Hex } from "viem";

const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "Must be a 0x-prefixed hex string") as z.ZodType<Hex>;

const EnvConfigSchema = z.object({
  CANTON_JSON_API_URL: z.url().default("http://localhost:7575"),
  SEPOLIA_RPC_URL: z.url(),
  MPC_ROOT_PUBLIC_KEY: z
    .string()
    .regex(/^04[0-9a-fA-F]{128}$/, "Must be uncompressed secp256k1 public key (no 0x)"),
  SEPOLIA_CHAIN_ID: z.literal(11155111),
  CAIP2_ID: z.literal("eip155:11155111"),
  KEY_VERSION: z.literal(1),
  ERC20_ADDRESS: hex,
});

const MpcEnvConfigSchema = EnvConfigSchema.extend({
  MPC_ROOT_PRIVATE_KEY: hex,
});

type EnvConfig = z.infer<typeof EnvConfigSchema>;
type MpcEnvConfig = z.infer<typeof MpcEnvConfigSchema>;

export function loadEnvConfig(): EnvConfig {
  return EnvConfigSchema.parse({
    CANTON_JSON_API_URL: process.env.CANTON_JSON_API_URL,
    SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL,
    MPC_ROOT_PUBLIC_KEY: process.env.MPC_ROOT_PUBLIC_KEY,
    SEPOLIA_CHAIN_ID: 11155111,
    CAIP2_ID: "eip155:11155111",
    KEY_VERSION: 1,
    ERC20_ADDRESS: process.env.ERC20_ADDRESS ?? "0xbe72E441BF55620febc26715db68d3494213D8Cb",
  });
}

export function loadMpcEnvConfig(): MpcEnvConfig {
  return MpcEnvConfigSchema.parse({
    ...loadEnvConfig(),
    MPC_ROOT_PRIVATE_KEY: process.env.MPC_ROOT_PRIVATE_KEY,
  });
}

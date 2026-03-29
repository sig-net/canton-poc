import {
  keccak256,
  createPublicClient,
  http,
  hexToNumber,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  serializeUnsignedTx,
  reconstructSignedTx,
  buildCalldata,
  type CantonEvmParams,
} from "../evm/tx-builder.js";
import { deriveChildPrivateKey, signEvmTxHash, signMpcResponse } from "./signer.js";
import {
  CantonClient,
  type CreatedEvent,
  type TransactionResponse,
} from "../infra/canton-client.js";
import { computeRequestId, type EvmTransactionParams } from "../mpc/crypto.js";
import { chainIdHexToCaip2 } from "../mpc/address-derivation.js";
import {
  VaultOrchestrator,
  type PendingEvmTx,
} from "@daml.js/daml-vault-0.0.1/lib/Erc20Vault/module";

const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MpcServiceConfig {
  canton: CantonClient;
  orchCid: string;
  userId: string;
  actAs: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
}

export interface PendingTx {
  requestId: string;
  requester: string;
  signedTxHash: Hex;
  fromAddress: Hex;
  nonce: number;
  checkCount: number;
  evmParams: CantonEvmParams;
}

type CheckResult = "pending" | "done" | "failed";

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return (
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  );
}

// ---------------------------------------------------------------------------
// Retry wrapper for Canton exerciseChoice
// ---------------------------------------------------------------------------

async function exerciseChoiceWithRetry(
  canton: CantonClient,
  userId: string,
  actAs: string[],
  templateId: string,
  contractId: string,
  choice: string,
  choiceArgument: Record<string, unknown>,
  maxAttempts = 3,
): Promise<TransactionResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await canton.exerciseChoice(
        userId,
        actAs,
        templateId,
        contractId,
        choice,
        choiceArgument,
      );
    } catch (err) {
      if (!isTransientError(err) || attempt === maxAttempts) throw err;
      const delay = 1000 * 2 ** (attempt - 1);
      console.warn(
        `[MPC] Canton transient error (${choice}), retry ${attempt}/${maxAttempts} in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// Phase 1: Sign and enqueue (tx-type agnostic)
// ---------------------------------------------------------------------------

export async function signAndEnqueue(
  config: MpcServiceConfig,
  event: CreatedEvent,
): Promise<PendingTx> {
  const { canton, orchCid, userId, actAs, rootPrivateKey } = config;
  const {
    requester,
    path: requestPath,
    requestId: contractRequestId,
    evmParams,
    issuer,
    vaultId,
    nonceCidText,
    keyVersion,
    algo,
    dest,
  } = event.createArgument as PendingEvmTx;

  const predecessorId = `${vaultId}${issuer}`;

  // Validate requestId
  const caip2Id = chainIdHexToCaip2(evmParams.chainId);
  const computedRequestId = computeRequestId(
    requester,
    evmParams as EvmTransactionParams,
    caip2Id,
    Number(keyVersion),
    requestPath,
    algo,
    dest,
    nonceCidText,
  );
  if (computedRequestId.slice(2) !== contractRequestId) {
    throw new Error(
      `requestId mismatch: computed=${computedRequestId.slice(2)} contract=${contractRequestId}`,
    );
  }
  const requestId = computedRequestId.slice(2);

  console.log(`[MPC] Processing PendingEvmTx requestId=${requestId}`);

  // Derive child key and sender address
  const childPrivateKey = deriveChildPrivateKey(rootPrivateKey, predecessorId, requestPath);
  const fromAddress = privateKeyToAddress(childPrivateKey);
  const txNonce = hexToNumber(`0x${evmParams.nonce}`);

  // Sign EVM transaction
  const serializedUnsigned = serializeUnsignedTx(evmParams);
  const txHash = keccak256(serializedUnsigned);
  const { r, s, v } = signEvmTxHash(childPrivateKey, txHash);

  console.log(`[MPC] Signing EVM tx, exercising SignEvmTx`);
  await exerciseChoiceWithRetry(canton, userId, actAs, VAULT_ORCHESTRATOR, orchCid, "SignEvmTx", {
    requester,
    requestId,
    r,
    s,
    v,
  });
  console.log(`[MPC] SignEvmTx exercised`);

  // Compute signed tx hash for monitoring
  const signedTx = reconstructSignedTx(evmParams, {
    r: `0x${r}`,
    s: `0x${s}`,
    v,
  });
  const signedTxHash = keccak256(signedTx);

  return {
    requestId,
    requester,
    signedTxHash,
    fromAddress,
    nonce: txNonce,
    checkCount: 0,
    evmParams,
  };
}

// ---------------------------------------------------------------------------
// Return data helpers
// ---------------------------------------------------------------------------

async function extractReturnData(
  rpcUrl: string,
  tx: PendingTx,
  receipt: { blockNumber: bigint },
): Promise<string> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const calldata = buildCalldata(
    tx.evmParams.functionSignature,
    tx.evmParams.args.map((a): Hex => `0x${a}`),
  );
  const result = await client.call({
    to: `0x${tx.evmParams.to}`,
    data: calldata,
    account: tx.fromAddress,
    blockNumber: receipt.blockNumber - 1n,
  });
  return result.data!.slice(2);
}

function encodeErrorOutput(): string {
  return "deadbeef" + encodeAbiParameters([{ type: "bool" }], [true]).slice(2);
}

// ---------------------------------------------------------------------------
// Phase 2: Monitor — check receipt and report outcome (tx-type agnostic)
// ---------------------------------------------------------------------------

export async function checkPendingTx(
  config: MpcServiceConfig,
  tx: PendingTx,
): Promise<CheckResult> {
  const client = createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });

  let mpcOutput: string | null = null;

  try {
    const receipt = await client.getTransactionReceipt({ hash: tx.signedTxHash });

    if (receipt.status === "success") {
      mpcOutput = await extractReturnData(config.rpcUrl, tx, receipt);
    } else {
      mpcOutput = encodeErrorOutput();
      console.warn(`[MPC] Tx reverted: status=${receipt.status}, requestId=${tx.requestId}`);
    }
    console.log(`[MPC] Receipt found for requestId=${tx.requestId}, status=${receipt.status}`);
  } catch {
    // No receipt yet — check if nonce was consumed (tx replaced)
    try {
      const currentNonce = await client.getTransactionCount({ address: tx.fromAddress });
      if (currentNonce > tx.nonce) {
        // Double-check: maybe the receipt just appeared
        try {
          await client.getTransactionReceipt({ hash: tx.signedTxHash });
          // Receipt appeared in the race — let the next poll cycle handle it
          return "pending";
        } catch {
          console.warn(
            `[MPC] Nonce consumed but no receipt — tx replaced. requestId=${tx.requestId}`,
          );
          mpcOutput = encodeErrorOutput();
        }
      }
    } catch {
      // RPC error during nonce check — try again next cycle
      return "pending";
    }
  }

  if (mpcOutput === null) return "pending";

  // Report outcome to Canton
  return reportOutcome(config, tx, mpcOutput);
}

async function reportOutcome(
  config: MpcServiceConfig,
  tx: PendingTx,
  mpcOutput: string,
): Promise<CheckResult> {
  const signature = signMpcResponse(config.rootPrivateKey, tx.requestId, mpcOutput);

  try {
    console.log(`[MPC] Exercising ProvideEvmOutcomeSig for requestId=${tx.requestId}`);
    await exerciseChoiceWithRetry(
      config.canton,
      config.userId,
      config.actAs,
      VAULT_ORCHESTRATOR,
      config.orchCid,
      "ProvideEvmOutcomeSig",
      {
        requester: tx.requester,
        requestId: tx.requestId,
        signature,
        mpcOutput,
      },
    );
    console.log(
      `[MPC] ProvideEvmOutcomeSig exercised for requestId=${tx.requestId} (output=${mpcOutput})`,
    );
    return "done";
  } catch (err) {
    if (isTransientError(err)) {
      console.warn(
        `[MPC] Transient error reporting outcome, will retry. requestId=${tx.requestId}`,
      );
      return "pending";
    }
    console.error(
      `[MPC] Fatal error reporting outcome for requestId=${tx.requestId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "failed";
  }
}

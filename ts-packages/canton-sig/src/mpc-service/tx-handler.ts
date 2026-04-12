import {
  keccak256,
  createPublicClient,
  http,
  hexToNumber,
  hexToBigInt,
  encodeAbiParameters,
  type Hex,
} from "viem";
import { DER } from "@noble/curves/abstract/weierstrass.js";
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
  type Event,
  type TransactionResponse,
} from "../infra/canton-client.js";
import { computeRequestId } from "../mpc/crypto.js";
import { chainIdHexToCaip2 } from "../mpc/address-derivation.js";
import {
  type SignBidirectionalEvent,
  Signer,
  SigningNonce,
} from "@daml.js/daml-signer-0.0.1/lib/Signer/module";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const SIGNER_TEMPLATE = Signer.templateId;

/** Extract "Module:Template" suffix, ignoring package hash vs name prefix. */
function templateSuffix(templateId: string): string {
  const parts = templateId.split(":");
  return parts.slice(-2).join(":");
}

const SIGNING_NONCE_SUFFIX = templateSuffix(SigningNonce.templateId);

export interface MpcServiceConfig {
  canton: CantonClient;
  signerCid: string;
  userId: string;
  actAs: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
}

export interface PendingTx {
  requestId: string;
  requester: string;
  operators: string[];
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
  txEvents?: Event[],
): Promise<PendingTx> {
  const { canton, signerCid, userId, actAs, rootPrivateKey } = config;
  const arg = event.createArgument as SignBidirectionalEvent;
  const {
    requester,
    sender,
    operators,
    txParams,
    nonceCidText,
    keyVersion,
    algo,
    dest,
    params,
    path: requestPath,
  } = arg;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guard for future BTC/SOL variants
  if (txParams.tag !== 'EvmTxParams') {
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    throw new Error(`Unsupported chain params: ${txParams.tag}`);
  }
  const evmTxParams = txParams.value;

  const predecessorId = sender;

  // ---------------------------------------------------------------------------
  // Validate Canton transaction metadata (defense-in-depth).
  // In single-participant mode a malicious participant could forge both payload
  // AND metadata. In multi-participant mode, signatories/witnessParties are
  // populated from the actual confirmation protocol (each signatory's CPN
  // must confirm), making forgery detectable.
  // ---------------------------------------------------------------------------

  // 1. Check CreatedEvent.signatories — operators must be actual signatories
  const onLedgerSignatories = new Set(event.signatories ?? []);
  for (const op of operators) {
    if (!onLedgerSignatories.has(op)) {
      throw new Error(
        `Operator ${op} is in contract payload but not in ` +
          `CreatedEvent.signatories — possible forgery`,
      );
    }
  }

  // 2. Check CreatedEvent.witnessParties — operators must be witnesses
  //    (meaning their participants confirmed the transaction)
  const rawWitnesses = (event as Record<string, unknown>).witnessParties as string[] | undefined;
  const witnesses = new Set(rawWitnesses ?? []);
  for (const op of operators) {
    if (!witnesses.has(op)) {
      console.warn(
        `[MPC] Operator ${op} is not in witnessParties — ` +
          `their participant may not have confirmed this transaction`,
      );
    }
  }

  // 3. Cross-reference: requester must also be a signatory (SignBidirectionalEvent
  //    has signatory operators, requester)
  if (!onLedgerSignatories.has(requester)) {
    throw new Error(`Requester ${requester} is not in CreatedEvent.signatories — possible forgery`);
  }

  // 4. Verify nonceCidText corresponds to an archived SigningNonce in the same
  //    transaction. SigningNonce is a Signer-layer nonce (signatory: sigNetwork),
  //    archived by Signer.SignBidirectional. This ensures: (a) the nonce was
  //    actually consumed (replay prevention), and (b) it's a SigningNonce — not
  //    an arbitrary string or a different contract type.
  //    During catch-up (no txEvents), we skip this check — catch-up trusts the ledger.
  if (txEvents) {
    const archivedEvents = txEvents
      .filter((e): e is Event & { ArchivedEvent: unknown } => "ArchivedEvent" in e)
      .map(
        (e) => (e as { ArchivedEvent: { contractId: string; templateId: string } }).ArchivedEvent,
      );

    const nonceEvent = archivedEvents.find((a) => a.contractId === nonceCidText);
    if (!nonceEvent) {
      throw new Error(
        `nonceCidText ${nonceCidText} does not match any ArchivedEvent in the transaction — ` +
          `possible replay or forged nonce`,
      );
    }

    if (templateSuffix(nonceEvent.templateId) !== SIGNING_NONCE_SUFFIX) {
      throw new Error(
        `nonceCidText ${nonceCidText} was archived but its template is not SigningNonce`,
      );
    }
  }

  // Validate requestId via EIP-712 re-computation
  const caip2Id = chainIdHexToCaip2(evmTxParams.chainId);
  const computedRequestId = computeRequestId(
    sender,
    txParams,
    caip2Id,
    Number(keyVersion),
    requestPath,
    algo,
    dest,
    params,
    nonceCidText,
  );

  console.log(`[MPC] Processing SignBidirectionalEvent requestId=${computedRequestId.slice(2)}`);
  const requestId = computedRequestId.slice(2);

  // Derive child key and sender address
  const childPrivateKey = deriveChildPrivateKey(rootPrivateKey, predecessorId, requestPath);
  const fromAddress = privateKeyToAddress(childPrivateKey);
  const txNonce = hexToNumber(`0x${evmTxParams.nonce}`);

  // Sign EVM transaction
  const serializedUnsigned = serializeUnsignedTx(evmTxParams as CantonEvmParams);
  const txHash = keccak256(serializedUnsigned);
  const { r, s, v } = signEvmTxHash(childPrivateKey, txHash);

  // DER-encode the ECDSA signature for the Respond choice
  const rBigInt = hexToBigInt(`0x${r}`);
  const sBigInt = hexToBigInt(`0x${s}`);
  const derSignature = DER.hexFromSig({ r: rBigInt, s: sBigInt });

  console.log(`[MPC] Signing EVM tx, exercising Respond`);
  await exerciseChoiceWithRetry(canton, userId, actAs, SIGNER_TEMPLATE, signerCid, "Respond", {
    operators,
    requester,
    requestId,
    signature: derSignature,
  });
  console.log(`[MPC] Respond exercised`);

  // Compute signed tx hash for monitoring
  const signedTx = reconstructSignedTx(evmTxParams as CantonEvmParams, {
    r: `0x${r}`,
    s: `0x${s}`,
    v,
  });
  const signedTxHash = keccak256(signedTx);

  return {
    requestId,
    requester,
    operators,
    signedTxHash,
    fromAddress,
    nonce: txNonce,
    checkCount: 0,
    evmParams: evmTxParams as CantonEvmParams,
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
    console.log(`[MPC] Exercising RespondBidirectional for requestId=${tx.requestId}`);
    await exerciseChoiceWithRetry(
      config.canton,
      config.userId,
      config.actAs,
      SIGNER_TEMPLATE,
      config.signerCid,
      "RespondBidirectional",
      {
        operators: tx.operators,
        requester: tx.requester,
        requestId: tx.requestId,
        serializedOutput: mpcOutput,
        signature,
      },
    );
    console.log(
      `[MPC] RespondBidirectional exercised for requestId=${tx.requestId} (output=${mpcOutput})`,
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

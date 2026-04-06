import {
  CantonClient,
  type CreatedEvent,
  MpcServer,
  findCreated,
  firstCreated,
  chainIdHexToCaip2,
  deriveDepositAddress,
  computeRequestId,
  toSpkiPublicKey,
  reconstructSignedTx,
  submitRawTransaction,
  DAR_PATH,
  Signer,
  Vault,
  Erc20Holding,
  SignatureRespondedEvent,
  RespondBidirectionalEvent,
  PendingDeposit,
  PendingWithdrawal,
} from "canton-sig";
import { keccak256, toHex } from "viem";
import { DER } from "@noble/curves/abstract/weierstrass.js";
import { loadEnv } from "../../config/env.js";
import {
  DEPOSIT_AMOUNT,
  fetchNonce,
  fetchGasParams,
  toCantonHex,
  fundFromFaucet,
} from "./sepolia-helpers.js";

const SIGNER_TEMPLATE = Signer.templateId;
export const VAULT_TEMPLATE = Vault.templateId;
export const SIGNATURE_RESPONDED = SignatureRespondedEvent.templateId;
export const RESPOND_BIDIRECTIONAL = RespondBidirectionalEvent.templateId;
export const ERC20_HOLDING = Erc20Holding.templateId;

/**
 * Compute the operators hash matching Daml's computeOperatorsHash.
 * sort operators, keccak256 each (as UTF-8), then keccak256 the concatenation.
 */
export function computeOperatorsHash(operators: string[]): string {
  const sorted = [...operators].sort();
  const individualHashes = sorted.map((op) => keccak256(toHex(op)).slice(2));
  return keccak256(`0x${individualHashes.join("")}`).slice(2);
}

export const SEPOLIA_CHAIN_ID = 11155111;
export const GAS_LIMIT = 100_000n;
const POLL_INTERVAL = 5_000;
const POLL_TIMEOUT = 180_000;
export const KEY_VERSION = 1;
export const ALGO = "ECDSA";
export const DEST = "ethereum";

export type { PendingWithdrawal, SignatureRespondedEvent, RespondBidirectionalEvent, Erc20Holding };

export function tryLoadEnv() {
  try {
    return loadEnv();
  } catch {
    return null;
  }
}

const canton = new CantonClient();

export async function pollForContract(
  parties: string[],
  templateId: string,
  predicate: (args: Record<string, unknown>) => boolean,
  label: string,
): Promise<CreatedEvent> {
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT) {
    const contracts = await canton.getActiveContracts(parties, templateId);
    const match = contracts.find((c) => predicate(c.createArgument as Record<string, unknown>));
    if (match) return match;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Timed out waiting for ${label} (${POLL_TIMEOUT / 1000}s)`);
}

// ── Vault setup ──

export interface VaultSetup {
  canton: CantonClient;
  mpcServer: MpcServer;
  operator: string;
  requester: string;
  sigNetwork: string;
  signerCid: string;
  vaultCid: string;
  signerDisclosure: Awaited<ReturnType<CantonClient["getDisclosedContract"]>>;
  vaultDisclosure: Awaited<ReturnType<CantonClient["getDisclosedContract"]>>;
  vaultAddress: `0x${string}`;
  vaultAddressPadded: string;
  predecessorId: string;
  userId: string;
}

export async function setupVault(
  env: ReturnType<typeof loadEnv>,
  userId: string,
  partyPrefix: string,
): Promise<VaultSetup> {
  await canton.uploadDar(DAR_PATH);

  const sigNetwork = await canton.allocateParty(`${partyPrefix}SigNetwork`);
  const operator = await canton.allocateParty(`${partyPrefix}Operator`);
  const requester = await canton.allocateParty(`${partyPrefix}Requester`);
  await canton.createUser(userId, sigNetwork, [operator, requester]);

  const operatorsHash = computeOperatorsHash([operator]);
  const predecessorId = `${env.VAULT_ID}${operatorsHash}`;

  const vaultAddress = deriveDepositAddress(env.MPC_ROOT_PUBLIC_KEY, predecessorId, "root");
  const vaultAddressPadded = vaultAddress.slice(2).padStart(64, "0");

  // Create Signer contract (signatory: sigNetwork)
  const signerResult = await canton.createContract(userId, [sigNetwork], SIGNER_TEMPLATE, {
    sigNetwork,
  });
  const signerEvent = findCreated(signerResult.transaction.events, "Signer");
  const signerCid = signerEvent.contractId;
  const signerDisclosure = await canton.getDisclosedContract(
    [sigNetwork],
    SIGNER_TEMPLATE,
    signerCid,
  );

  // Create Vault contract (signatory: operators=[operator])
  const mpcPubKeySpki = toSpkiPublicKey(env.MPC_ROOT_PUBLIC_KEY);
  const vaultResult = await canton.createContract(userId, [operator], VAULT_TEMPLATE, {
    operators: [operator],
    sigNetwork,
    evmVaultAddress: vaultAddressPadded,
    evmMpcPublicKey: mpcPubKeySpki,
    vaultId: env.VAULT_ID,
  });
  const vaultEvent = findCreated(vaultResult.transaction.events, "Vault");
  const vaultCid = vaultEvent.contractId;
  const vaultDisclosure = await canton.getDisclosedContract([operator], VAULT_TEMPLATE, vaultCid);

  const mpcServer = new MpcServer({
    canton,
    signerCid,
    userId,
    parties: [sigNetwork],
    rootPrivateKey: env.MPC_ROOT_PRIVATE_KEY,
    rpcUrl: env.SEPOLIA_RPC_URL,
  });
  await mpcServer.start();
  await mpcServer.waitUntilReady();

  return {
    canton,
    mpcServer,
    operator,
    requester,
    sigNetwork,
    signerCid,
    vaultCid,
    signerDisclosure,
    vaultDisclosure,
    vaultAddress,
    vaultAddressPadded,
    predecessorId,
    userId,
  };
}

// ── Deposit flow ──

interface DepositResult {
  holdingCid: string;
  holdingArgs: Erc20Holding;
  requestId: string;
  amountPadded: string;
  mpcOutput: string;
}

/**
 * Parse a DER-encoded ECDSA signature into {r, s, v} for EVM tx reconstruction.
 * The recovery bit (v) is determined by trying both 0 and 1.
 * For simplicity we default to 0 — the MPC service already verified it on-chain.
 */
function parseDerSignature(derHex: string): { r: string; s: string; v: number } {
  const { r, s } = DER.toSig(`${derHex}`);
  return {
    r: r.toString(16).padStart(64, "0"),
    s: s.toString(16).padStart(64, "0"),
    v: 0,
  };
}

export async function executeDepositFlow(
  env: ReturnType<typeof loadEnv>,
  setup: VaultSetup,
  logPrefix = "[e2e]",
): Promise<DepositResult> {
  const {
    canton,
    operator,
    requester,
    sigNetwork,
    signerCid,
    vaultCid,
    signerDisclosure,
    vaultDisclosure,
    vaultAddressPadded,
    predecessorId,
    userId,
  } = setup;

  const requesterPath = requester;
  const depositAddress = deriveDepositAddress(
    env.MPC_ROOT_PUBLIC_KEY,
    predecessorId,
    `${requester},${requesterPath}`,
  );
  console.log(`${logPrefix} Deposit address derived: ${depositAddress}`);

  await fundFromFaucet(
    env.SEPOLIA_RPC_URL,
    env.FAUCET_PRIVATE_KEY,
    depositAddress,
    env.ERC20_ADDRESS,
    DEPOSIT_AMOUNT,
  );

  const nonce = await fetchNonce(env.SEPOLIA_RPC_URL, depositAddress);
  const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env.SEPOLIA_RPC_URL);

  const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);
  const erc20AddressNoPrefix = env.ERC20_ADDRESS.slice(2).toLowerCase();
  const evmTxParams = {
    to: erc20AddressNoPrefix,
    functionSignature: "transfer(address,uint256)",
    args: [vaultAddressPadded, amountPadded],
    value: toCantonHex(0n, 32),
    nonce: toCantonHex(BigInt(nonce), 32),
    gasLimit: toCantonHex(GAS_LIMIT, 32),
    maxFeePerGas: toCantonHex(maxFeePerGas, 32),
    maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
    chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
  };

  // ── Auth card flow ──
  console.log(`${logPrefix} RequestAuthorization`);
  const requestResult = await canton.exerciseChoice(
    userId,
    [requester],
    VAULT_TEMPLATE,
    vaultCid,
    "RequestAuthorization",
    { requester },
    undefined,
    [vaultDisclosure],
  );
  const requestCid = firstCreated(requestResult.transaction.events).contractId;

  console.log(`${logPrefix} ApproveAuthorization`);
  const approveResult = await canton.exerciseChoice(
    userId,
    [operator],
    VAULT_TEMPLATE,
    vaultCid,
    "ApproveAuthorization",
    { requestCid, remainingUses: 1, approver: operator },
  );
  const authEvent = findCreated(approveResult.transaction.events, "Authorization");
  const authCid = authEvent.contractId;

  // ── Request deposit ──
  console.log(`${logPrefix} RequestDeposit`);
  const depositResult = await canton.exerciseChoice(
    userId,
    [requester],
    VAULT_TEMPLATE,
    vaultCid,
    "RequestDeposit",
    {
      requester,
      signerCid,
      path: requesterPath,
      evmTxParams,
      authCid,
      nonceCidText: authCid,
      keyVersion: KEY_VERSION,
      algo: ALGO,
      dest: DEST,
      params: "",
      outputDeserializationSchema: '[{"name":"","type":"bool"}]',
      respondSerializationSchema: '[{"name":"","type":"bool"}]',
    },
    undefined,
    [vaultDisclosure, signerDisclosure],
  );

  const pending = findCreated(depositResult.transaction.events, "PendingDeposit");
  const pendingDepositCid = pending.contractId;
  const { requestId } = pending.createArgument as PendingDeposit;

  // Cross-language requestId invariant
  const caip2Id = chainIdHexToCaip2(evmTxParams.chainId);
  const fullPath = `${requester},${requesterPath}`;
  const tsRequestId = computeRequestId(
    predecessorId,
    evmTxParams,
    caip2Id,
    KEY_VERSION,
    fullPath,
    ALGO,
    DEST,
    "",
    authCid,
  );
  if (tsRequestId.slice(2) !== requestId) {
    throw new Error(
      `${logPrefix} RequestId mismatch: TS=${tsRequestId.slice(2)}, Canton=${requestId}`,
    );
  }
  console.log(`${logPrefix} PendingDeposit created (requestId=${requestId})`);

  // ── MPC signs ──
  const signatureRespondedEvent = await pollForContract(
    [sigNetwork],
    SIGNATURE_RESPONDED,
    (args) => args.requestId === requestId,
    "SignatureRespondedEvent (deposit)",
  );
  const signatureRespondedEventCid = signatureRespondedEvent.contractId;
  const signatureRespondedArgs = signatureRespondedEvent.createArgument as SignatureRespondedEvent;
  console.log(`${logPrefix} SignatureRespondedEvent observed`);

  // ── Submit to Sepolia ──
  // Parse DER-encoded signature to r,s,v for EVM tx reconstruction
  const { r, s, v } = parseDerSignature(signatureRespondedArgs.signature);
  const signedTx = reconstructSignedTx(evmTxParams, {
    r: `0x${r}`,
    s: `0x${s}`,
    v,
  });
  const txHash = await submitRawTransaction(env.SEPOLIA_RPC_URL, signedTx);
  console.log(`${logPrefix} Submitted signed tx: ${txHash}`);

  // ── Wait for outcome ──
  const respondBidirectionalEvent = await pollForContract(
    [sigNetwork],
    RESPOND_BIDIRECTIONAL,
    (args) => args.requestId === requestId,
    "RespondBidirectionalEvent (deposit)",
  );
  const respondBidirectionalEventCid = respondBidirectionalEvent.contractId;
  const respondBidirectionalArgs =
    respondBidirectionalEvent.createArgument as RespondBidirectionalEvent;
  console.log(`${logPrefix} RespondBidirectionalEvent observed`);

  // ── Claim deposit ──
  console.log(`${logPrefix} ClaimDeposit`);
  const claimResult = await canton.exerciseChoice(
    userId,
    [requester],
    VAULT_TEMPLATE,
    vaultCid,
    "ClaimDeposit",
    { requester, pendingDepositCid, respondBidirectionalEventCid, signatureRespondedEventCid },
    undefined,
    [vaultDisclosure],
  );

  const holding = findCreated(claimResult.transaction.events, "Erc20Holding");
  console.log(`${logPrefix} Deposit complete (holdingCid=${holding.contractId})`);

  return {
    holdingCid: holding.contractId,
    holdingArgs: holding.createArgument as Erc20Holding,
    requestId,
    amountPadded,
    mpcOutput: respondBidirectionalArgs.serializedOutput,
  };
}

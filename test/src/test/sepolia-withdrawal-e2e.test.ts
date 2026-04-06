import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAddress, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import {
  findCreated,
  chainIdHexToCaip2,
  computeRequestId,
  reconstructSignedTx,
  submitRawTransaction,
  deriveChildPrivateKey,
} from "canton-sig";
import {
  tryLoadEnv,
  setupVault,
  executeDepositFlow,
  pollForContract,
  parseDerSignature,
  VAULT_TEMPLATE,
  SIGNATURE_RESPONDED,
  RESPOND_BIDIRECTIONAL,
  SEPOLIA_CHAIN_ID,
  GAS_LIMIT,
  KEY_VERSION,
  ALGO,
  DEST,
  type VaultSetup,
  type PendingWithdrawal,
  type SignatureRespondedEvent,
  type RespondBidirectionalEvent,
  type Erc20Holding,
} from "./helpers/e2e-setup.js";
import {
  DEPOSIT_AMOUNT,
  fetchNonce,
  fetchGasParams,
  checkErc20Balance,
  toCantonHex,
  fundFromFaucet,
} from "./helpers/sepolia-helpers.js";

const env = tryLoadEnv();
const describeIf = env ? describe : describe.skip;

describeIf("sepolia e2e withdrawal lifecycle", () => {
  let setup: VaultSetup;
  let holdingCid: string;

  beforeAll(async () => {
    setup = await setupVault(env!, "sepolia-withdrawal-e2e", "Wdl");

    // Fund vault address with ERC20 (needed for the withdrawal tx)
    await fundFromFaucet(
      env!.SEPOLIA_RPC_URL,
      env!.FAUCET_PRIVATE_KEY,
      setup.vaultAddress,
      env!.ERC20_ADDRESS,
      DEPOSIT_AMOUNT,
    );

    const deposit = await executeDepositFlow(env!, setup, "[wdl-e2e]");
    holdingCid = deposit.holdingCid;
  }, 600_000);

  afterAll(() => {
    setup.mpcServer.shutdown();
  });

  it("completes full withdrawal flow through Sepolia", async () => {
    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();
    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);

    // Recipient is the faucet address (send tokens back)
    const recipientAddress = privateKeyToAddress(env!.FAUCET_PRIVATE_KEY).slice(2).toLowerCase();
    const recipientPadded = recipientAddress.padStart(64, "0");

    // Fetch vault nonce and gas
    const vaultNonce = await fetchNonce(env!.SEPOLIA_RPC_URL, setup.vaultAddress);
    const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env!.SEPOLIA_RPC_URL);

    const evmTxParams = {
      to: erc20AddressNoPrefix,
      functionSignature: "transfer(address,uint256)",
      args: [recipientPadded, amountPadded],
      value: toCantonHex(0n, 32),
      nonce: toCantonHex(BigInt(vaultNonce), 32),
      gasLimit: toCantonHex(GAS_LIMIT, 32),
      maxFeePerGas: toCantonHex(maxFeePerGas, 32),
      maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
      chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
    };

    // Check recipient balance before withdrawal
    const balanceBefore = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    console.log(`[wdl-e2e] Recipient ERC20 balance before: ${balanceBefore}`);

    // ── Request withdrawal ──
    console.log("[wdl-e2e] User → Canton: RequestWithdrawal");
    const wdlResult = await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_TEMPLATE,
      setup.vaultCid,
      "RequestWithdrawal",
      {
        requester: setup.requester,
        signerCid: setup.signerCid,
        evmTxParams,
        recipientAddress: recipientPadded,
        nonceCidText: holdingCid,
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        params: "",
        balanceCid: holdingCid,
        outputDeserializationSchema: '[{"name":"","type":"bool"}]',
        respondSerializationSchema: '[{"name":"","type":"bool"}]',
      },
      undefined,
      [setup.vaultDisclosure, setup.signerDisclosure],
    );

    const pendingWdl = findCreated(wdlResult.transaction.events, "PendingWithdrawal");
    const pendingWithdrawalCid = pendingWdl.contractId;
    const { requestId } = pendingWdl.createArgument as PendingWithdrawal;

    const caip2Id = chainIdHexToCaip2(evmTxParams.chainId);
    const tsRequestId = computeRequestId(
      setup.predecessorId,
      evmTxParams,
      caip2Id,
      KEY_VERSION,
      "root",
      ALGO,
      DEST,
      "",
      holdingCid,
    );
    expect(tsRequestId.slice(2)).toBe(requestId);
    console.log(`[wdl-e2e] PendingWithdrawal created (requestId=${requestId})`);

    // ── MPC signs withdrawal tx on Canton ──
    const signatureRespondedEvent = await pollForContract(
      [setup.sigNetwork],
      SIGNATURE_RESPONDED,
      (args) => args.requestId === requestId,
      "SignatureRespondedEvent (withdrawal)",
    );
    const signatureRespondedEventCid = signatureRespondedEvent.contractId;
    const signatureRespondedArgs =
      signatureRespondedEvent.createArgument as SignatureRespondedEvent;
    console.log("[wdl-e2e] SignatureRespondedEvent observed");

    // ── User submits signed withdrawal tx to Sepolia ──
    const { r, s, v } = await parseDerSignature(
      signatureRespondedArgs.signature,
      evmTxParams,
      setup.vaultAddress,
    );
    const signedTx = reconstructSignedTx(evmTxParams, {
      r: `0x${r}`,
      s: `0x${s}`,
      v,
    });
    const txHash = await submitRawTransaction(env!.SEPOLIA_RPC_URL, signedTx);
    console.log(`[wdl-e2e] User submitted signed withdrawal tx: ${txHash}`);

    // ── MPC verifies Sepolia receipt and posts outcome signature ──
    const respondBidirectionalEvent = await pollForContract(
      [setup.sigNetwork],
      RESPOND_BIDIRECTIONAL,
      (args) => args.requestId === requestId,
      "RespondBidirectionalEvent (withdrawal)",
    );
    const respondBidirectionalEventCid = respondBidirectionalEvent.contractId;
    const respondBidirectionalArgs =
      respondBidirectionalEvent.createArgument as RespondBidirectionalEvent;
    expect(respondBidirectionalArgs.serializedOutput).toBe(
      "0000000000000000000000000000000000000000000000000000000000000001",
    );
    console.log("[wdl-e2e] RespondBidirectionalEvent observed");

    // ── User completes withdrawal on Canton ──
    const completeResult = await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_TEMPLATE,
      setup.vaultCid,
      "CompleteWithdrawal",
      {
        requester: setup.requester,
        pendingWithdrawalCid,
        respondBidirectionalEventCid,
        signatureRespondedEventCid,
      },
      undefined,
      [setup.vaultDisclosure],
    );

    // CompleteWithdrawal succeeded (no throw).
    // On success (serializedOutput==ABI-encoded true): returns None — no NEW Erc20Holding created.
    // Check that the CompleteWithdrawal transaction itself did not produce a holding
    // (other holdings from unrelated deposits may still be active on the ledger).
    const completeEvents = completeResult.transaction.events ?? [];
    const refundHolding = completeEvents.find(
      (e) => "CreatedEvent" in e && e.CreatedEvent.templateId.includes("Erc20Holding"),
    );
    expect(refundHolding).toBeUndefined();

    // Verify recipient balance increased on Sepolia
    const balanceAfter = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    console.log(`[wdl-e2e] Recipient ERC20 balance after: ${balanceAfter}`);
    expect(balanceAfter).toBe(balanceBefore + DEPOSIT_AMOUNT);

    console.log("[wdl-e2e] All withdrawal assertions passed");
  }, 300_000);

  it("refunds Erc20Holding when withdrawal tx is replaced", async () => {
    // Run a fresh deposit to get a new holding
    const deposit = await executeDepositFlow(env!, setup, "[wdl-nonce]");
    const errorHoldingCid = deposit.holdingCid;

    const erc20AddressNoPrefix = env!.ERC20_ADDRESS.slice(2).toLowerCase();
    const amountPadded = toCantonHex(DEPOSIT_AMOUNT, 32);
    const recipientAddress = privateKeyToAddress(env!.FAUCET_PRIVATE_KEY).slice(2).toLowerCase();
    const recipientPadded = recipientAddress.padStart(64, "0");

    // Ensure vault has ETH for the replacement tx (may have been spent on prior withdrawal gas)
    await fundFromFaucet(
      env!.SEPOLIA_RPC_URL,
      env!.FAUCET_PRIVATE_KEY,
      setup.vaultAddress,
      env!.ERC20_ADDRESS,
      DEPOSIT_AMOUNT,
    );

    const vaultNonce = await fetchNonce(env!.SEPOLIA_RPC_URL, setup.vaultAddress);
    const { maxFeePerGas, maxPriorityFeePerGas } = await fetchGasParams(env!.SEPOLIA_RPC_URL);

    const evmTxParams = {
      to: erc20AddressNoPrefix,
      functionSignature: "transfer(address,uint256)",
      args: [recipientPadded, amountPadded],
      value: toCantonHex(0n, 32),
      nonce: toCantonHex(BigInt(vaultNonce), 32),
      gasLimit: toCantonHex(GAS_LIMIT, 32),
      maxFeePerGas: toCantonHex(maxFeePerGas, 32),
      maxPriorityFee: toCantonHex(maxPriorityFeePerGas, 32),
      chainId: toCantonHex(BigInt(SEPOLIA_CHAIN_ID), 32),
    };

    const balanceBefore = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );

    // ── Request withdrawal ──
    console.log("[wdl-nonce] User → Canton: RequestWithdrawal");
    const wdlResult = await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_TEMPLATE,
      setup.vaultCid,
      "RequestWithdrawal",
      {
        requester: setup.requester,
        signerCid: setup.signerCid,
        evmTxParams,
        recipientAddress: recipientPadded,
        nonceCidText: errorHoldingCid,
        keyVersion: KEY_VERSION,
        algo: ALGO,
        dest: DEST,
        params: "",
        balanceCid: errorHoldingCid,
        outputDeserializationSchema: '[{"name":"","type":"bool"}]',
        respondSerializationSchema: '[{"name":"","type":"bool"}]',
      },
      undefined,
      [setup.vaultDisclosure, setup.signerDisclosure],
    );

    const pendingWdl = findCreated(wdlResult.transaction.events, "PendingWithdrawal");
    const pendingWithdrawalCid = pendingWdl.contractId;
    const { requestId } = pendingWdl.createArgument as PendingWithdrawal;
    console.log(`[wdl-nonce] PendingWithdrawal created (requestId=${requestId})`);

    // ── Wait for MPC to sign ──
    const signatureRespondedEvent = await pollForContract(
      [setup.sigNetwork],
      SIGNATURE_RESPONDED,
      (args) => args.requestId === requestId,
      "SignatureRespondedEvent (nonce-replace)",
    );
    const signatureRespondedEventCid = signatureRespondedEvent.contractId;
    console.log("[wdl-nonce] SignatureRespondedEvent observed");

    // ── Submit replacement tx from vault (consumes the nonce, not the withdrawal) ──
    const vaultChildKey = deriveChildPrivateKey(
      env!.MPC_ROOT_PRIVATE_KEY,
      setup.predecessorId,
      "root",
    );
    const vaultAccount = privateKeyToAccount(vaultChildKey);
    const publicClient = createPublicClient({
      chain: sepolia,
      transport: http(env!.SEPOLIA_RPC_URL),
    });
    const walletClient = createWalletClient({
      account: vaultAccount,
      chain: sepolia,
      transport: http(env!.SEPOLIA_RPC_URL),
    });

    console.log("[wdl-nonce] Submitting replacement tx (0 ETH self-transfer)");
    const replacementHash = await walletClient.sendTransaction({
      to: vaultAccount.address,
      value: 0n,
      nonce: vaultNonce,
    });
    await publicClient.waitForTransactionReceipt({ hash: replacementHash });
    console.log(`[wdl-nonce] Replacement tx mined: ${replacementHash}`);

    // ── MPC detects nonce consumed without receipt → serializedOutput starts with "deadbeef" ──
    const respondBidirectionalEvent = await pollForContract(
      [setup.sigNetwork],
      RESPOND_BIDIRECTIONAL,
      (args) => args.requestId === requestId,
      "RespondBidirectionalEvent (nonce-replace)",
    );
    const respondBidirectionalEventCid = respondBidirectionalEvent.contractId;
    const respondBidirectionalArgs =
      respondBidirectionalEvent.createArgument as RespondBidirectionalEvent;
    expect(respondBidirectionalArgs.serializedOutput.startsWith("deadbeef")).toBe(true);
    console.log(
      "[wdl-nonce] RespondBidirectionalEvent observed (serializedOutput starts with deadbeef)",
    );

    // ── Complete withdrawal → refund ──
    const completeResult = await setup.canton.exerciseChoice(
      setup.userId,
      [setup.requester],
      VAULT_TEMPLATE,
      setup.vaultCid,
      "CompleteWithdrawal",
      {
        requester: setup.requester,
        pendingWithdrawalCid,
        respondBidirectionalEventCid,
        signatureRespondedEventCid,
      },
      undefined,
      [setup.vaultDisclosure],
    );

    // Refund Erc20Holding should be created (serializedOutput != ABI-encoded true)
    const refundHolding = findCreated(completeResult.transaction.events, "Erc20Holding");
    const refundArgs = refundHolding.createArgument as Erc20Holding;
    expect(refundArgs.owner).toBe(setup.requester);
    expect(refundArgs.operators).toEqual([setup.operator]);
    expect(refundArgs.amount).toBe(amountPadded);

    // Recipient balance unchanged (withdrawal never executed)
    const balanceAfter = await checkErc20Balance(
      env!.SEPOLIA_RPC_URL,
      env!.ERC20_ADDRESS,
      `0x${recipientAddress}`,
    );
    expect(balanceAfter).toBe(balanceBefore);

    console.log("[wdl-nonce] All nonce-replacement assertions passed");
  }, 300_000);
});

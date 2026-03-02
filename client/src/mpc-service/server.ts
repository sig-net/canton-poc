import type { Hex } from "viem";
import { getLedgerEnd, type JsGetUpdatesResponse } from "../infra/canton-client.js";
import { createLedgerStream, type StreamHandle } from "../infra/ledger-stream.js";
import { handlePendingEvmDeposit } from "./deposit-handler.js";

export interface MpcServerConfig {
  orchCid: string;
  userId: string;
  parties: string[];
  rootPrivateKey: Hex;
  rpcUrl: string;
}

export class MpcServer {
  private stream: StreamHandle | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(private config: MpcServerConfig) {
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  async start(): Promise<void> {
    const offset = await getLedgerEnd();

    this.stream = createLedgerStream({
      parties: this.config.parties,
      beginExclusive: offset,
      onUpdate: (item: JsGetUpdatesResponse) => {
        const update = item.update;
        if (!("Transaction" in update)) return;

        for (const event of update.Transaction.value.events ?? []) {
          if (!("CreatedEvent" in event)) continue;
          const created = event.CreatedEvent;
          if (!created.templateId.includes("PendingEvmDeposit")) continue;

          console.log(`[MPC] PendingEvmDeposit detected, contractId=${created.contractId}`);
          handlePendingEvmDeposit({
            orchCid: this.config.orchCid,
            userId: this.config.userId,
            actAs: this.config.parties,
            rootPrivateKey: this.config.rootPrivateKey,
            rpcUrl: this.config.rpcUrl,
            event: created,
          }).catch((err) => {
            console.error(
              `[MPC] Failed to handle deposit: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      },
      onError: (err) => console.error("[MPC] Stream error:", err),
    });

    this.resolveReady();
    console.log("[MPC] Listening for PendingEvmDeposit events...");
  }

  async waitUntilReady(timeoutMs = 5_000): Promise<void> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("MpcServer readiness timed out")), timeoutMs);
    });
    await Promise.race([this.readyPromise, timeout]);
  }

  shutdown(): void {
    this.stream?.close();
    this.stream = null;
    console.log("[MPC] Shut down");
  }
}

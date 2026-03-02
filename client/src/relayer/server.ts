import { getLedgerEnd, type JsGetUpdatesResponse } from "../infra/canton-client.js";
import { createLedgerStream, type StreamHandle } from "../infra/ledger-stream.js";
import { handleEcdsaSignature } from "./mpc-signature-handler.js";
import { handleEvmTxOutcomeSignature } from "./tx-outcome-handler.js";

export interface RelayerServerConfig {
  orchCid: string;
  userId: string;
  parties: string[];
  issuerParty: string;
  rpcUrl: string;
}

export class RelayerServer {
  private stream: StreamHandle | null = null;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(private config: RelayerServerConfig) {
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
          const templateId = created.templateId;

          if (templateId.includes("EcdsaSignature")) {
            handleEcdsaSignature({
              issuerParty: this.config.issuerParty,
              rpcUrl: this.config.rpcUrl,
              event: created,
            }).catch((err) => console.error("[Relayer] EcdsaSignature handler failed:", err));
          }

          if (templateId.includes("EvmTxOutcomeSignature")) {
            handleEvmTxOutcomeSignature({
              orchCid: this.config.orchCid,
              userId: this.config.userId,
              actAs: this.config.parties,
              issuerParty: this.config.issuerParty,
              event: created,
            }).catch((err) =>
              console.error("[Relayer] EvmTxOutcomeSignature handler failed:", err),
            );
          }
        }
      },
      onError: (err) => console.error("[Relayer] Stream error:", err),
    });

    this.resolveReady();
    console.log("[Relayer] Listening for events...");
  }

  async waitUntilReady(timeoutMs = 5_000): Promise<void> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("RelayerServer readiness timed out")), timeoutMs);
    });
    await Promise.race([this.readyPromise, timeout]);
  }

  shutdown(): void {
    this.stream?.close();
    this.stream = null;
    console.log("[Relayer] Shut down");
  }
}

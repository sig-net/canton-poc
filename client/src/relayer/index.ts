import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  uploadDar,
  allocateParty,
  createUser,
  getActiveContracts,
} from "../infra/canton-client.js";
import { loadEnvConfig } from "../config/env.js";
import { VaultOrchestrator } from "@daml.js/canton-mpc-poc-0.0.1/lib/Erc20Vault/module";
import { RelayerServer } from "./server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAR_PATH = resolve(__dirname, "../../../.daml/dist/canton-mpc-poc-0.0.1.dar");
const VAULT_ORCHESTRATOR = VaultOrchestrator.templateId;
const RELAYER_USER = "relayer";

async function main() {
  const config = loadEnvConfig();

  console.log("[Relayer] Uploading DAR...");
  await uploadDar(DAR_PATH);

  const issuerParty = await allocateParty("Issuer");
  console.log(`[Relayer] Issuer party: ${issuerParty}`);

  await createUser(RELAYER_USER, issuerParty);
  console.log(`[Relayer] User "${RELAYER_USER}" ready`);

  const orchContracts = await getActiveContracts([issuerParty], VAULT_ORCHESTRATOR);
  const orchCid = orchContracts[0]?.contractId;
  if (!orchCid) {
    throw new Error("[Relayer] No VaultOrchestrator contract found");
  }
  console.log(`[Relayer] VaultOrchestrator CID: ${orchCid}`);

  const server = new RelayerServer({
    orchCid,
    userId: RELAYER_USER,
    parties: [issuerParty],
    issuerParty,
    rpcUrl: config.SEPOLIA_RPC_URL,
  });

  await server.start();
  await server.waitUntilReady();

  const shutdown = () => {
    server.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[Relayer] Fatal:", err);
  process.exit(1);
});

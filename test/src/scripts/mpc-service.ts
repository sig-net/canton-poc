import {
  CantonClient,
  DAR_PATH,
  MpcServer,
  VaultOrchestrator,
} from "canton-mpc";
import { loadEnv } from "../config/env.js";

const USER_ID = "mpc-service";

async function main() {
  const config = loadEnv();
  const canton = new CantonClient(config.CANTON_JSON_API_URL);
  console.log("[MPC] Starting MPC service");

  await canton.uploadDar(DAR_PATH);
  console.log("[MPC] DAR uploaded");

  const issuer = await canton.allocateParty("Issuer");
  console.log(`[MPC] Issuer party: ${issuer}`);

  await canton.createUser(USER_ID, issuer);
  console.log("[MPC] User created");

  const contracts = await canton.getActiveContracts([issuer], VaultOrchestrator.templateId);
  if (contracts.length === 0) {
    throw new Error("[MPC] No VaultOrchestrator contract found");
  }
  const orchCid = contracts[0]!.contractId;
  console.log(`[MPC] VaultOrchestrator CID: ${orchCid}`);

  const server = new MpcServer({
    canton,
    orchCid,
    userId: USER_ID,
    parties: [issuer],
    rootPrivateKey: config.MPC_ROOT_PRIVATE_KEY,
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
  console.error("[MPC] Fatal:", err);
  process.exit(1);
});

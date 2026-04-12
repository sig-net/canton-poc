# Canton MPC PoC

## Testing

### Daml tests

```bash
dpm build --all
for pkg in daml-abi daml-uint256 daml-eip712 daml-signer daml-vault; do
  (cd daml-packages/$pkg && dpm test)
done
```

> `dpm test` does not support `--all` — each package must be tested individually.

### TypeScript oracle suites (no sandbox needed)

Co-located TS tests that verify Daml logic against reference implementations (viem, etc.):

```bash
pnpm -r --filter='@canton/*' --filter='canton-sig' run test
```

### Canton sandbox

Required for integration tests and codegen:api. Start in a separate terminal:

```bash
dpm sandbox --json-api-port 7575 --dar daml-packages/daml-vault/.daml/dist/daml-vault-0.0.1.dar
```

Wait for `Canton sandbox is ready` or poll `curl -sf http://localhost:7575/docs/openapi`.

### Integration tests (sandbox required)

```bash
# 1. Build DAR and regenerate codegen (required after Daml changes)
dpm build --all
cd test && pnpm codegen:daml

# 2. Generate OpenAPI types (requires running sandbox)
cd test && pnpm codegen:api

# 3. Build the canton-sig library
cd ts-packages/canton-sig && pnpm build

# 4. Run integration tests
cd test && pnpm test
```

### Sepolia E2E tests

Requires `test/.env` with `SEPOLIA_RPC_URL`, `MPC_ROOT_PRIVATE_KEY`, `MPC_ROOT_PUBLIC_KEY`, and a funded faucet. `FAUCET_PRIVATE_KEY` can be set separately; it defaults to `MPC_ROOT_PRIVATE_KEY` if unset. These tests run alongside integration tests when env vars are set.

```bash
cd test
pnpm sepolia:preflight    # verify faucet balances
pnpm test                 # runs all tests including Sepolia e2e when env is set
```

## Project layout

- `daml-packages/` -- Daml source packages (`daml-signer` + `daml-vault` DARs, plus shared libs)
- `ts-packages/` -- TypeScript packages (`canton-sig` library)
- `test/` -- Integration & e2e tests

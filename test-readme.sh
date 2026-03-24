#!/usr/bin/env bash
set -euo pipefail

step() { echo -e "\n=== $1 ===\n"; }

# --- README: Daml Unit Tests ---
step "dpm build"
dpm build

step "dpm test"
dpm test

# --- README: Quick Start Step 1 — Build DAR and generate codegen ---
step "codegen:daml + pnpm install"
cd client
pnpm run codegen:daml
pnpm install --frozen-lockfile

# --- README: Quick Start Step 2 — Start Canton sandbox ---
step "Start Canton sandbox"
pnpm daml:sandbox &
SANDBOX_PID=$!

step "Wait for Canton JSON API"
for i in $(seq 1 60); do
  if curl -sf http://localhost:7575/docs/openapi > /dev/null 2>&1; then
    echo "Ready"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Canton sandbox failed to start within 120s"
    exit 1
  fi
  sleep 2
done

# --- README: codegen:api (requires running sandbox) ---
step "codegen:api"
pnpm run codegen:api

# --- README: Available Scripts — pnpm check ---
step "pnpm check"
pnpm check

# --- README: Quick Start Step 3 — Run tests (no Sepolia env) ---
step "pnpm test (Sepolia tests will be skipped — no .env)"
pnpm test

# --- README: One-liner rebuild ---
step "pnpm generate (clean rebuild with sandbox running)"
pnpm generate

step "pnpm check (after generate)"
pnpm check

step "pnpm test (after generate)"
pnpm test

# --- README: Available Scripts — mpc-service (requires env vars, expect Zod error) ---
step "pnpm mpc-service (expect env validation failure)"
if pnpm mpc-service 2>&1; then
  echo "UNEXPECTED: mpc-service should have failed without env vars"
  exit 1
else
  echo "OK: mpc-service failed on env validation as expected"
fi

# --- README: Available Scripts — sepolia:preflight (requires env vars, expect Zod error) ---
step "pnpm sepolia:preflight (expect env validation failure)"
if pnpm sepolia:preflight 2>&1; then
  echo "UNEXPECTED: sepolia:preflight should have failed without env vars"
  exit 1
else
  echo "OK: sepolia:preflight failed on env validation as expected"
fi

# Cleanup
kill "$SANDBOX_PID" 2>/dev/null || true
wait "$SANDBOX_PID" 2>/dev/null || true

echo -e "\n=== All README steps passed ===\n"

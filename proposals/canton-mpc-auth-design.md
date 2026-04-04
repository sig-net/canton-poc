# Canton MPC Auth Design: Self-Signed JWTs

Compatible with Canton 3.x / Daml SDK 3.4.x+.

**Rollout:** v0 uses per-certificate config (`jwt-es-256-crt`) for simplicity. v1 migrates to a JWKS endpoint (`jwt-jwks`) for no-restart key rotation and O(1) lookup.

## Problem

The MPC codebase authenticates to every chain with private keys: Solana (ed25519 keypair), Ethereum (secp256k1 private key), NEAR (ed25519 key). Each node loads the key once at startup, signs each transaction with it. No expiration, no refresh, no external dependency.

Canton's default auth setup uses Keycloak with shared secrets (`client_secret`). This diverges from the MPC pattern:
1. The secret exists in two places (node + Keycloak DB)
2. The secret is transmitted over the wire on every token request
3. Best practice says rotate periodically (like a password)

## Solution

Canton supports `jwt-es-256-crt` -- each node holds an EC P-256 private key, signs its own JWTs, and Canton validates directly against the node's public key certificate. No Keycloak. No shared secrets. Private key never leaves the node.

To approximate per-transaction signing (like Solana/ETH), the node mints a fresh JWT with a short expiry (30-60 seconds) for each command submission. This keeps the stolen-token window minimal while remaining a local crypto operation (~1ms, no network call).

### How This Differs From Other Chains

On Solana/ETH/NEAR, the private key signs each blockchain-native transaction -- the signature is bound to that specific payload and non-replayable. On Canton, the private key signs a JWT bearer token that authorizes API calls. These are different auth models:

| | Solana/ETH/NEAR | Canton |
|---|---|---|
| Key signs | Chain-native transaction (payload-bound) | JWT bearer token (grants API access) |
| Verified by | Blockchain consensus (decentralized) | Canton participant Ledger API (centralized) |
| Stolen credential scope | One transaction only | All operations for token lifetime |
| Token lifecycle | None | Mint per-request (~1ms local crypto) |

The security boundary is the same across all chains: the MPC threshold signature and on-chain/on-ledger cryptographic verification protect funds. The operational key (Solana keypair or Canton JWT key) is a door key to the API, not the vault key.

---

## Actors

### 1. Sig Network Canton Participant

A single Canton participant node operated by Sig Network.

- Hosts all Daml contracts (VaultOrchestrator, PendingEvmTx, Erc20Holding, etc.)
- Hosts the `mpc-signer` party and the `issuer` party
- Exposes JSON Ledger API v2 (e.g., port 7575)
- Configured with certificates for each MPC node
- Validates every incoming JWT against the registered certificates

### 2. MPC Nodes (8 nodes)

Each MPC node is a Rust process running the MPC signing protocol.

- Each node has its own EC P-256 private key (stored as file path in env var)
- Each node is a Canton **user** (e.g., `mpc-node-1`) with `can_act_as` + `can_read_as` rights on the `mpc-signer` party
- All 8 nodes share the same on-ledger identity (`mpc-signer` party)
- Only the proposer writes to Canton per signing request

### 3. Canton User Management

Canton users are created at setup time via the User Management Service (`POST /v2/users` on the JSON Ledger API v2). Users are participant-local -- a user ID on participant A has no meaning on participant B. The `sub` claim in a JWT maps to a user ID, and Canton dynamically looks up that user's current rights at request time (rights are NOT encoded in the token, so they can be changed without reissuing JWTs).

| User | Party Rights | Purpose |
|------|-------------|---------|
| `mpc-node-1` | `can_act_as` + `can_read_as` `mpc-signer` | MPC node 1 |
| `mpc-node-2` | `can_act_as` + `can_read_as` `mpc-signer` | MPC node 2 |
| ... | ... | ... |
| `mpc-node-8` | `can_act_as` + `can_read_as` `mpc-signer` | MPC node 8 |
| `temple-backend` | `can_act_as` `issuer` | Temple/Sig Network backend |

### Required Daml Contract Changes

The current Daml contracts need these changes for MPC nodes to participate directly:

**1. Change controllers on signing choices** (`Erc20Vault.daml`):

```diff
  nonconsuming choice SignEvmTx : ContractId EcdsaSignature
    ...
-   controller issuer
+   controller mpc

  nonconsuming choice ProvideEvmOutcomeSig : ContractId EvmTxOutcomeSignature
    ...
-   controller issuer
+   controller mpc
```

Why: MPC nodes act as `mpc-signer` party. With `controller issuer`, they cannot exercise these choices unless they also have `can_act_as issuer` -- which would grant them unwanted authority (e.g., `ApproveDepositAuth`, `ApproveWithdrawalAuth`).

**2. Add `mpc` as observer on evidence contracts**:

```diff
  template EcdsaSignature with
    issuer : Party
    requester : Party
+   mpc : Party
    requestId : BytesHex
    r : BytesHex
    s : BytesHex
    v : Int
  where
    signatory issuer
-   observer requester
+   observer requester, mpc

  template EvmTxOutcomeSignature with
    issuer : Party
    requester : Party
+   mpc : Party
    requestId : BytesHex
    signature : SignatureHex
    mpcOutput : BytesHex
  where
    signatory issuer
-   observer requester
+   observer requester, mpc
```

Why: Without this, non-proposer MPC nodes cannot verify that the proposer actually published the signature. This makes proposer withholding undetectable.

---

## Key Management

### Per-Node Keys

Each MPC node generates an EC P-256 keypair at setup (one-time, like generating a Solana keypair):

```bash
# Generate PKCS#8 private key + self-signed certificate (valid 10 years)
# Requires OpenSSL 3.x (-noenc replaces deprecated -nodes)
openssl req -x509 -noenc -days 3650 \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout mpc-node-1.key -out mpc-node-1.crt \
  -subj "/CN=mpc-node-1"
```

This produces:
- `mpc-node-1.key` -- EC P-256 private key in PKCS#8 PEM format (stays on the node, never shared). Note: OpenSSL 3.x outputs PKCS#8 (`BEGIN PRIVATE KEY`); OpenSSL 1.x outputs SEC1 (`BEGIN EC PRIVATE KEY`). Both work for JWT signing.
- `mpc-node-1.crt` -- X.509 certificate containing the public key (given to Canton participant). Canton uses the cert purely as a public key container -- no chain validation, no expiry checking, self-signed is fine. Verified in Canton source: `KeyUtils.readECPublicKeyFromCrt` only calls `.getPublicKey` on the cert -- never checks issuer, validity dates, or chain.

### What Each Actor Stores

```
MPC Node 1:
  MPC_SOL_ACCOUNT_SK=5abc...          # Solana operational key
  MPC_ETH_ACCOUNT_SK=0xdef...         # Ethereum operational key
  MPC_ACCOUNT_SK=ed25519:...          # NEAR operational key
  MPC_CANTON_SIGNING_KEY=/keys/mpc-node-1.key   # Canton signing key (NEW)
  MPC_CANTON_USER_ID=mpc-node-1                  # Canton user ID (NEW)
  MPC_CANTON_LEDGER_API_URL=https://participant:7575  # Canton API (NEW)

Canton Participant:
  /keys/mpc-node-1.crt   # Node 1's public certificate
  /keys/mpc-node-2.crt   # Node 2's public certificate
  ...
  /keys/mpc-node-8.crt   # Node 8's public certificate
```

---

## Canton Participant Configuration

### v0: Per-Certificate (simpler, requires restart for changes)

```hocon
canton.participants.signet-participant.ledger-api {

  # Canton tries each in order, accepts first valid signature.
  # Worst case: 8 ECDSA verifications per invalid request.
  auth-services = [
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-1.crt" },
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-2.crt" },
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-3.crt" },
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-4.crt" },
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-5.crt" },
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-6.crt" },
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-7.crt" },
    { type = jwt-es-256-crt, certificate = "/keys/mpc-node-8.crt" }
  ]

  jwt-timestamp-leeway {
    default = 10          # 10 seconds clock skew leeway (applies to exp, nbf, iat)
    # Per-claim overrides available: expires-at, issued-at, not-before
  }

  # Rejects tokens whose remaining TTL (exp - now) exceeds this value.
  # Note: checks remaining TTL, NOT original TTL (exp - iat). A token
  # issued for 24h would still be accepted in its final minute.
  # DA recommends 5-15 min; 1 min is aggressive but matches our
  # per-request minting model where tokens are always freshly minted.
  max-token-lifetime = 1.minute
}
```

### v1: JWKS Endpoint (production target)

Serve all public keys via a static JWKS JSON file. Canton caches keys for 5 minutes (configurable). Adding/removing keys does NOT require participant restart -- just update the JSON file.

```hocon
canton.participants.signet-participant.ledger-api {
  auth-services = [{
    type = jwt-jwks
    url = "http://jwks-server:4443/.well-known/jwks.json"
    target-audience = "https://daml.com/jwt/aud/participant/signet-participant"
  }]

  jwks-cache-config {
    cache-expiration = 5.minutes
  }

  jwt-timestamp-leeway {
    default = 10
  }
  max-token-lifetime = 1.minute
}
```

Advantages of JWKS over per-certificate:
- O(1) key lookup via JWT `kid` header vs O(n) sequential trial
- No participant restart for key rotation (just update the JWKS JSON)
- Single config entry regardless of node count

---

## Authentication Flow

### Per-Request JWT Minting (Approximating Per-Tx Signing)

For **command submissions** (SignEvmTx, ProvideEvmOutcomeSig), the node mints a fresh JWT with a short expiry for each request. This approximates per-tx signing on other chains:

```
Per command submission:
  1. Build JWT claims: { sub: "mpc-node-3", aud: "...", exp: now + 30s }
  2. Sign with EC P-256 private key (~1ms local crypto)
  3. POST /v2/commands/submit-and-wait-for-transaction with Authorization: Bearer <jwt>
  4. JWT expires after 30 seconds -- non-replayable in practice
```

For **WebSocket streams** (observing PendingEvmTx events), the node uses a slightly longer-lived JWT (5 minutes) and reconnects with a fresh JWT on expiry.

### JWT Payload (Audience-Based Format)

```json
{
  "sub": "mpc-node-1",
  "aud": "https://daml.com/jwt/aud/participant/signet-participant",
  "exp": 1712000030
}
```

Canton supports two token formats:
- **Audience-based** (recommended): uses `aud` claim to target a specific participant
- **Scope-based**: uses `scope: "daml_ledger_api"` for generic API access

The mutual exclusivity is at the **server config level** (`target-audience` vs `target-scope`), not the token payload. A token with both claims won't be rejected -- Canton checks whichever claim it's configured to check and ignores the other.

Note: `iss` is intentionally omitted. For `jwt-es-256-crt` (v0), there is no IDP routing so `iss` is unnecessary. For JWKS (v1) with multiple issuers, `iss` becomes relevant for IDP matching.

### Canton Validation

1. Extracts JWT from `Authorization: Bearer <jwt>` header
2. For `jwt-es-256-crt`: tries each certificate in order, accepts first valid signature
3. For `jwt-jwks`: matches JWT `kid` header to JWKS key in O(1)
4. Extracts `sub` claim → looks up Canton user → checks party rights
5. Authorized if user has `can_act_as` for the required party

### Important: No Cert-to-User Binding

Canton validates that "this JWT was signed by SOME configured certificate" and separately that "this `sub` user exists." There is no enforcement that certificate X may only sign JWTs for user Y. Any node whose cert is configured can claim to be any user. This is acceptable because all 8 nodes share the same `mpc-signer` party -- impersonating another node grants no additional privilege.

Verified in Canton source: `AuthInterceptor.headerToClaims` folds over auth services and discards the winning certificate identity. `ClaimSet.AuthenticatedUser` only carries `userId` and `expiration` -- no cert reference. `UserBasedClaimResolver` looks up rights by userId alone.

---

## End-to-End Signing Flow

### Deposit Request (Full Round Trip)

```
Phase 1: User Creates Signing Request
──────────────────────────────────────
User exercises RequestEvmDeposit on VaultOrchestrator (controller: requester)
  → Creates PendingEvmTx (observer: mpc-signer)


Phase 2: MPC Nodes Observe Request
──────────────────────────────────
All 8 nodes see PendingEvmTx via WebSocket stream
  (authenticated with JWT, signed by each node's own key)


Phase 3: MPC Protocol (Off-Chain, Unchanged)
────────────────────────────────────────────
Proposer selected: mpc-node-3 (deterministic: entropy[0] + round % 8)
8 nodes run threshold signing protocol → produce ECDSA signature (r, s, v)
Only mpc-node-3 (proposer) proceeds to publish


Phase 4: Proposer Publishes Signature to Canton
────────────────────────────────────────────────
MPC Node 3:
  1. Mints fresh JWT (sub=mpc-node-3, exp=now+30s)
  2. Exercises SignEvmTx on VaultOrchestrator
     { requestId, r, s, v }
  3. Canton validates JWT → creates EcdsaSignature contract

  NOTE: SignEvmTx currently has controller=issuer in the Daml code.
  This must be changed to controller=mpc for this flow to work.
  See "Required Daml Contract Changes" above.


Phase 5: EVM Execution (Off-Chain)
──────────────────────────────────
User/Relayer submits signed tx to Sepolia
  → ERC-20 transfer executes on-chain


Phase 6: Proposer Reports Outcome
──────────────────────────────────
MPC Node 3:
  1. Polls Sepolia for receipt (status=1)
  2. Signs response hash with MPC root key (EIP-712 typed data)
  3. Mints fresh JWT, exercises ProvideEvmOutcomeSig
     { requestId, signature, mpcOutput }
  4. Canton creates EvmTxOutcomeSignature contract


Phase 7: User Claims Deposit
─────────────────────────────
User exercises ClaimEvmDeposit (controller: requester)
  Canton/Daml validates:
  - pending.requestId == outcome.requestId
  - secp256k1WithEcdsaOnly(outcome.signature, responseHash, mpcPublicKey)
  - mpcOutput has no error prefix, decodes as true
  → Creates Erc20Holding, archives evidence contracts
```

### Command Deduplication

The proposer must use a **deterministic `commandId`** derived from the `requestId` (e.g., `sign-{requestId}`) and a unique `submissionId` (random UUID) per retry attempt. This ensures Canton deduplicates retries within the configured window.

```
Dedup key = (userId, actAs, commandId)
  commandId = "sign-" + requestId      // same across retries
  submissionId = randomUUID()           // unique per attempt
  deduplicationPeriod = 720 seconds     // covers 6 retries × 120s
```

---

## Security Model

### What the Private Key Protects

The EC P-256 key authenticates the node to Canton's Ledger API. It proves "I am mpc-node-3 and I have the right to act as mpc-signer."

It does NOT:
- Sign EVM transactions (that's the MPC threshold key)
- Prove the EVM signature is correct (verified on EVM via `ecrecover`)
- Prove the outcome is real (verified in Daml via `secp256k1WithEcdsaOnly` against `mpcPublicKey`)

### Threat Analysis

| Threat | Impact | Mitigation |
|--------|--------|------------|
| **1 node's Canton key compromised** | Attacker can exercise choices as `mpc-signer`. Can create junk EcdsaSignature contracts. | Fake signatures fail EVM verification. Fake outcomes fail `secp256k1WithEcdsaOnly` at claim time. Short JWT expiry (30s) limits replay window. |
| **JWT intercepted** | Attacker can submit commands for up to 30 seconds (per-request JWT lifetime). | TLS required on Ledger API. Per-request minting keeps window minimal. |
| **Canton participant compromised (POC)** | Total system compromise -- attacker can read all state, forge contracts, modify ledger. | In single-participant POC, the participant IS the ledger. Production requires multi-participant Canton Network where parties on different participants provide mutual validation. |
| **Rogue MPC node** | Can create junk evidence contracts (DoS), but cannot forge MPC threshold signatures. | `SignEvmTx` should validate that a matching `PendingEvmTx` exists and enforce at-most-once creation. |
| **Node's key file leaked** | Attacker can mint JWTs for that node's user. | Revoke: remove cert from config (requires restart with per-cert, or JWKS update without restart). |

### What's Safe (Confirmed by Red-Team Review)

- **Fund theft via forged signatures**: Blocked by `secp256k1WithEcdsaOnly` verification in `ClaimEvmDeposit`/`CompleteEvmWithdrawal`
- **Double-claim**: Blocked by `PendingEvmTx` archive (consuming)
- **Cross-chain replay**: Blocked by EIP-712 envelope (`CantonMpc` domain separator)
- **Nonce reuse**: Blocked by `DepositAuthorization` archive

### Known Gaps (To Address Before Production)

1. **`SignEvmTx` has no validation**: Does not check that a `PendingEvmTx` exists for the `requestId`. No uniqueness constraint. Unlimited junk contracts possible. Fix: add fetch + dedup logic in the Daml choice.
2. **Proposer withholding undetectable**: `mpc-signer` is NOT observer on `EcdsaSignature`/`EvmTxOutcomeSignature`. Other nodes can't verify publication. Fix: add `mpc` as observer on evidence contracts.
3. **No ECDSA-to-evmParams binding**: `SignEvmTx` stores arbitrary r,s,v without verifying they match the `PendingEvmTx.evmParams`. A malicious signer could sign a different EVM tx. Fix: verify on-chain at claim time or add binding logic.
4. **No audit logging**: All 8 nodes appear as `mpc-signer` on-ledger. No node-level forensic attribution. Fix: add `submittedBy` field to evidence contracts.

---

## Node Rotation

### Adding a New Node

1. New node generates EC P-256 keypair
2. With **per-cert config**: add certificate to Canton config, restart participant (all 8 nodes briefly lose access)
3. With **JWKS**: add key to JWKS JSON file, Canton picks it up within cache expiry (default 5 min, no restart)
4. Create Canton user `mpc-node-9` with `can_act_as mpc-signer` via `POST /v2/users`
5. New node configures env vars and connects

### Removing a Node

1. With **per-cert**: remove certificate from config, restart participant
2. With **JWKS**: remove key from JWKS JSON, waits up to cache expiry (5 min) before Canton rejects the key
3. Delete or disable the Canton user via `DELETE /v2/users/{user-id}`

### Key Rotation

With JWKS: add new key to JSON → node switches to new key → remove old key from JSON. No restart. Zero downtime.

With per-cert: add new cert to config → restart → node switches → remove old cert → restart again. Two restarts required.

This is the primary motivation for the v0 → v1 migration.

---

## Failure Modes

### Canton Participant Down

All 8 nodes lose Canton read/write access. Unlike Solana RPC (stateless, replaceable), the Canton participant is stateful and hosts the party identity -- there is no failover endpoint.

**Impact on in-flight signatures:** The MPC retry window is ~12.5 minutes (6 attempts × 120s + backoff). If the participant is down longer, completed MPC signatures are discarded ("trashed"). This wastes expensive threshold signing work.

**POC:** Acceptable. **Production:** Requires participant high-availability on Canton Network.

### Node Crash / JWT Expiry During Retry

Not an issue. Per-request JWT minting means the node mints a fresh 30s JWT before each attempt. On restart: load key from file, mint JWT, reconnect WebSocket with offset tracking. One local crypto operation (~1ms).

---

## Integration Path Comparison

Canton supports four authentication approaches. Self-signed JWTs are the only viable path for MPC nodes -- the others are rejected for reasons below.

### v0 / v1 Comparison

| | v0: Self-Signed JWT per-cert (`jwt-es-256-crt`) | v1: Self-Signed JWT via JWKS (`jwt-jwks`) | Keycloak (shared secret) | External Signing (external parties) |
|---|---|---|---|---|
| **Ranking** | **v0 (PoC)** | **v1 (Production)** | **Rejected** | **Rejected** |
| Key loaded at startup | Yes (EC P-256 from file) | Yes (EC P-256 from file) | Yes (client_secret) | Yes (signing key) |
| What the key signs | JWT bearer token (local ~1ms) | JWT bearer token (local ~1ms) | Nothing -- secret sent as password | Canton transaction directly |
| External service needed | No | No (static JSON file) | Yes (Keycloak server) | No |
| Network call per auth | No | No | Yes (to Keycloak) | No |
| Credential replayable | 30s window (per-request JWT) | 30s window (per-request JWT) | Until secret rotated | No (tx-bound) |
| Node add/remove | Edit config + restart participant | Update JSON file, no restart | Keycloak admin UI | **On-ledger contract update** (observer/signatory changes) |
| All nodes share one party | Yes (`mpc-signer`) | Yes (`mpc-signer`) | Yes | No (each node = own party) |
| Node mgmt decoupled from ledger | Yes | Yes | Yes | **No** |
| Key lookup cost | O(n) sequential cert trial | O(1) via JWT `kid` header | O(1) via Keycloak token | N/A |
| Closest to MPC pattern | Close -- same "load key, sign locally" | Close -- same as per-cert from node side | Distant -- shared secret, central dependency | Closest in theory, worst in practice |

### Why This Ranking

**v0 -- Per-Certificate (`jwt-es-256-crt`)**

Ship first. Simplest config: one `auth-services` entry per node cert. Requires participant restart for node add/remove. Acceptable for PoC with a fixed 8-node set.

**v1 -- JWKS (`jwt-jwks`)**

Migrate when node set becomes dynamic or exceeds ~8 nodes. Same node-side code (still mints JWTs with EC P-256 key). Only the participant config changes: point at a JWKS JSON endpoint instead of listing individual certs. O(1) key lookup via JWT `kid` header, no-restart key rotation, cache expiry configurable (default 5 min).

**Rejected -- Keycloak**

Introduces a shared secret (exists on both node and Keycloak), a central service dependency, and a network round-trip for every token request. Diverges from the MPC pattern in every dimension. No benefit over self-signed JWTs for machine-to-machine auth with static identities.

**Rejected -- External Signing**

Each node becomes its own Canton party. Adding or removing a node requires on-ledger contract updates to change observers and signatories -- a Canton transaction, not just an infrastructure change. This couples node management to ledger state. With self-signed JWTs, all nodes share one `mpc-signer` party and node rotation is purely a cert-level operation.

---

## Verification Status

All claims in this design were verified against Canton 3.x documentation and source code (April 2026). Key source files examined:

| Claim | Status | Source |
|-------|--------|--------|
| `jwt-es-256-crt` config type | Confirmed | Canton 3.5 docs, `AuthServiceConfig.scala` |
| `jwt-jwks` config type | Confirmed | Canton 3.5 docs, `JwksVerifier.scala` |
| Self-signed cert acceptance | Confirmed | `KeyUtils.readECPublicKeyFromCrt` -- only calls `.getPublicKey`, no chain/expiry check |
| No cert-to-user binding | Confirmed | `AuthInterceptor.headerToClaims` discards cert identity after validation |
| Audience-based JWT format (`sub` + `aud`) | Confirmed | Canton 3.5 JWT docs. Fixed: `aud`/`scope` mutual exclusivity is config-level, not payload-level |
| `POST /v2/users` + party rights | Confirmed | OpenAPI spec, `UserManagementService` |
| Command dedup key `(userId, actAs, commandId)` | Confirmed | Canton protobuf + OpenAPI spec |
| `max-token-lifetime` (remaining TTL semantics) | Confirmed | Canton 3.5 docs -- checks `exp - now`, not `exp - iat` |
| JWKS no-restart rotation | Confirmed | `CachedJwtVerifierLoader.scala` -- cache expiry triggers re-fetch |
| OpenSSL keygen command | Confirmed | Minor fix: `-nodes` → `-noenc` (OpenSSL 3.x deprecation) |

Pending empirical verification: whether Canton checks X.509 certificate expiry dates (source code says no, but not explicitly documented by DA). Recommend testing with an expired cert to confirm.

---

## References

### Canton Authentication
- [Configure API Authentication and Authorization with JWT (Canton 3.5)](https://docs.digitalasset.com/operate/3.5/howtos/secure/apis/jwt.html)
- [Configure API Authentication and Authorization with JWT (Canton 3.4)](https://docs.digitalasset.com/operate/3.4/howtos/secure/apis/jwt.html)
- [gRPC Ledger API Configuration (Canton 3.5)](https://docs.digitalasset.com/operate/3.5/howtos/configure/apis/ledger_api.html)

### Canton User/Party Management
- [Parties and Users on a Canton Ledger](https://docs.digitalasset.com/build/3.5/explanations/parties-users.html)
- [The gRPC Ledger API Services](https://docs.digitalasset.com/build/3.5/explanations/ledger-api-services.html)
- [How to Allocate and Query Daml Parties](https://docs.digitalasset.com/build/3.4/sdlc-howtos/applications/develop/manage-daml-parties.html)

### Canton Security
- [Cryptographic Keys in Canton](https://docs.digitalasset.com/overview/3.4/explanations/canton/security.html)
- [Configure TLS for APIs](https://docs.digitalasset.com/operate/3.5/howtos/secure/apis/tls.html)
- [Local and External Parties](https://docs.digitalasset.com/overview/3.4/explanations/canton/external-party.html)
- [Topology Management](https://docs.digitalasset.com/overview/3.4/explanations/canton/topology.html)

### Canton JSON Ledger API v2
- [JSON Ledger API Service V2](https://docs.digitalasset.com/build/3.4/explanations/json-api/index.html)
- [Authorization (Daml SDK)](https://docs.daml.com/app-dev/authorization.html)

### Reference Implementations
- [ex-secure-canton-infra (GitHub)](https://github.com/digital-asset/ex-secure-canton-infra) -- Reference deployment with JWT, JWKS, TLS, PKI
- [Secure Daml Infrastructure Part 2: JWT, JWKS and Auth0](https://blog.digitalasset.com/blog/secure-daml-infrastructure-part-2-jwt-jwks-and-auth0)
- [cn-quickstart (GitHub)](https://github.com/digital-asset/cn-quickstart) -- Canton Network app quickstart

### Canton External Parties (Rejected Path -- Reference Only)
- [External Signing Overview](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_overview.html)
- [Submit Externally Signed Transactions](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_submission.html)
- [Onboard External Party Using Admin API](https://docs.digitalasset.com/build/3.4/tutorials/app-dev/external_signing_onboarding.html)

### Keycloak (Alternative to Self-Signed JWTs)
- [Keycloak JWT Authorization Grant (RFC 7523)](https://www.keycloak.org/securing-apps/jwt-authorization-grant)
- [Keycloak in cn-quickstart](https://docs.digitalasset.com/build/3.4/quickstart/secure/keycloak-in-cnqs.html)

### Standards
- [RFC 7519 -- JSON Web Token](https://datatracker.ietf.org/doc/html/rfc7519)
- [RFC 7523 -- JWT Profile for OAuth 2.0 Client Authentication](https://datatracker.ietf.org/doc/html/rfc7523)

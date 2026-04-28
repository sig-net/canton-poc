# Nonce Removal via Request-Side Authorization Plan

## Goal

Replace the current `nonceCid` / `nonceCidText` replay-prevention mechanism with an on-chain, request-side authorization flow that provides:

- **Atomic on-chain uniqueness** of `requestId` per `(operators, requester)` tenant
- **Multi-party validation** (operators + `sigNetwork`) _before_ the MPC signs
- **`PendingDeposit` / `PendingWithdrawal` uniqueness** for free (via one-shot authorization consumption)
- **Auditability** — every authorized `requestId` is recorded on-ledger

The MPC's `RespondBidirectional` / `Respond` choices remain unchanged.

## Why request-side, not response-side

Considered and rejected: a per-tenant `ResponseRegistry` keyed off `RespondBidirectional` calls. Rejected because:

1. It doesn't solve `PendingDeposit` uniqueness — two `RequestDeposit` calls with identical `evmTxParams` still produce two Pendings (Canton 3.x has no contract keys to enforce uniqueness on `PendingDeposit.requestId`). This forces us to keep nonces.
2. It doesn't add pre-sign multi-party validation.

Request-side authorization solves both by making the uniqueness check the gate through which sign requests must pass, atomically binding it to `PendingDeposit` creation.

## Tradeoff vs response-side registry

| Aspect                      | Response-side registry | Request-side authorization (this plan) |
| --------------------------- | ---------------------- | -------------------------------------- |
| On-chain uniqueness         | respond time           | request time                           |
| Drops `nonceCid`            | no                     | **yes**                                |
| `PendingDeposit` uniqueness | still need nonces      | **atomic via auth consumption**        |
| Multi-party pre-sign check  | no                     | **yes**                                |
| Tx count per sign           | 2 (request → respond)  | **3** (proposal → accept → request)    |
| MPC role                    | observer + signer      | **active validator + signer**          |
| Retry for same EVM tx       | works (new nonce)      | blocked (must change inputs)           |

## Architecture

```
Requester               Vault                Signer pkg                MPC
─────────               ─────                ──────────                ───
1. RequestAuthorization ─►  creates                                    observes
                            AuthorizationProposal ────────────────────►│
                                                                       │ validates off-chain
2.                                               CheckAndRecord       │ accepts
                                                 (registry)           ◄┤
                                                 ↓
                                                 Authorization
                                                 (sig: ops+req+sig)   ◄─ returned
3. RequestDeposit ─────► archives Authorization
                         creates SignBidirectionalEvent
                         creates PendingDeposit
                                                                       observes
4.                                                                     signs
                                                 RespondBidirectional ◄─ (unchanged)
5. ClaimDeposit (unchanged)
```

## Daml changes (`daml-signer`)

### New: `AuthorizationRegistry`

Per-tenant (one per `(sigNetwork, operators, requester)`) set of authorized `requestId`s.

```daml
import qualified DA.Set as Set

template AuthorizationRegistry
  with
    sigNetwork    : Party
    operators     : [Party]
    requester     : Party
    authorizedIds : Set BytesHex
  where
    signatory sigNetwork
    observer operators, requester
    ensure not (null operators) && unique operators

    choice CheckAndRecord : ContractId AuthorizationRegistry
      with
        callerOperators : [Party]
        callerRequester : Party
        newId           : BytesHex
      controller sigNetwork
      do
        assertMsg "registry operators mismatch"
          (sort callerOperators == sort operators)
        assertMsg "registry requester mismatch"
          (callerRequester == requester)
        assertMsg "requestId already authorized"
          (not (Set.member newId authorizedIds))
        create this with authorizedIds = Set.insert newId authorizedIds
```

Notes:

- Signatory `sigNetwork` only → MPC creates unilaterally, no bootstrap race with operators.
- `DA.Set.Set BytesHex` gives O(log n) membership check (vs O(n) for a list). Write cost is still O(n) bytes on the wire per update.
- Scoping assertions prevent cross-tenant registry abuse.

### New: `AuthorizationProposal`

Submitted by requester (via Vault), observed by MPC.

```daml
template AuthorizationProposal
  with
    sigNetwork                  : Party
    operators                   : [Party]
    requester                   : Party
    registryCid                 : ContractId AuthorizationRegistry
    requestId                   : BytesHex
    -- mirror of SignBidirectionalEvent payload:
    sender                      : Text
    txParams                    : TxParams
    caip2Id                     : Text
    keyVersion                  : Int
    path                        : Text
    algo                        : Text
    dest                        : Text
    params                      : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory operators, requester
    observer sigNetwork

    choice Accept : (ContractId Authorization, ContractId AuthorizationRegistry)
      controller sigNetwork
      do
        let computed = computeRequestId sender txParams caip2Id keyVersion
                                         path algo dest params
        assertMsg "requestId does not match fields" (computed == requestId)

        newRegistry <- exercise registryCid CheckAndRecord with
          callerOperators = operators
          callerRequester = requester
          newId           = requestId

        authCid <- create Authorization with
          sigNetwork; operators; requester; requestId
          sender; txParams; caip2Id; keyVersion; path; algo; dest; params
          outputDeserializationSchema; respondSerializationSchema

        pure (authCid, newRegistry)

    choice Reject : ()
      controller sigNetwork
      do pure ()

    choice Cancel : ()
      controller requester
      do pure ()
```

### New: `Authorization`

One-shot freshness token. Consumed by `Vault.RequestDeposit` / `RequestWithdrawal`.

```daml
template Authorization
  with
    sigNetwork                  : Party
    operators                   : [Party]
    requester                   : Party
    requestId                   : BytesHex
    sender                      : Text
    txParams                    : TxParams
    caip2Id                     : Text
    keyVersion                  : Int
    path                        : Text
    algo                        : Text
    dest                        : Text
    params                      : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  where
    signatory sigNetwork, operators, requester
    -- consumed via fetch + archive inside Vault.RequestDeposit
```

Signatories = all three trusted parties → cryptographic proof that all validated before sign.

### Remove

- `SigningNonce` template
- `Signer.IssueNonce` choice
- `Signer.SignBidirectional`'s nonce fetch/archive/re-create logic (keep the choice, remove nonce plumbing)
- `SignRequest.nonceCidText` field
- `SignBidirectionalEvent.nonceCidText` field
- `RequestId.computeRequestId` trailing `nonceCidText` parameter (new signature: 8 args instead of 9)

### Unchanged

- `Signer.RespondBidirectional`
- `Signer.Respond`
- `SignatureRespondedEvent`, `RespondBidirectionalEvent`
- All `Consume_*` choices

## Daml changes (`daml-vault`)

### New: `Vault.RequestAuthorization`

```daml
nonconsuming choice RequestAuthorization
  : ContractId AuthorizationProposal
  with
    requester    : Party
    registryCid  : ContractId AuthorizationRegistry
    evmTxParams  : EvmTransactionParams
    keyVersion   : Int
    algo         : Text
    dest         : Text
    params       : Text
    outputDeserializationSchema : Text
    respondSerializationSchema  : Text
  controller requester
  do
    -- ABI validation (hoisted from today's RequestDeposit)
    assertMsg "Only ERC20 transfer allowed" (...)
    -- ...

    let fullPath      = partyToText requester <> "," <> "deposit"
    let caip2Id       = "eip155:" <> chainIdToDecimalText evmTxParams.chainId
    let operatorsHash = computeOperatorsHash (map partyToText operators)
    let predecessorId = vaultId <> operatorsHash
    let requestId     = computeRequestId predecessorId (EvmTxParams evmTxParams)
                                          caip2Id keyVersion fullPath algo dest params

    create AuthorizationProposal with
      sigNetwork; operators; requester; registryCid; requestId
      sender = predecessorId; txParams = EvmTxParams evmTxParams
      caip2Id; keyVersion; path = fullPath; algo; dest; params
      outputDeserializationSchema; respondSerializationSchema
```

Mirror for withdrawal with `path = partyToText requester <> "," <> "root"` (**withdrawal now includes requester in `requestId`**, matching deposit).

### Modified: `Vault.RequestDeposit` / `RequestWithdrawal`

Drop `nonceCid` and `nonceCidText` args. Add `authorizationCid : ContractId Authorization`. Body consumes authorization atomically:

```daml
nonconsuming choice RequestDeposit
  : (ContractId SignBidirectionalEvent, ContractId PendingDeposit)
  with
    requester        : Party
    authorizationCid : ContractId Authorization
  controller requester
  do
    auth <- fetch authorizationCid
    assertMsg "auth operators mismatch"  (sort auth.operators == sort operators)
    assertMsg "auth requester mismatch"  (auth.requester == requester)
    assertMsg "auth sigNetwork mismatch" (auth.sigNetwork == sigNetwork)

    archive authorizationCid

    eventCid <- create SignBidirectionalEvent with
      operators; requester; sigNetwork = auth.sigNetwork
      sender = auth.sender; txParams = auth.txParams
      caip2Id = auth.caip2Id; keyVersion = auth.keyVersion
      path = auth.path; algo = auth.algo; dest = auth.dest; params = auth.params
      outputDeserializationSchema = auth.outputDeserializationSchema
      respondSerializationSchema  = auth.respondSerializationSchema

    pendingCid <- create PendingDeposit with
      operators; requester; sigNetwork = auth.sigNetwork
      requestId = auth.requestId
      evmTxParams = case auth.txParams of EvmTxParams p -> p

    pure (eventCid, pendingCid)
```

Authorization consumption is atomic with `PendingDeposit` creation → one auth = one Pending (PendingDeposit uniqueness comes for free, **no contract key needed**).

### New: `Vault.OnboardRequester`

MPC-driven, one-time per `(Vault, requester)` pair. Creates the `AuthorizationRegistry`.

```daml
nonconsuming choice OnboardRequester
  : ContractId AuthorizationRegistry
  with newRequester : Party
  controller sigNetwork
  do
    create AuthorizationRegistry with
      sigNetwork
      operators
      requester     = newRequester
      authorizedIds = Set.empty
```

Bootstrap race (two parallel `OnboardRequester` for same requester both succeed) is handled off-chain by MPC discipline: "onboard each requester exactly once."

## Rust (MPC node) changes

### New handler: `AuthorizationProposal`

In `process_canton_event`, add a branch for the new template ID:

```rust
} else if ledger_api::template_suffix_matches(
    template_id, templates::AUTHORIZATION_PROPOSAL)
{
    match parse_authorization_proposal(created) {
        Ok(proposal) => {
            if let Err(e) = verify_authorization_proposal(&proposal, created, tx_events) {
                tracing::warn!(%e, "rejecting authorization proposal");
                submit_reject(&proposal).await;
                return;
            }
            submit_accept(&proposal).await;
        }
        Err(e) => tracing::warn!(%e, "failed to parse AuthorizationProposal"),
    }
}
```

`verify_authorization_proposal` performs today's Checks 1, 2, 3 (signatories, pinned Signer reference). No Check 4 — there's no `nonceCidText` to verify; uniqueness is enforced by the registry inside `Accept`.

### Accept submission — use command deduplication

```rust
let command_id = format!("accept-{}", hex::encode(proposal.request_id));
let dedup_duration = participant_max_dedup_duration;
// Submit Exercise Accept on the proposal cid
```

Error handling:

- `DUPLICATE_COMMAND` → log + advance checkpoint (already accepted, idempotent)
- `assertMsg "requestId already authorized"` → log + advance checkpoint (previous run accepted)
- `assertMsg` scoping failures → hard error (MPC bug or corrupt state)

### Remove

- `SIGNING_NONCE` template constant
- Check 4 body in `verify_sign_event` (no nonceCidText)
- `nonce_cid_text` field from `contracts::SignBidirectionalRequestedEvent`
- `nonce_cid_text` from `compute_request_id` hash input (drop the 9th slice)
- Any MPC-side nonce issuance code

### Keep / simplify

- `verify_sign_event` Checks 1, 2, 3 still run (signatories + pinned Signer)
- No need to re-check uniqueness at sign time — already enforced during Accept

### Registry cid tracking

Maintain in-memory map `(operators_hash, requester) → registryCid`, bootstrap from ACS on startup, update on every successful Accept/OnboardRequester.

## TypeScript client changes

1. **Drop**: nonce issuance flow, `SigningNonce` handling.
2. **Add**: `Vault.RequestAuthorization` submission → poll/stream for `Authorization` cid → call `Vault.RequestDeposit` (or `RequestWithdrawal`) with the cid.
3. **Update** `computeRequestId` in `mpc/crypto.ts`:
   - Drop `nonceCidText` argument (hash input #9)
   - Withdrawal `path` now prefixes `requester` (matches deposit)
4. **Onboarding trigger**: first-time requester flow asks MPC to call `Vault.OnboardRequester`.

## Testing

### Daml (`daml-signer/daml/TestSigner.daml`, `daml-vault/daml/TestVault.daml`)

- **Happy path**: `RequestAuthorization` → `Accept` → `RequestDeposit` → event + Pending created, auth archived.
- **Replay at accept**: same proposal accepted twice → second fails `requestId already authorized`.
- **Proposal forgery**: `requestId` ≠ `hash(fields)` → Accept fails.
- **Cross-tenant registry abuse**: pass tenant B's registry cid in tenant A's proposal → CheckAndRecord fails scoping.
- **Double-consume authorization**: `RequestDeposit` twice with same auth cid → second fails (already archived).
- **Cancel flow**: requester cancels proposal before MPC accepts.
- **Onboard idempotency**: note the off-chain bootstrap race case.

### Rust

- Extend the `verify_sign_event` test scaffold (per the existing `TODO(test)`) for the simplified check set (drop Check 4 tests).
- **Catchup replay test**: process the same `AuthorizationProposal` `CreatedEvent` twice via the stream. Second submission hits either command dedup or registry rejection. No second `Authorization` created on-ledger.
- Integration test against sandbox for full deposit/withdrawal flows.

### Golden test (closes existing `TODO(test)` at `request_id.rs:52`)

Byte-equality across three implementations for the new 8-input `computeRequestId`:

- Daml `RequestId.computeRequestId`
- Rust `compute_request_id`
- TS `mpc/crypto.ts`

Run for both deposit and withdrawal shapes (post-requester-in-path change).

## Migration

Non-upgrade-compatible schema change:

- Drops fields (`nonceCidText`)
- Adds templates (`AuthorizationProposal`, `Authorization`, `AuthorizationRegistry`)
- Changes choice signatures (`RequestDeposit` / `RequestWithdrawal` args)
- Changes `computeRequestId` signature (8 args)
- Changes withdrawal `requestId` semantics (adds requester to path)

Plan: fresh deployment alongside the old DAR, cutover window, re-onboard all requesters. No in-place upgrade path.

## Open decisions

1. **Registry signatory**: `sigNetwork` only (recommended) vs `sigNetwork + operators` (extra authority cost, no added security).
2. **Authorization TTL**: ignore wasted authorizations (recommended, simpler) vs add expiry + cleanup (supports retry-without-change-in-inputs).
3. **Schema coupling**: `AuthorizationProposal`, `Authorization`, `SignBidirectionalEvent` all carry the same payload — worth extracting a shared `SignPayload` record type. Recommended.
4. **Request-path prefix for withdrawal**: hard-code `"root"` suffix vs accept a full path arg. Recommended: `partyToText requester <> "," <> "root"` to mirror deposit.
5. **Rollover**: defer to v2. Set-based registry will need one eventually (Canton tx size limits around ~30k–100k entries).

## Risks

- **Latency**: 3 tx per sign request (proposal → accept → request). Acceptable for payments-grade use; ceiling for high-frequency scenarios.
- **MPC architectural change**: MPC writes on the request-side path in addition to signing. New failure modes around Accept submission reliability.
- **Storage growth**: registry set grows unbounded until rollover. Plan before reaching Canton tx size limits.
- **Bootstrap discipline**: `OnboardRequester` must run exactly once per (Vault, requester). Off-chain discipline only. If forgotten, requester is blocked. Clear error surface + operator runbook required.
- **Retry semantics**: "exact same EVM tx" re-signing is blocked (requestId is permanently in registry). Users must change gas params or similar to retry. Document clearly.
- **Command deduplication bounds**: participant dedup window is finite. Post-window replays rely entirely on the on-chain registry. Set `deduplication_duration` to participant max explicitly.

## Implementation order

1. Daml templates + choices + tests (defines the interface)
2. Daml vault modifications + tests
3. Rust: new `AuthorizationProposal` handler + registry tracking + removed nonce code
4. Rust: updated `compute_request_id` + golden test
5. TS client: new authorization flow + updated `computeRequestId`
6. Integration tests end-to-end
7. Migration / cutover plan

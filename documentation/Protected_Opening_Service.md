# Protected opening service

Implemented 3 November 2026. The protected API releases an encrypted part only after on-chain opening authorization. A separate operator worker verifies that part and submits the verification result. The revised policy 2 contract authorizes opening directly from the assigned commission request; a fresh deployment is required.

## Trust and process boundaries

The HTTP server imports the opening request protocol but never imports the operator worker or reads a custody directory. `backend/src/opening-worker.ts` is used by the separate operator and restricted document service, never by the public API. It loads a private key after successful authorization, verifies in memory, and returns an attestation without filename, document bytes, unwrapped AES keys or salts. The separate commission document service now releases one verified document over its own guarded HTTP route; the public API continues to return ciphertext only. See Restricted_Documents_and_Key_Custody.md.

The key helper still generates ordinary RSA private files on the same laptop. Commission authorization and process separation provide software controls. Private key access remains trusted; this is not threshold decryption or HSM protection. An operator with direct filesystem access can bypass software controls. A Vault Transit provider can now replace application-held RSA files. Provisioning and validating live production custody remains deployment work.

## Signed retrieval and chain checks

`POST /api/storage/openings/retrieve` accepts `{ context, part, service, timestamp }` and an `X-Opening-Signature` header. Context is the existing canonical lower-case-address bid context. Part is 0, 1 or 2. The separate `openingMessage` domain binds the action, chain, workflow, tender, bidder, version, selected part, service address and five-minute timestamp. Bidder upload/download signatures cannot authorize this route. The route shares the storage request parser and IP rate limit.

`BlockchainService.openingAccess` uses one validated snapshot per check. It requires:

- The configured chain, deployed contract pair and linked registry.
- A signer currently holding OPENING_SERVICE_ROLE, not merely a connected wallet.
- A tender past its deadline, not paused, in InitialOpening, TechnicalReview or FinancialOpening for the requested part.
- A requested and authorized opening recorded by the assigned commission under opening policy version 2.
- The active latest bid version with a Pending outcome. Later stages additionally require admission; financial opening requires technical acceptance when configured.
- The fingerprint from the unique TenderPublished event and the exact on-chain Evidence tuple.

A confirmed commission opening request records the authorized stage. Current opening-service role revocation blocks retrieval and recording. State and authorization are rechecked after discovery, after retrieval, and before result submission. The contract independently enforces recording eligibility.

## Locate only the submitted part

The storage service scans its bounded local object store for canonical bundles matching deployment, tender, bidder and version. It verifies each full object content ID and package integrity, then compares the selected part's fingerprint and all three evidence digests with the chain. Unsubmitted or superseded objects are not accepted merely because their context matches. If several objects share the identical selected evidence, deterministic selection is safe because the returned part is the same committed material.

The response contains only `contentId`, `context`, the selected `part`, and `authorizedAtBlock`. It never returns a bundle of unopened parts, private keys or plaintext. If no intact match is available, the service returns OPENING_PACKAGE_MISSING and leaves the outcome Pending. This is bounded discovery, not a durable database index. Restore damaged storage and investigate; do not label a storage outage as bidder fraud.

## Worker verification and outcome rules

1. Verify signer/deployment and call openingAccess before retrieval or private key access.
2. Sign the narrow retrieval request, retrieve the selected part and recheck the chain.
3. Load only initial.pem, technical.pem or financial.pem from the explicitly supplied custody directory. Check a regular file, maximum 16 KiB, no group/other permission bits, RSA 3072 and the SHA-256 fingerprint of its public SPKI.
4. Independently compare context, selected part, key fingerprint and Evidence, then recompute ciphertext/package hashes. A transport or storage mismatch aborts without an outcome.
5. Use RSA-OAEP with SHA-256 to unwrap key and salt. Authenticate AES-256-GCM with the exact context and 128-bit tag. Recompute the contextual salted plaintext commitment and validate the file envelope and size.
6. Recheck eligibility, compute a non-sensitive result attestation digest, simulate recordOpeningResult and submit it through the operator signer. Verify the successful receipt's exact OpeningResult event, service, bid, version, part, outcome and digest.

VERIFIED records Verified. WRAPPED_KEY_INVALID, AUTHENTICATION_FAILED, COMMITMENT_MISMATCH and DOCUMENT_INVALID record Failed only when the bytes first match the chain and the operator key matches the published fingerprint. Missing keys, unsafe permissions, wrong keys, missing/corrupt objects, authorization changes, RPC failures and ineligible bids abort without recording a bidder failure. The contract does not permit retrying or overwriting a recorded outcome; failed bids need governed human handling.

Temporary buffers are overwritten where practical; JavaScript strings and native key objects remain subject to runtime memory management. The worker never writes plaintext. Attestations include context, service, part, Evidence, verification boolean and symbolic code; their SHA-256 digest is recorded on chain. Local result reports retain that attestation and receipt information without document contents.

## Local operator commands

Keep the Hardhat node and updated API running. The command is intentionally restricted to chain 31337 and uses unlocked disposable Hardhat accounts. It never imports a wallet private key into the API. Use the actor addresses printed by your latest deployment; do not assume example addresses apply to another chain.

From the project root, after the tender deadline and a confirmed bid:

```bash
npm --prefix backend run opening:local -- request --tender 1 --part initial --actor COMMISSION_ADDRESS
npm --prefix backend run opening:local -- verify --tender 1 --bidder BIDDER_ADDRESS --version 1 --part initial --actor OPENING_SERVICE_ADDRESS --custody-dir CUSTODY_DIRECTORY
```

Replace the uppercase values, tender ID and version with your actual deployment and bid. The custody directory must be the directory containing the private files printed by `keys:generate`. Since `npm --prefix backend` runs the command inside backend, use an absolute directory or a path relative to backend, such as `../.constructblock-custody/the-generated-folder`.

`request` closes an Open tender only for the initial part and only when the contract allows closure, then requests the stage. It never advances the chain clock. The commission request immediately authorizes the stage. `verify` records a result but does not admit a bidder, select a contractor or approve an award. Technical and financial stages must satisfy the commission's prior admission/technical decisions and have separate commission opening requests. Admission and technical decisions are now available in the commission workspace; selection and separate final approval are also available in that workspace; see Award_and_Final_Approval.md.

The helper stores result reports under backend/reports/openings. Once broadcast, it journals the transaction hash before waiting. A confirmation timeout returns Pending with that hash; inspect it before retrying. A service signer with an unmined transaction is blocked from submitting another result through the worker. There is no automated resubmission or replacement recovery, and the report is not a durable transaction queue. If a process dies between broadcast and journaling, reconcile wallet nonce, chain outcome and transaction history manually.

## Verification

`npm run test:opening` builds the backend and runs an isolated real-EVM workflow with signed injected HTTP, persisted encrypted packages and temporary custody files. It tests initial, technical and financial stages, denial before a commission request, signed-request tampering and expiration, wrong service/deployment/version, pause and revocation, revocation between retrieval and key access, missing storage, wrong keys, success receipts and cryptographic failures. The retained report is contracts/reports/opening-smoke.json. Backend unit tests cover envelope validation, private-key checks and failure classification.

This does not test a real browser wallet, the user's existing node or an OS TCP listener. Commission browser actions were added on 3 November; see Commission_Workspace.md. A restricted commission viewer, single-use audit records and remote Vault custody integration are now implemented. Live Vault/signing infrastructure, a durable package index, queue/reconciliation service and centralized audit/retention operations remain further work. See Restricted_Documents_and_Key_Custody.md.

The worker follows the authenticated decryption behavior documented in [Node.js crypto](https://nodejs.org/api/crypto.html); the access policy and attestation format are project-specific.

## OrbitDB adapter added 13 November 2026

Encrypted persistence can now be selected with `STORAGE_PROVIDER=orbitdb`. The adapter stores actual encrypted part contents in database records and uses a separate local owner process shared by the API and restricted viewer. There is no replication workflow. Filesystem storage remains explicitly selected while external dependency installation and live validation are pending. See [setup and verification](OrbitDB_Encrypted_Storage.md).

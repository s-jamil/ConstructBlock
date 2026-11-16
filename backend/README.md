# constructBlock backend and encrypted storage

Node.js 24, Express 5 and TypeScript API for the two Solidity contracts, with signed encrypted-package storage. The server listens on **127.0.0.1:3001**. It holds no signer or decryption private key. Signed storage endpoints accept only encrypted packages; it sends no blockchain transactions.

## Run

Keep the local blockchain running in its own terminal (`npm run node` in `contracts`). In the backend folder:

```bash
cd ~/Desktop/Capstone/Implementation/constructBlock/backend
npm install
npm run build
npm start
```

`backend/.env` has been initialized from `.env.example` using the addresses from the first deployment you supplied. Check them against your latest deployment output. They are public addresses, not secrets; they can become stale after redeployment or a node reset.

To import fresh addresses automatically, run `npm run deploy:local` in `contracts`. The updated deployment script saves `contracts/deployments/localhost.json`. Then run `npm run configure:local` in `backend` and restart the API. This updates only the two contract addresses and chain ID; it preserves other settings. The earlier deployment output by itself does not create a manifest retroactively.

Use `npm run dev` for source watching, or rebuild and restart after changing the compiled server. Native Node TypeScript support is used during development; `npm run build` performs full TypeScript checks and emits JavaScript into `dist`.

## Endpoints

| Method and path | Response |
|---|---|
| `GET /health` | Process liveness and configured service mode, independent of blockchain availability. |
| `GET /api/blockchain/status` | Expected/actual chain validation, latest block, contract addresses and registry link check. |
| `GET /api/tenders/:id` | Published tender metadata, state, deadline, dossier digest and recorded public-extract digest if present. |
| `GET /api/bidders/:address/status` | Checksummed address and whether the registry currently grants its bidder role. |

Examples in another terminal:

```bash
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/api/blockchain/status
curl http://127.0.0.1:3001/api/tenders/1
curl http://127.0.0.1:3001/api/bidders/0x14dC79964da2C08b23698B3D3cc7Ca32193d9955/status
```

A fresh `deploy:local` creates contracts and roles but no tender; tender 1 therefore returns **404** until publication. The isolated walkthrough does not populate your separate node, and `walkthrough:local` deploys its own contract pair. To read that pair's tender, use the two addresses from its JSON report in `.env`, then restart the backend.

All blockchain reads first validate chain ID, contract code and registry linkage. The contract getters and role check are evaluated at the recorded snapshot block. API results include `blockNumber`; integer IDs, deadlines and chain IDs are serialized as decimal strings to avoid precision loss. Dates beyond JavaScript's date range return a null ISO representation while preserving the raw timestamp.

Tender output uses an explicit field allowlist. It omits commission/officer identity, internal review counts, selection identity/digest and confidential documents. A public-extract digest is a recorded hash, not proof of actual website publication. Bidder approval is a role check, not identity verification.

## Errors

Errors use `{ "error": { "code": "...", "message": "..." } }`:

- **400**: invalid wallet or tender ID (positive uint256 required).
- **404**: unknown tender or route.
- **405**: attempted write method; only GET and HEAD are supported.
- **503**: RPC unavailable/timeout, chain mismatch, absent contract code, or mismatched registry pair.
- **500**: unexpected internal error; stack traces and connection credentials are not exposed.

An unavailable blockchain does not prevent `/health` responding. `/api/blockchain/status` is the readiness check. Invalid environment configuration prevents startup. An RPC failure after a node reset is not an empty tender or an unapproved bidder.

## Configuration

`PORT` defaults to 3001, `RPC_URL` to `http://127.0.0.1:8545`, `CHAIN_ID` to 31337 and `RPC_TIMEOUT_MS` to 5000. Contract addresses are mandatory, distinct, valid and nonzero. `.env` is ignored by Git; `.env.example` is a template. No private key setting exists.

The node retains its own data and wallets. This backend does not modify blockchain state. Encrypted uploads and owner retrieval use scoped wallet signatures and current bidder roles. Public metadata remains unauthenticated. Protected opening-service retrieval is implemented. General login sessions, deployed government custody infrastructure, PostgreSQL and production hosting remain further work. See the separate restricted-document service and Vault adapter below. Keep this development API bound to loopback.

## Contract ABIs

The ABI JSON files in `src/abi` are generated from the current Hardhat artifacts. After changing and compiling Solidity, run `npm run sync:contracts` here and rebuild the API. The ABI copies contain no bytecode or private keys. Matching interfaces and registry links do not constitute a security audit or bytecode identity proof.

## Validation

```bash
npm test
npm run build
npm run test:integration
```

Unit/HTTP tests inject requests without opening a network listener. Integration checks deploy the real Solidity contracts to an isolated Hardhat EVM and use an in-process provider to exercise the actual ABI and Express handlers, including role revocation, missing contracts, wrong chain and timeout behavior. They do not prove connectivity to an existing external node or OS TCP listener. The integration result is written to `reports/milestone-1-smoke.json`.

## Verification recorded 23 October 2026

The normal backend TypeScript build and all 22 API/configuration tests pass with the installed development dependencies. The real-EVM integration suite checks the API against deployed contracts using a socket-free HTTP transport and an in-process provider. Earlier dependency-download restrictions have been resolved by the local installation, and `package-lock.json` is available for repeatable `npm ci` installs.

The sandbox cannot open or connect to TCP listeners. The tests do not claim to verify your existing external node or an OS TCP listener; check `/health` and `/api/blockchain/status` from your regular terminal or browser.

## Encrypted storage milestone added 1 November 2026

The normal server now supplies EncryptedStorage to createApp. GET `/api/opening-keys/:fingerprint` serves verified public SPKI bytes. POST `/api/storage/bids` uploads canonical encrypted bundles. POST `/api/storage/:contentId/retrieve` retrieves an owner's bundle using signed context. Both POST operations require separate action-bound, payload-bound wallet signatures with timestamps within five minutes. This is not a general login session.

`STORAGE_DIR` and `OPENING_KEYS_DIR` optionally select the object and public-key directories (defaults `storage` and `opening-keys`, relative to backend cwd). Private keys must remain outside both. Run `npm run keys:generate` for disposable development opening keys; publish the printed fingerprints in a new tender. Do not run the API against the private custody folder.

Stored files survive API restarts and are immutable by content ID. Upload does not mean on-chain acceptance. Quotas, limits, persistence assumptions, error behavior, retention gaps and the exact protocol are documented in [Encrypted_Bid_Protocol.md](../documentation/Encrypted_Bid_Protocol.md). `npm run test:storage` from the repository root runs the new real-EVM integration checks. Earlier dated verification sections describe their historical read-only milestone.

## Protected opening milestone added 3 November 2026

POST `/api/storage/openings/retrieve` accepts a separately signed opening-service request and returns only the authorized encrypted part matching the active on-chain evidence. Current service role, stage, deadline, commission opening authorization, bid version and eligibility are checked before release. The HTTP server never loads the operator worker or its custody directory.

`npm run opening:local -- request|approve|verify ...` builds the backend and runs a separate local operator helper, restricted to chain 31337. Verification reads private material only after authorization, checks RSA/AES decryption and salted commitments, and records a receipt-verified result. It emits non-sensitive reports under `reports/openings`; missing storage or an operator key error leaves outcomes Pending. Read [the operator guide](../documentation/Protected_Opening_Service.md) before running it. Actor/award screens and restricted document viewing are implemented. A remote Vault custody provider is available; live production infrastructure still requires provisioning and validation.

From the repository root, `npm run test:opening` runs the real isolated EVM integration. Node crypto code is kept in `src/opening-worker.ts`; signed request types and messages are in `src/opening-protocol.ts`; chain gating is in `BlockchainService.openingAccess`. The revised opening policy requires deployment of the policy 2 contracts and synchronized ABIs. Private opening keys remain outside the public HTTP server.

## Restricted documents and remote key custody

The assigned commission can sign a single-use request for one verified document, with fresh blockchain checks, integrity verification and persisted authorization audit. The separate document service runs on loopback port 3002; the public API never decrypts files. Local demonstration custody or HTTPS Vault Transit can be selected explicitly.

Follow [the setup and deployment guide](../documentation/Restricted_Documents_and_Key_Custody.md) for environment examples, local startup, Vault public-key export, external operator signing, diagrams and remaining production checks. From the root, `npm run test:documents` runs the isolated document-release integration. Live Vault/signing infrastructure and browser prompts still require manual validation.

## OrbitDB adapter added 13 November 2026

Encrypted persistence can now be selected with `STORAGE_PROVIDER=orbitdb`. The adapter stores actual encrypted part contents in database records and uses a separate local owner process shared by the API and restricted viewer. There is no replication workflow. Filesystem storage remains explicitly selected while external dependency installation and live validation are pending. See [setup and verification](../documentation/OrbitDB_Encrypted_Storage.md).

# constructBlock frontend

React, TypeScript and Vite procurement workspace. It presents backend process health and blockchain deployment readiness separately, published tender lookup, and government-approved bidder role checks. Government officers can also publish tenders with their browser wallet. The backend reads blockchain state and supports scoped, wallet-signed encrypted package storage. There is no general backend login session.

## Start

From the repository root use `npm run dev` to start both backend and frontend. Keep the Hardhat blockchain running in a separate terminal. Or run this folder independently:

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. The Vite server binds only to loopback and forwards `/api` and `/health` to the backend at http://127.0.0.1:3001. Production preview uses port 4173 and the same local proxy. No backend CORS relaxation is required.

```bash
npm run build
npm test
npm run preview
```

The dashboard calls health and readiness on load and on explicit refresh. Lookups require a valid numeric tender ID or nonzero Ethereum address. Results represent a recorded block snapshot and are cleared when the lookup input changes. Failed or cancelled requests do not leave a previous success visible as a new result. A missing tender is distinct from an unavailable API.

A fresh deployment has no tender until publication. The isolated walkthrough does not populate the separate node, and `walkthrough:local` deploys its own contract pair. Update backend `.env` to the actual pair you want to inspect.

Approval means the wallet currently has BIDDER_ROLE; it is not identity verification or eligibility for a particular tender. The actor workspace now supports commission opening authorization, evaluation and award actions. A separate restricted service releases verified bidder files only to the assigned commission. Opening private keys remain absent from the browser.

## Officer publication

Follow the wallet and local network setup in the [root README](../README.md#publish-your-first-tender). Wallet connection requires the deployed OFFICER_ROLE. Before requesting a transaction, the app rechecks the account, chain, deployed bytecode, linked registry, officer role, commission role, pause state, and chain deadline. The contract enforces authorization independently.

The form accepts a nonzero dossier digest and initial/financial public key fingerprints, plus a technical key fingerprint when required. All are 32-byte hexadecimal values. It does not upload documents or generate keys. Review shows UTC as well as your local deadline input. A wallet signature publishes directly to ProcurementWorkflow; no private key enters the frontend or backend.

The interface distinguishes signature approval, transaction submission, and confirmed publication. Confirmation requires a successful receipt with the expected TenderPublished event and matching metadata from the configured workflow. It displays the tender ID and offers a lookup through the public backend API. Changing wallet accounts or networks clears officer verification; reconnect before another publication.

Keep the page open while awaiting confirmation. It polls for about a minute, then offers manual confirmation checks; it never retries publication automatically. Pending transactions are not saved across reloads. For dropped, sped-up, or replaced transactions, inspect wallet activity before submitting again. Switch back to the original chain to check a pending hash.

## Verification

`npm run build` performs TypeScript checking and a Vite production build. `npm test` runs API and publication validation/receipt tests. From the repository root, `npm run test:publication` exercises the frontend wallet functions against the actual contracts on an isolated Hardhat EVM, including role checks, revoked access, publication, receipt verification, and public API lookup. Its EIP-1193 wallet adapter uses disposable local accounts; this does not replace manually checking your browser extension's approval dialog.

## Encrypted bidder submission added 1 November 2026

The bidder workspace verifies an approved wallet and an open tender, loads the next bid version and verifies opening public keys against the TenderPublished event. Files (one per required part, at most 1 MiB each) are encrypted locally before upload, including their filenames and media types. The shared protocol is in `backend/src/bid-protocol.ts`; the wallet client is `src/bid-client.ts`, and the screen is `src/BidderSubmission.tsx`, loaded as a separate browser chunk.

Save an encrypted backup, authorize its upload, then sign the separate blockchain bid transaction. Only a successful matching BidSubmitted receipt is shown as confirmed. The owner can retrieve and verify stored backups with a separate wallet signature. Pending transaction hash/context/evidence are retained in browser localStorage; plaintext and file bodies are not. After confirmation, prepare another bid version to replace the current active bid. An eligible encrypted backup can be restored without re-encrypting it. Withdrawal remains a contract/script operation.

Wallet/account/deployment changes invalidate preparation; a broadcast transaction remains tracked. Pending transaction replacement or dropped-transaction recovery requires wallet inspection. The UI does not automatically resubmit. See [root setup](../README.md#submit-an-encrypted-bid) and [the protocol](../documentation/Encrypted_Bid_Protocol.md). Real browser extension prompts and live TCP connectivity still need a manual check; the integration uses a disposable EIP-1193 adapter and injected HTTP.

## Commission and approval workspace updated 13 November 2026

`src/GovernanceWorkspace.tsx` adds a separately loaded actor screen, backed by `src/governance-client.ts`. Connect the assigned commission to close a tender, request stages and record admission/technical decisions. Each valid commission request immediately authorizes its stage. The app requires opening policy 2 and rejects older deployments.

The client validates actor/deployment, reads a consistent snapshot, reloads state before signing, simulates actions and verifies matching receipt events. Reviews show the actual signer and decision evidence. Pending public transaction metadata persists in localStorage; clear a confirmed receipt and reload the tender for updated state. No private keys or decrypted documents enter this screen. Actor reads use the wallet RPC; the public API is unchanged.

Run root `npm run test:governance` for the isolated real-EVM client integration and `npm test` here for input/receipt tests. See [the full actor guide](../documentation/Commission_Workspace.md) for ordering, state restrictions, tracking recovery, the 100-address prototype limit and manual browser verification still required.

## Award workflow added 3 November 2026

The actor client and workspace now support `selectBidder`, `decideFinalApproval` and `recordPublicExtract`. APPROVAL_ROLE wallets distinct from the tender commission can load the view. It displays the selected bidder, selection digest/time, final decision actor/reason/block and public extract digest. Selected remains provisional; Approved and Rejected are separate final outcomes.

Award reviews bind the selected bidder and selection evidence; extract replacement also retains the previous digest. Checks reload current role/state and validate the reviewed target before signing. Receipt parsing and restored pending metadata cover the new events and action fields. The unchanged public API continues to omit internal award identities.

Follow [Award_and_Final_Approval.md](../documentation/Award_and_Final_Approval.md). Root `npm run test:award` runs the isolated real-EVM award client/public-API integration. Selection and approval are human decisions; the award controls do not choose the best offer or prove external extract publication. The separate restricted document viewer can display verified commission-authorized text files. Concurrent extract replacement still needs operator coordination because the contract has no atomic expected-previous-digest check.

## Restricted documents and remote key custody

The assigned commission can sign a single-use request for one verified document, with fresh blockchain checks, integrity verification and persisted authorization audit. The separate document service runs on loopback port 3002; the public API never decrypts files. Local demonstration custody or HTTPS Vault Transit can be selected explicitly.

Follow [the setup and deployment guide](../documentation/Restricted_Documents_and_Key_Custody.md) for environment examples, local startup, Vault public-key export, external operator signing, diagrams and remaining production checks. From the root, `npm run test:documents` runs the isolated document-release integration. Live Vault/signing infrastructure and browser prompts still require manual validation.

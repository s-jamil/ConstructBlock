# constructBlock

Government-governed blockchain procurement capstone research prototype. The frontend provides public metadata lookups, wallet-signed tender publication for government officers, and encrypted bidder submission with persistent local storage.

## OrbitDB storage integration

The OrbitDB adapter stores encrypted document contents directly as database records. One local owner process serves both API and restricted viewer through a private socket; peer synchronization is disabled. Runtime dependencies are installed and STORAGE_PROVIDER=orbitdb is configured. The actual-engine tender workflow passes 15 checks through final approval. Deployed socket connectivity, import and service restart remain unverified because workspace socket access is restricted.

See [OrbitDB setup and migration](documentation/OrbitDB_Encrypted_Storage.md). Start with `npm run orbitdb:install` and `npm run test:orbitdb:live`, then start the database owner, import existing encrypted packages and select `STORAGE_PROVIDER=orbitdb`. The ordinary development launcher does not start the database owner. Run `npm run test:orbitdb:workflow` for the actual-engine workflow through injected HTTP handlers, and `npm run test:orbitdb:socket-workflow` for that workflow through the private storage socket. The direct workflow does not validate socket transport.

## Opening policy 2 migration

Updated 13 November 2026 to match the revised interim report. The assigned commission requests opening after the deadline; that transaction immediately authorizes the eligible stage. Custodian roles, approval transactions and approval-count screens have been removed. Government decryption-key management and separate final award approval remain in place.

The contracts are non-upgradeable. Existing deployments retain their original rules. Deploy a fresh contract pair without resetting the node, run `npm run configure:local` in backend, and restart the API and separate document service. Publish new tenders and submit new encrypted bids against the new addresses. Existing encrypted packages are bound to the original workflow and cannot be reused as submissions to a new deployment. Keep old deployment addresses and keys for existing records. Do not overwrite or delete them as a migration step.

The API, officer publication and actor workspace require `OPENING_POLICY_VERSION = 2` and reject older contracts with a configuration error. Deployment/configuration commands are shown below; this source update does not redeploy your running node or alter existing tenders.

## Start the dashboard and API together

Use a patched Node.js 24 LTS release. From this folder:

```bash
npm run install:apps
npm run dev
```

The launcher starts the API on **http://127.0.0.1:3001** and the frontend on **http://127.0.0.1:5173**. It does not start, reset or redeploy your blockchain. Keep your existing Hardhat node running in its own terminal. Press Ctrl+C to stop both apps.

The frontend sends relative `/api` and `/health` requests through Vite's local proxy; it does not need a private key, direct RPC URL or a backend CORS change. An unavailable backend/node produces an explicit disconnected/error state. There are no simulated live procurement records in the dashboard.

If the API or frontend is already running in another terminal, stop that instance first or start the apps separately instead:

```bash
npm --prefix backend run dev
```

In another terminal:

```bash
npm --prefix frontend run dev
```

## Connect a local deployment

Check `backend/.env` against the addresses printed by your latest deployment. A fresh `deploy:local` creates roles but no tender, so looking up tender 1 can legitimately return “not found.” The isolated walkthrough creates an ephemeral chain, separate from the dashboard's node.

If you need a new deployment, run these in the contracts folder with the local node already running:

```bash
npm run deploy:local
```

Then run `npm run configure:local` in the backend folder and restart the API. The saved deployment manifest is public-address configuration, not private keys. Do not redeploy merely because the frontend is disconnected; check API and blockchain readiness first.

`walkthrough:local` creates a separate demonstration pair and advances the shared development clock. To inspect that tender, put the two contract addresses from its report into `backend/.env` and restart the backend. Existing contract deployments are not automatically replaced by a walkthrough.

## Build and check

```bash
npm run build
npm test
npm run test:integration
npm run test:publication
npm run test:storage
npm run test:opening
npm run test:governance
npm run test:award
```

`npm run build` builds backend and frontend. `npm test` runs backend and frontend test suites. Integration checks use the actual contracts on an isolated Hardhat EVM without claiming live-node or TCP connectivity. Vite preview is for local build inspection, not production hosting.

## Components

- [Smart contracts](contracts/README.md): Solidity, Hardhat tests, deployment and synthetic tender walkthrough.
- [Backend](backend/README.md): API routes, environment configuration and validation.
- [Frontend](frontend/README.md): dashboard features, proxy configuration and usage.

Officer publication, encrypted bid uploads, narrowly scoped wallet-signed storage access and bidder-signed submissions are implemented. A protected part-retrieval endpoint and separate local opening worker are also implemented. Actor/award screens, restricted commission document viewing and a Vault custody adapter are now implemented. Live Vault/signing infrastructure, general login, PostgreSQL and Besu remain deployment or later work. The interface identifies the current local prototype and does not imply a live government service.

## Publish your first tender

1. Start the existing Hardhat node and run `npm run dev` here. Verify blockchain readiness in the dashboard.
2. Open the dashboard in a browser with an Ethereum wallet extension. Configure its local network: RPC `http://127.0.0.1:8545`, chain ID `31337`, currency symbol `ETH`.
3. Select the disposable officer account assigned by your deployment (see `contracts/deployments/localhost.json`). If importing a development account, obtain its test key directly from your own Hardhat console and enter it only in the wallet. Never use this public development account for real funds.
4. Click **Connect officer wallet**. The app verifies the deployed contracts and OFFICER_ROLE.
5. Enter the dossier digest, a future deadline, a commission wallet holding COMMISSION_ROLE, and the opening public key fingerprints. Review the values, then click **Sign and publish tender** and approve in your wallet.
6. After confirmation, click **View tender** to retrieve the new record through the backend.

Use real opening public keys for project workflows; the form records their fingerprints and does not generate or store them. The local test script uses synthetic fingerprints exclusively on an isolated test chain. See [frontend usage](frontend/README.md) for transaction tracking and limitations.

## Submit an encrypted bid

1. Generate local opening keys once, from this folder: `npm --prefix backend run keys:generate`. Retain the private files outside the API and copy the printed public fingerprints.
2. Start the existing node and `npm run dev`. Publish a **new tender** with those fingerprints and a future deadline. Old placeholder hashes cannot resolve to real public keys.
3. Switch your browser wallet to the approved **bidder** account from your deployment (not the officer).
4. In **Submit an encrypted bid**, enter the tender ID and select **Connect bidder and load tender**.
5. Choose one document per required part, at most 1 MiB each. Select **Prepare encrypted package**, review the digests, and save an encrypted backup.
6. Select **Sign and upload encrypted package** and approve the storage authorization message. The API stores only encrypted packages and returns a storage ID.
7. Select **Sign and submit bid on blockchain** and approve the transaction. Wait for the matching BidSubmitted confirmation. An upload alone is not a submitted bid.

Objects persist in `backend/storage`; public keys are in `backend/opening-keys`; development private keys are in `.constructblock-custody`. Restarting the API keeps stored objects. Restarting the ephemeral Hardhat node loses chain state and requires deployment reconfiguration. This does not delete files. Never point the API storage directories at private-key folders.

See [the encrypted bid protocol](documentation/Encrypted_Bid_Protocol.md) for formats, authentication, recovery and limits. The backend remains a blockchain reader; browser wallets and the separate opening operator send contract transactions. Key generation is a development helper, not production government custody.

## Open and verify a submitted bid

The separate operator workflow now checks commission opening authorization, retrieves only the authorized part, verifies decryption and commitments, and records a matching OpeningResult receipt. The public API never reads private opening keys. Opening policy 2 requires a fresh deployment of the revised contracts; see the migration instructions above.

See [Protected_Opening_Service.md](documentation/Protected_Opening_Service.md) for the request/verify commands, stage prerequisites, report handling and failure rules. Start with the initial part after the tender deadline. Use `npm run test:opening` to run the complete isolated integration test without changing your running node. Local custody files and unlocked Hardhat accounts are development mechanisms, not production key management. Commission and approval screens are now available in the browser.

## Commission and approval wallet actions

Open **Commission & approval** in the sidebar, load a tender with its assigned commission or a separate final-approver wallet, then review and sign each action. The workspace supports closure, initial/technical/financial opening requests, admission/exclusion and technical acceptance/rejection. It shows verification outcomes from the separate operator service and confirmed transaction receipts. Keep real decision documents off chain and use their evidence digests.

See [the actor workspace guide](documentation/Commission_Workspace.md). `npm run test:governance` runs 13 real-EVM scenarios through the browser client functions. Use the revised opening policy 2 deployment. Selection, separate final approval and extract recording are now included. Restricted document viewing is implemented through the separate document service; opening decryption remains in the operator worker.

## Selection and final approval

The same actor workspace now supports commission selection, separate government approval or rejection, and public extract digest recording. Select an eligible financially verified bidder only after all eligible financial outcomes finish. Switch to the APPROVAL_ROLE wallet from your latest deployment for final approval; the commission cannot approve its own selection. Reload after confirmation to see the final actor and evidence.

Recording a public extract digest does not publish a document. It can be recorded or replaced in Selected, Approved or Rejected, with an explicit review of the previous digest. See [the award guide](documentation/Award_and_Final_Approval.md) for the complete flow and concurrency limits. `npm run test:award` exercises 13 real-EVM scenarios plus public final-state reads. Use the revised opening policy 2 deployment.

## Restricted documents and remote key custody

The assigned commission can sign a single-use request for one verified document, with fresh blockchain checks, integrity verification and persisted authorization audit. The separate document service runs on loopback port 3002; the public API never decrypts files. Local demonstration custody or HTTPS Vault Transit can be selected explicitly.

Follow [the setup and deployment guide](documentation/Restricted_Documents_and_Key_Custody.md) for environment examples, local startup, Vault public-key export, external operator signing, diagrams and remaining production checks. From the root, `npm run test:documents` runs the isolated document-release integration. Live Vault/signing infrastructure and browser prompts still require manual validation.

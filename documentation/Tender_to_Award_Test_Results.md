# Tender creation through bid award testing

Test date: 14 November 2026. The automated lifecycle passed on isolated real Hardhat contracts. Browser wallet prompts and the deployed application remain unverified. OrbitDB socket testing was blocked by the workspace permission error `listen EPERM`.

## Results

| Check | Result |
| --- | --- |
| Backend and frontend production build | Passed |
| Backend unit tests | 72 passed |
| Frontend unit tests | 79 passed |
| Contract tests | 36 passed |
| Backend and EVM integration | 12 passed |
| Officer publication | 5 passed |
| Encrypted bid upload and submission | 9 passed |
| Protected opening and cryptographic verification | 13 passed |
| Commission governance | 13 passed |
| Selection and final approval or rejection | 13 passed |
| Restricted documents with filesystem storage | 14 passed |
| Actual OrbitDB engine workflow through Approved | 15 passed |
| OrbitDB socket workflow | Blocked before workflow execution by `listen EPERM` |
| Interactive browser and wallet prompts | Not run because browser access host was unavailable |

Total: 281 passing automated tests and scenario checks across these suites. Suites overlap in lifecycle coverage; this is not a count of distinct requirements. No application or contract source changes were needed. Tests used temporary synthetic documents and disposable actors, not the running blockchain or existing bid storage.

## Step coverage and browser acceptance checklist

The automated column records tests actually run. The browser column is a checklist for the remaining interactive acceptance run; none of its steps is claimed as manually passed.

| Step | Actor and action | Automated result | Browser acceptance expectation |
| --- | --- | --- | --- |
| 1 | Verify chain and deployment readiness | Passed backend integration | Dashboard reports the expected chain, linked registry and opening policy 2 |
| 2 | Officer connects wallet | Passed publication | Officer role accepted; wrong network and unrelated wallet rejected |
| 3 | Officer enters dossier digest, future deadline, assigned commission and opening key fingerprints | Passed publication and unit tests | Review shows exact values; invalid values cannot publish |
| 4 | Officer signs publication | Passed publication | Matching confirmation produces a tender ID and public state Open |
| 5 | Approved bidder connects and loads tender | Passed storage | Correct required parts and current bid version shown |
| 6 | Bidder selects documents and prepares encrypted package | Passed storage and unit tests | Required parts encrypted; displayed digests and encrypted backup available |
| 7 | Bidder signs upload authorization | Passed storage | Content ID returned; upload alone does not indicate bid submission |
| 8 | Bidder signs blockchain submission | Passed storage | Matching BidSubmitted receipt; submitted evidence matches encrypted package |
| 9 | Bidder replaces or withdraws before deadline | Passed contract tests | Replacement increments version; withdrawal affects only own bid; old evidence retained |
| 10 | Deadline passes and assigned commission closes tender | Passed contracts and governance | Early closure rejected; confirmed closure shown after deadline |
| 11 | Commission requests initial opening | Passed governance and opening | Request immediately authorizes initial stage under policy 2 |
| 12 | Separate opening operator verifies initial parts | Passed opening with real RSA and AES decryption | Pending changes to Verified or Failed only after operator receipt |
| 13 | Commission views verified initial documents | Passed documents | Scoped wallet signature releases only authorized verified part; other roles denied |
| 14 | Commission admits or excludes each active bid using decision digest | Passed governance | Pending or failed verification cannot be admitted; all reviews completed |
| 15 | Commission requests technical opening when required | Passed governance and opening | Separate authorization; technical material inaccessible beforehand |
| 16 | Operator verifies technical parts and commission accepts or rejects them | Passed opening and governance | Verified documents viewable; human technical decisions completed |
| 17 | Commission requests financial opening | Passed opening and governance | Admission and required technical decisions enforced; optional technical stage omitted |
| 18 | Operator verifies all eligible financial parts | Passed opening and award | Financial documents require their own Verified outcome; incomplete outcomes block selection |
| 19 | Commission selects eligible bidder with selection decision digest | Passed award | State Selected; selection remains provisional |
| 20 | Separate approver approves or rejects with evidence digest | Both paths passed award | Correct final state Approved or Rejected; commission self-approval and repeated decisions rejected |
| 21 | Commission records or replaces public extract digest | Passed award | Matching extract receipt; stale review detected; digest recording does not publish a document |
| 22 | Read final public record | Passed award and OrbitDB workflow | Final state and extract digest visible; restricted fields absent from public API |

For every browser transaction, verify the matching confirmed receipt, clear tracking, and reload before the next action. Record the actual tender ID, bid version, transaction hashes and observed state in the acceptance evidence. Use synthetic local test documents and digests derived from those records.

## Running the interactive acceptance test

Use the existing deployment and role addresses in `contracts/deployments/localhost.json`. Do not reset the node or redeploy merely to run this checklist. Verify readiness first; an older contract requires the documented policy 2 migration.

The configured provider is OrbitDB. Confirm the existing database owner is healthy with `npm run orbitdb:status`; if no owner exists, start it using the storage guide. Do not start a second owner against a locked database. Start the API and frontend with `npm run dev`. Configure the separate document service using `Restricted_Documents_and_Key_Custody.md`, then run `npm --prefix backend run documents:dev` in another terminal.

Generate and retain opening keys only if suitable keys do not already exist. Publish a new tender using the actual retained public fingerprints. Complete the checklist with the officer, bidder, assigned commission and separate approver wallets from the deployment manifest. Use a short future deadline and wait for it; do not advance the shared development clock. An idle local chain may need a normal new block before its timestamp reflects the deadline.

After each commission opening request, run the separate operator for every eligible submitted bidder and part. From the project root:

```bash
npm --prefix backend run opening:local -- verify --tender TENDER_ID --bidder BIDDER_ADDRESS --version VERSION --part initial --actor OPENING_SERVICE_ADDRESS --custody-dir ABSOLUTE_CUSTODY_DIRECTORY
```

Substitute actual values. Repeat for `technical` when required, then `financial`, only after the corresponding commission request and prior decisions. The worker records verification; commission admission, technical decisions, selection and final approval remain separate actions. See `Protected_Opening_Service.md`, `Commission_Workspace.md` and `Award_and_Final_Approval.md` for form and operator details.

## Reproduce the automated run

From `Implementation/constructBlock`:

```bash
npm run build
npm test
npm --prefix contracts test
npm run test:integration
npm run test:publication
npm run test:storage
npm run test:opening
npm run test:governance
npm run test:award
npm run test:documents
npm run test:orbitdb:workflow
npm run test:orbitdb:socket-workflow
```

This workspace required its pre-existing temporary Hardhat compiler-cache override, `NODE_OPTIONS=--import=/tmp/constructblock-hardhat-cache.mjs`, for contract commands because the default global cache is outside writable paths. This is a local test setup detail, not a repository configuration change. The helper points Hardhat at `/tmp/constructblock-hardhat-cache`. Normal terminal execution may not need it.

The initial contract commands were interrupted after making no progress with the default cache; rerunning with that override passed. The socket command was attempted with the same override and failed at socket creation, before lifecycle checks. No socket success or deployed migration is inferred from the direct-engine pass. Live Vault, external signing, real TCP routing, browser rendering, extension rejection/recovery and persistence across deployed service restarts remain outside this run.

## Retained evidence

Raw logs, including the blocked socket attempt, are in `test-results/2026-11-14/`. Refreshed scenario reports are in `contracts/reports/`: `bid-storage-smoke.json`, `opening-smoke.json`, `governance-smoke.json`, `award-smoke.json`, `document-smoke.json` and `orbitdb-direct-workflow.json`. Read each report's generated timestamp; older socket reports are not evidence of success in this run.

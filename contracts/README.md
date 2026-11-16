# constructBlock smart contracts

First implementation of the government-governed research prototype. The outer `contracts` folder contains the Hardhat project; the inner `contracts` folder contains Solidity source.

## Files

- `contracts/RoleRegistry.sol`: government role administration, bidder approval/revocation, delayed two-step administrator transfer.
- `contracts/ProcurementWorkflow.sol`: tenders, commitments, version history, withdrawal, deadlines, commission-authorized staged opening, human decisions, separate final approval, extract digests, pause and cancellation.
- `test/procurement.ts`: governance, deadline, bid version, custody, verification failure and end-to-end workflow tests.
- `scripts/deploy.ts`: local deployment with separate fictional government actors and a bidder.
- `scripts/walkthrough.ts`: complete synthetic tender demonstration with encrypted parts, commission-authorized opening and a JSON evidence report.

## Start

Use an up-to-date patched Node.js 24 LTS release:

```bash
cd ~/Desktop/Capstone/Implementation/constructBlock/contracts
npm install
npm run build
npm test
```

The initial install creates `package-lock.json`. Commit it after resolving and testing the dependencies; use `npm ci` subsequently. OpenZeppelin and the compiler are pinned; Hardhat and plugin compatibility must be verified together on initial installation.

To deploy, start `npm run node` in one terminal. In another terminal in the same folder run `npm run deploy:local`. The script only permits local chain ID 31337 and prints public addresses, not private keys. The script also saves public deployment information to `deployments/localhost.json`, which the backend can import with `npm run configure:local`. Its Hardhat accounts are disposable test identities. Besu configuration and permissioning are subsequent work.

## Repeatable tender walkthrough

Run the complete demonstration without starting a separate node:

```bash
npm run walkthrough
```

It deploys a fresh pair of contracts to an isolated Hardhat chain and runs a fictional tender with initial, technical and financial parts. It generates AES-GCM encrypted documents, wraps the part keys and salts with government RSA-OAEP keys, checks on-chain hashes and commitments, requires a separate commission request per stage, records human decisions and reaches final approval. Each run writes `reports/walkthrough-<timestamp>.json` containing transaction hashes, block numbers, verification checks and limitations, without keys or bid contents.

The default demonstration is ephemeral. Its report is retained, but the chain disappears when the script finishes. This is a workflow and cryptographic demonstration, not a benchmark or evidence of real government custody isolation: all roles and keys are simulated in one process.

To retain the demonstration transactions on your running local node, use:

```bash
npm run walkthrough:local
```

That command deploys a separate demonstration pair; it does not reuse or replace the contracts printed by `deploy:local`. It advances the shared development node's clock by one hour to reach the synthetic deadline, which can also move existing tenders past their deadlines. Use the isolated command when you want to leave the shared node untouched.

## Workflow

1. Government grants officer, commission, opening-service, final-approval and bidder roles.
2. Officer publishes a dossier digest, future deadline, assigned commission, required parts and opening-key fingerprints.
3. An approved bidder submits evidence from its own wallet. First version is 1; replacements or resubmissions increment by exactly one. Each part includes a salted commitment, ciphertext hash and wrapped-key-package hash. Confirm successful receipts before displaying a bid as accepted.
4. Before the deadline the bidder can withdraw or replace. Transactions at/after the deadline fail even if the tender is not explicitly closed yet.
5. The assigned commission closes the tender and requests an opening stage. The commission request immediately authorizes the eligible stage after the deadline.
6. A trusted opening service attests per-bid verification. Human admission decisions follow initial verification. Failed verification is held for human review; failed initial records cannot be admitted.
7. If configured, separate technical offers are opened and assessed before eligible financial parts. All required initial/technical reviews must finish before financial opening.
8. After all eligible financial outcomes are recorded, the commission selects a verified bid. A different government approval address accepts or rejects the selection. Public extract digests are separate events.

## Boundaries and assumptions

Only hashes, commitments, pseudonymous addresses, versions and evidence digests belong on-chain. Do not pass documents, ciphertext, plaintext, salts, private keys, passwords or personal data to a contract. Solidity `private` is not confidentiality: node operators can read chain state/events. Public views need API filtering.

Nonzero hashes are opaque references, not proof that a document exists or is correct. Contracts do not encrypt, decrypt, verify a plaintext commitment or prove the opening service is truthful. Implement those checks in the browser and protected opening service. Document commitments use the architecture's external SHA-256 protocol; role identifiers use Ethereum keccak256. Do not mix them.

The government is trusted: it can grant roles, transfer administration, pause and cancel. Commission opening authorization is a software control. Key management remains trusted and does not implement threshold decryption. Revocation blocks future role-protected calls; it does not erase evidence or automatically exclude an existing bid.

This version uses global approved roles plus tender-assigned officers and commissions. Finer tender-specific custody/service/approval delegations, identity verification and commission-member voting remain future work. Published tenders cannot yet be amended or reassigned; publish a new tender when configuration changes are needed.

Opening outcomes cannot be overwritten or retried in this version. Failed records require a human exclusion or unsuccessful-tender decision; a governed retry/correction protocol is future work. The commission can declare an unsuccessful tender at its discretion with a reason digest. This is not an automatic proof that every offer failed.

Recording an extract hash does not prove actual website publication. Login, encrypted storage, key escrow, upload idempotency, receipt reconciliation, notifications, legal timing, retention, backup and recovery remain off-chain work. Completion and publication-record timestamps support later evaluation but do not certify legal compliance.

Contracts are non-upgradeable, contain no payments and have not received an independent security audit. They are a capstone starting implementation, not a completed procurement platform.

## Verification status

Verified on 23 October 2026 after dependencies became available:

- All **34 Mocha contract tests passed** using `npm test`.
- The complete isolated walkthrough reached **Approved** after **27 confirmed actions**.
- Initial, technical and financial parts passed ciphertext/package hash checks, authenticated decryption and contextual salted-commitment verification.
- Modified ciphertext was detected, and selection remained distinct from final approval.
- TypeScript validation uses `npx tsc --noEmit`.

The walkthrough's single-bidder synthetic result does not replace the proposal's ten-tender, negative-case, audit and throughput experiments. Existing-node access at `localhost:8545` was unavailable from the agent session; the successful run used an isolated local Hardhat chain.

## Official technical references

- https://hardhat.org/docs/getting-started
- https://hardhat.org/docs/guides/testing/using-ethers
- https://hardhat.org/docs/reference/configuration
- https://docs.openzeppelin.com/contracts/5.x/access-control
- https://docs.openzeppelin.com/contracts/5.x/api/access

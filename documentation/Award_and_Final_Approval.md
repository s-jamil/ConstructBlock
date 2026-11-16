# Bidder selection and final approval

Updated 13 November 2026 for the commission and approval workspace. Award functions retain separate final approval. The revised opening workflow requires a fresh policy 2 deployment as described in the root README.

## Browser workflow

1. Start the node and `npm run dev`. Open http://127.0.0.1:5173 and choose **Commission & approval**, which now also supports the final approver.
2. Load the tender with its assigned commission wallet after the financial stage has been authorized and the opening service has recorded every eligible financial outcome.
3. Enter the hash of the actual selection decision record in **Decision or public extract evidence digest**. Review **Select bidder** on an eligible active bid with Verified financial evidence. Selection is a human decision; the application does not rank prices or choose the best contractor automatically.
4. Sign and confirm the selection transaction. Clear the receipt and reload. The tender is **Selected**, and the screen labels the selection provisional until separate approval. It shows the selected bidder, selection evidence and recorded time.
5. Switch to a government wallet with APPROVAL_ROLE and reload the tender. This address must differ from the selecting commission, even if the commission also holds APPROVAL_ROLE. Enter the actual approval/rejection record digest, review **Approve selection** or **Reject selection**, and sign.
6. After receipt confirmation, reload to see **Approved** or **Rejected**, the final decision actor, reason digest and block. A recorded final decision cannot be overwritten.
7. As the assigned commission, enter a public extract digest and review **Record public extract digest**. The contract permits recording in Selected, Approved or Rejected. The transaction records a hash; it does not upload the extract, publish it to a website or approve a provisional selection.

Award controls show actor metadata and evidence hashes; they do not verify that decision or extract source documents exist. A separate restricted commission document viewer and Vault custody adapter are now implemented; see Restricted_Documents_and_Key_Custody.md. The browser does not perform decryption or receive opening keys.

## Selection checks

The client requires the assigned commission, an unpaused FinancialOpening state, zero pending financial outcomes, and the reviewed current active bidder version. The bidder must be admitted, technically accepted when required, and have Verified financial evidence. Failed financial evidence cannot be selected. The contract independently enforces its state/outcome checks.

A selection review records the exact bidder, version and nonzero decision digest. Rechecking the wallet, deployment, roles and state precedes simulation, gas estimation and wallet submission. The successful receipt must contain the matching SelectionRecorded event from the workflow and originate from the reviewed commission transaction.

## Separate approval

The actor snapshot now recognizes an eligible final-approver wallet independently of commission roles. Final approval/rejection requires a Selected tender and an actor holding APPROVAL_ROLE distinct from the tender commission. The review binds the selected bidder and selection digest, and rejects a changed selection, stale stage, revoked role or cancelled tender before submission. The contract rejects competing or repeated decisions after the first successful state change.

A successful StateChanged event must match Approved or Rejected, its actor and the reviewed reason digest. Reloaded snapshots derive the final actor, reason and recorded block from the unique final StateChanged event. Final decision outcomes are shown separately from the provisional selection.

## Extract recording and replacement

Only the assigned commission can record an extract digest, including a rejection extract. The review shows the selected bidder and selection evidence, the previous extract digest, and the proposed new digest. A changed prior digest detected before submission invalidates the review and requires a reload. The receipt must contain the exact PublicExtractRecorded digest.

The unchanged contract allows extract replacement and has no compare-and-swap parameter. Another commission transaction changing the digest after preflight, while the wallet dialog is open or before mining, cannot be atomically prevented by a frontend check. Coordinate replacements and inspect the resulting on-chain state. Never interpret a recorded digest as proof of external publication or legal compliance.

The public tender API retains its existing field allowlist. Its state and public-extract digest reflect Approved or Rejected after chain confirmation, but it does not newly expose selected bidder identity, internal selection digest or final actor details. Those actor details are read through the connected wallet RPC; this is not a confidentiality boundary around the underlying blockchain.

## Confirmation and recovery

The existing review and tracking system covers all new action types. It checks transaction hash, sender, destination, emitting contract and exact event data. Pending metadata retains the reviewed bidder/selection/extract context in localStorage. No plaintext or keys are stored there. A reverted or mismatched receipt is not a successful award, and actions are not automatically resubmitted. Inspect wallet activity for dropped or replaced transactions and reload before another action.

## Verification

Run from the repository root:

```bash
npm run build
npm test
npm --prefix contracts test
npm run test:governance
npm run test:award
```

The award integration uses the actual browser client functions and a public API handler on an isolated Hardhat EVM. Its 13 scenarios cover wrong actors/networks, stage and pending-outcome checks, failed bidders, reviewed versions, commission self-approval, paused/revoked approvers, stale selection/extract reviews, approval and rejection, cancellation after selection, receipt matching and filtered public final-state reads. Results are retained in `contracts/reports/award-smoke.json`.

Unit tests cover zero/invalid award fields, selection receipts, distinct approval/rejection events, actor/reason/extract mismatches and restored pending action context. Prior commission workflow integration is rerun for regression. Real browser extension prompts and UI clicks remain manual verification. Verification attestations in the award integration are synthetic; the separate opening suite tests actual decryption.

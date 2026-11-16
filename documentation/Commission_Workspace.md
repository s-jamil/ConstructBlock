# Commission and approval workspace

Updated 13 November 2026 to match the revised interim report. The assigned commission authorizes each opening stage through `requestOpening`. No additional human approval is required. Government key management remains separate from document storage and the public API.

## How to use it

1. Deploy the revised policy 2 contracts and configure the API as described in the root README. Keep the Hardhat node running and start `npm run dev`.
2. Open http://127.0.0.1:5173, choose **Commission & approval**, enter a tender ID and connect its assigned commission wallet. A separate final-approver wallet can also load the workspace.
3. After the chain deadline, review and sign **Close tender**, confirm its receipt, clear it and reload.
4. Review and sign **Authorize initial opening**. This commission request immediately authorizes the stage and changes the tender to InitialOpening. Confirm the receipt and reload. There is no intervening approval step.
5. Run the separate opening worker with the opening-service actor and matching government keys. The browser holds no private opening keys. Reload to see Verified or Failed outcomes.
6. Enter the actual decision-record digest, then review and sign admission or exclusion. Pending outcomes cannot be decided; failed verification cannot be admitted.
7. When required initial verification and admission decisions finish, authorize technical opening if configured and at least one bid is admitted. Run the worker, then record technical acceptance or rejection.
8. When all required preceding decisions finish and at least one bid is eligible, authorize financial opening and run the financial worker. A tender without a technical offer proceeds from initial admission directly to financial opening.
9. Select an eligible financially verified bidder after all financial outcomes finish. A separate APPROVAL_ROLE address approves or rejects selection. See Award_and_Final_Approval.md.
10. Start the restricted document service separately to view eligible Verified parts as the assigned commission. See Restricted_Documents_and_Key_Custody.md.

## Role guidance and evidence entry

A final approver can inspect the tender but cannot authorize commission openings, record admission decisions or view confidential documents. The workspace now displays the assigned commission address beside this explanation. Use that wallet for commission actions; the final-approval controls appear after bidder selection.

The evidence digest field appears for commission decision stages and for a final approver at the Selected stage. Its label, full-width hash input and help text occupy separate rows. Enter a nonzero 32-byte hash (0x followed by 64 hexadecimal characters), not a wallet address. Invalid nonempty input shows an inline validation message. The pending count refers to the current opening stage and may be zero before opening is requested even though individual bid outcomes still say Pending.

## Authorization and evidence

The client checks chain ID, code, registry linkage, opening policy version 2, assigned commission/current role, pause, deadline, stage, active version and preceding decisions. The contract independently enforces opening prerequisites and rejects duplicate requests. The backend and opening worker check stage authorization and eligibility again before key access or release. Direct node access is not a confidentiality boundary around blockchain metadata.

The actor snapshot uses one block and discovers bidder addresses from BidSubmitted events, retaining withdrawn status. This prototype refuses more than 100 distinct bidder addresses; larger deployments require indexed reads. Public API fields remain limited to published metadata.

A request receipt must contain exactly one matching OpeningRequested, OpeningAuthorized and target StateChanged event from the reviewed workflow, tender, part and commission. Human decisions require matching actor, bidder, acceptance and evidence fields. A recorded digest does not establish that its source document exists or that a human decision is correct.

## Transaction recovery

Account, network or deployment changes invalidate prepared reviews. Broadcast transaction hashes remain tracked in browser localStorage. Reload the tender after confirmation. Stopping tracking does not cancel the transaction; inspect wallet activity before retrying. Stored obsolete approval actions are rejected by the action validator. Pending transactions on older deployments must be reconciled against that deployment independently.

Actions use chain time. An idle Hardhat node may need a new block before its latest timestamp reflects a passed deadline. The interface never advances the clock.

## Verification

`npm run test:governance` exercises actual browser-client functions on an isolated Hardhat EVM with a disposable EIP-1193 adapter. Scenarios cover policy compatibility, unrelated actors, wrong commission/network, role/account changes, pause, early closure/opening, immediate commission authorization, duplicate requests, incomplete reviews, failed verification, admission/exclusion, technical decisions and optional technical-stage omission. The retained report is contracts/reports/governance-smoke.json.

Unit tests cover removed approval actions, transaction recovery and receipt matching, including missing authorization/transition events, wrong parts and duplicate events. Real browser-extension prompts and interactive clicks remain manual validation. Decryption is exercised separately by `npm run test:opening` and `npm run test:documents`.

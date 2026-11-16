// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RoleRegistry} from "./RoleRegistry.sol";

/// @title Government-governed procurement state machine for constructBlock
/// @notice Stores hashes, commitments and signed workflow evidence, never bid
///         plaintext, salts, ciphertext, decryption keys or personal records.
/// @dev No payments, proxies, external document fetches or on-chain decryption.
///      Government key management and opening services remain trusted for off-chain confidentiality.
contract ProcurementWorkflow {
    uint8 public constant OPENING_POLICY_VERSION = 2;
    enum State { Open, Closed, InitialOpening, TechnicalReview, FinancialOpening,
        Selected, Approved, Cancelled, Unsuccessful, Rejected }
    enum Part { Initial, Technical, Financial }
    enum Outcome { Pending, Verified, Failed }

    struct Evidence {
        bytes32 commitment;
        bytes32 ciphertextHash;
        bytes32 wrappedPackageHash;
    }
    struct Bid {
        uint64 version;
        bool active;
        bool admissionRecorded;
        bool admitted;
        bool technicalDecisionRecorded;
        bool technicalAccepted;
    }
    struct Opening {
        bool requested;
        bool authorized;
    }
    struct Tender {
        address officer;
        address commission;
        uint64 deadline;
        bool requiresTechnicalOffer;
        State state;
        bytes32 dossierDigest;
        uint256 activeBids;
        uint256 pendingOpenings;
        uint256 admissionDecisions;
        uint256 admittedBids;
        uint256 technicalDecisions;
        uint256 financialEligibleBids;
        address selectedBidder;
        bytes32 selectionDigest;
        bytes32 publicExtractDigest;
        uint64 commissionCompletedAt;
    }

    RoleRegistry public immutable registry;
    uint256 public tenderCount;
    bool public paused;
    mapping(uint256 => Tender) private tenders;
    mapping(uint256 => mapping(address => Bid)) private bids;
    mapping(uint256 => mapping(address => mapping(uint64 => mapping(Part => Evidence)))) private evidence;
    mapping(uint256 => mapping(Part => Opening)) private openings;
    mapping(uint256 => mapping(address => mapping(Part => Outcome))) private outcomes;

    error Unauthorized();
    error InvalidInput();
    error UnknownTender();
    error WrongState();
    error DeadlineViolation();
    error PlatformPaused();
    error InvalidBid();
    error InvalidOpening();
    error IncompleteReview();

    event PauseChanged(bool paused, address indexed actor);
    event TenderPublished(uint256 indexed tenderId, address indexed officer,
        address indexed commission, uint64 deadline, bool requiresTechnicalOffer,
        bytes32 dossierDigest, bytes32[3] openingKeyFingerprints);
    event BidSubmitted(uint256 indexed tenderId, address indexed bidder, uint64 version,
        Evidence initialPart, Evidence technicalPart, Evidence financialPart);
    event BidWithdrawn(uint256 indexed tenderId, address indexed bidder, uint64 version);
    event StateChanged(uint256 indexed tenderId, State state, address indexed actor, bytes32 reasonDigest);
    event OpeningRequested(uint256 indexed tenderId, Part part, address indexed commission);
    event OpeningAuthorized(uint256 indexed tenderId, Part part);
    event OpeningResult(uint256 indexed tenderId, address indexed bidder, uint64 version,
        Part part, Outcome outcome, bytes32 resultDigest, address indexed service);
    event AdmissionRecorded(uint256 indexed tenderId, address indexed bidder, bool admitted, bytes32 reasonDigest);
    event TechnicalDecisionRecorded(uint256 indexed tenderId, address indexed bidder, bool accepted, bytes32 reasonDigest);
    event SelectionRecorded(uint256 indexed tenderId, address indexed bidder, bytes32 decisionDigest);
    event PublicExtractRecorded(uint256 indexed tenderId, bytes32 extractDigest, uint64 recordedAt);

    constructor(RoleRegistry roleRegistry) {
        if (address(roleRegistry).code.length == 0) revert InvalidInput();
        registry = roleRegistry;
    }

    modifier running() {
        if (paused) revert PlatformPaused();
        _;
    }

    function _requireRole(bytes32 role) private view {
        if (!registry.hasRole(role, msg.sender)) revert Unauthorized();
    }

    function _tender(uint256 id) private view returns (Tender storage t) {
        if (id == 0 || id > tenderCount) revert UnknownTender();
        return tenders[id];
    }

    function _commission(Tender storage t) private view {
        _requireRole(registry.COMMISSION_ROLE());
        if (msg.sender != t.commission) revert Unauthorized();
    }

    function _validEvidence(Evidence calldata e) private pure returns (bool) {
        return e.commitment != bytes32(0) && e.ciphertextHash != bytes32(0)
            && e.wrappedPackageHash != bytes32(0);
    }

    function setPaused(bool value) external {
        _requireRole(registry.DEFAULT_ADMIN_ROLE());
        paused = value;
        emit PauseChanged(value, msg.sender);
    }

    /// @notice Dossier digest covers the published dossier and criteria. Key
    ///         fingerprints are for initial, optional technical and financial parts.
    function publishTender(bytes32 dossierDigest, uint64 deadline,
        bool requiresTechnicalOffer, address commission, bytes32[3] calldata keyFingerprints)
        external running returns (uint256 id)
    {
        _requireRole(registry.OFFICER_ROLE());
        if (dossierDigest == bytes32(0) || deadline <= block.timestamp
            || !registry.hasRole(registry.COMMISSION_ROLE(), commission)
            || keyFingerprints[0] == bytes32(0) || keyFingerprints[2] == bytes32(0)
            || (requiresTechnicalOffer && keyFingerprints[1] == bytes32(0))) revert InvalidInput();
        id = ++tenderCount;
        Tender storage t = tenders[id];
        t.officer = msg.sender;
        t.commission = commission;
        t.deadline = deadline;
        t.requiresTechnicalOffer = requiresTechnicalOffer;
        t.dossierDigest = dossierDigest;
        emit TenderPublished(id, msg.sender, commission, deadline,
            requiresTechnicalOffer, dossierDigest, keyFingerprints);
    }

    /// @notice Caller signs its own bid. A version must be exactly previous + 1.
    ///         Replacement leaves earlier evidence intact and invalidates its eligibility.
    function submitBid(uint256 id, uint64 version, Evidence calldata initialPart,
        Evidence calldata technicalPart, Evidence calldata financialPart) external running
    {
        _requireRole(registry.BIDDER_ROLE());
        Tender storage t = _tender(id);
        if (t.state != State.Open) revert WrongState();
        if (block.timestamp >= t.deadline) revert DeadlineViolation();
        if (!_validEvidence(initialPart) || !_validEvidence(financialPart)
            || (t.requiresTechnicalOffer && !_validEvidence(technicalPart))) revert InvalidInput();
        if (!t.requiresTechnicalOffer && (technicalPart.commitment != bytes32(0)
            || technicalPart.ciphertextHash != bytes32(0)
            || technicalPart.wrappedPackageHash != bytes32(0))) revert InvalidInput();
        Bid storage b = bids[id][msg.sender];
        if (version != b.version + 1) revert InvalidBid();
        if (!b.active) ++t.activeBids;
        b.version = version;
        b.active = true;
        evidence[id][msg.sender][version][Part.Initial] = initialPart;
        evidence[id][msg.sender][version][Part.Technical] = technicalPart;
        evidence[id][msg.sender][version][Part.Financial] = financialPart;
        emit BidSubmitted(id, msg.sender, version, initialPart, technicalPart, financialPart);
    }

    function withdrawBid(uint256 id) external running {
        _requireRole(registry.BIDDER_ROLE());
        Tender storage t = _tender(id);
        if (t.state != State.Open) revert WrongState();
        if (block.timestamp >= t.deadline) revert DeadlineViolation();
        Bid storage b = bids[id][msg.sender];
        if (!b.active) revert InvalidBid();
        b.active = false;
        --t.activeBids;
        emit BidWithdrawn(id, msg.sender, b.version);
    }

    function closeTender(uint256 id) external running {
        Tender storage t = _tender(id);
        _commission(t);
        if (t.state != State.Open) revert WrongState();
        if (block.timestamp < t.deadline) revert DeadlineViolation();
        _changeState(id, t, State.Closed, bytes32(0));
    }

    function requestOpening(uint256 id, Part part) external running {
        Tender storage t = _tender(id);
        _commission(t);
        if (block.timestamp < t.deadline) revert DeadlineViolation();
        if (openings[id][part].requested) revert InvalidOpening();
        if (part == Part.Initial) {
            if (t.state != State.Closed || t.activeBids == 0) revert WrongState();
        } else if (part == Part.Technical) {
            if (!t.requiresTechnicalOffer || t.state != State.InitialOpening
                || t.pendingOpenings != 0 || t.admissionDecisions != t.activeBids
                || t.admittedBids == 0) revert IncompleteReview();
        } else {
            State required = t.requiresTechnicalOffer ? State.TechnicalReview : State.InitialOpening;
            if (t.state != required || t.pendingOpenings != 0
                || t.admissionDecisions != t.activeBids
                || (t.requiresTechnicalOffer && t.technicalDecisions != t.admittedBids)
                || t.financialEligibleBids == 0) revert IncompleteReview();
        }
        Opening storage o = openings[id][part];
        o.requested = true;
        o.authorized = true;
        emit OpeningRequested(id, part, msg.sender);
        if (part == Part.Initial) {
            t.pendingOpenings = t.activeBids;
            _changeState(id, t, State.InitialOpening, bytes32(0));
        } else if (part == Part.Technical) {
            t.pendingOpenings = t.admittedBids;
            _changeState(id, t, State.TechnicalReview, bytes32(0));
        } else {
            t.pendingOpenings = t.financialEligibleBids;
            _changeState(id, t, State.FinancialOpening, bytes32(0));
        }
        emit OpeningAuthorized(id, part);
    }

    /// @notice A trusted service attests an off-chain cryptographic verification.
    ///         This transaction does not itself decrypt or prove off-chain correctness.
    function recordOpeningResult(uint256 id, address bidder, uint64 version,
        Part part, bool verified, bytes32 resultDigest) external running
    {
        _requireRole(registry.OPENING_SERVICE_ROLE());
        Tender storage t = _tender(id);
        State expected = part == Part.Initial ? State.InitialOpening
            : (part == Part.Technical ? State.TechnicalReview : State.FinancialOpening);
        if (t.state != expected || !openings[id][part].authorized) revert WrongState();
        Bid storage b = bids[id][bidder];
        if (!b.active || b.version != version || outcomes[id][bidder][part] != Outcome.Pending)
            revert InvalidBid();
        if (part != Part.Initial && !b.admitted) revert InvalidBid();
        if (part == Part.Financial && t.requiresTechnicalOffer && !b.technicalAccepted)
            revert InvalidBid();
        if (resultDigest == bytes32(0)) revert InvalidInput();
        Outcome outcome = verified ? Outcome.Verified : Outcome.Failed;
        outcomes[id][bidder][part] = outcome;
        --t.pendingOpenings;
        emit OpeningResult(id, bidder, version, part, outcome, resultDigest, msg.sender);
    }

    function recordAdmission(uint256 id, address bidder, bool admit, bytes32 reasonDigest)
        external running
    {
        Tender storage t = _tender(id);
        _commission(t);
        if (t.state != State.InitialOpening) revert WrongState();
        Bid storage b = bids[id][bidder];
        Outcome outcome = outcomes[id][bidder][Part.Initial];
        if (!b.active || b.admissionRecorded || outcome == Outcome.Pending
            || (admit && outcome != Outcome.Verified)) revert InvalidBid();
        if (reasonDigest == bytes32(0)) revert InvalidInput();
        b.admissionRecorded = true;
        b.admitted = admit;
        ++t.admissionDecisions;
        if (admit) {
            ++t.admittedBids;
            if (!t.requiresTechnicalOffer) ++t.financialEligibleBids;
        }
        emit AdmissionRecorded(id, bidder, admit, reasonDigest);
    }

    function recordTechnicalDecision(uint256 id, address bidder, bool accept, bytes32 reasonDigest)
        external running
    {
        Tender storage t = _tender(id);
        _commission(t);
        if (t.state != State.TechnicalReview) revert WrongState();
        Bid storage b = bids[id][bidder];
        Outcome outcome = outcomes[id][bidder][Part.Technical];
        if (!b.admitted || b.technicalDecisionRecorded || outcome == Outcome.Pending
            || (accept && outcome != Outcome.Verified)) revert InvalidBid();
        if (reasonDigest == bytes32(0)) revert InvalidInput();
        b.technicalDecisionRecorded = true;
        b.technicalAccepted = accept;
        ++t.technicalDecisions;
        if (accept) ++t.financialEligibleBids;
        emit TechnicalDecisionRecorded(id, bidder, accept, reasonDigest);
    }

    function selectBidder(uint256 id, address bidder, bytes32 decisionDigest) external running {
        Tender storage t = _tender(id);
        _commission(t);
        if (t.state != State.FinancialOpening || t.pendingOpenings != 0) revert IncompleteReview();
        if (outcomes[id][bidder][Part.Financial] != Outcome.Verified) revert InvalidBid();
        if (decisionDigest == bytes32(0)) revert InvalidInput();
        t.selectedBidder = bidder;
        t.selectionDigest = decisionDigest;
        t.commissionCompletedAt = uint64(block.timestamp);
        _changeState(id, t, State.Selected, decisionDigest);
        emit SelectionRecorded(id, bidder, decisionDigest);
    }

    /// @notice Records the approved extract hash, not proof of actual publication.
    ///         Publishing, notification and legal time limits are off-chain duties.
    function recordPublicExtract(uint256 id, bytes32 extractDigest) external running {
        Tender storage t = _tender(id);
        _commission(t);
        if (t.state != State.Selected && t.state != State.Approved && t.state != State.Rejected)
            revert WrongState();
        if (extractDigest == bytes32(0)) revert InvalidInput();
        t.publicExtractDigest = extractDigest;
        emit PublicExtractRecorded(id, extractDigest, uint64(block.timestamp));
    }

    function decideFinalApproval(uint256 id, bool approve, bytes32 reasonDigest) external running {
        _requireRole(registry.APPROVAL_ROLE());
        Tender storage t = _tender(id);
        if (msg.sender == t.commission) revert Unauthorized();
        if (t.state != State.Selected) revert WrongState();
        if (reasonDigest == bytes32(0)) revert InvalidInput();
        _changeState(id, t, approve ? State.Approved : State.Rejected, reasonDigest);
    }

    /// @notice Government can cancel a nonterminal tender, including while paused.
    function cancelTender(uint256 id, bytes32 reasonDigest) external {
        _requireRole(registry.DEFAULT_ADMIN_ROLE());
        Tender storage t = _tender(id);
        if (_terminal(t.state)) revert WrongState();
        if (reasonDigest == bytes32(0)) revert InvalidInput();
        _changeState(id, t, State.Cancelled, reasonDigest);
    }

    function declareUnsuccessful(uint256 id, bytes32 reasonDigest) external running {
        Tender storage t = _tender(id);
        _commission(t);
        if (t.state != State.Closed && t.state != State.InitialOpening
            && t.state != State.TechnicalReview && t.state != State.FinancialOpening) revert WrongState();
        if (reasonDigest == bytes32(0)) revert InvalidInput();
        t.commissionCompletedAt = uint64(block.timestamp);
        _changeState(id, t, State.Unsuccessful, reasonDigest);
    }

    function _terminal(State state) private pure returns (bool) {
        return state == State.Approved || state == State.Rejected
            || state == State.Cancelled || state == State.Unsuccessful;
    }

    function _changeState(uint256 id, Tender storage t, State state, bytes32 reason) private {
        t.state = state;
        emit StateChanged(id, state, msg.sender, reason);
    }

    function getTender(uint256 id) external view returns (Tender memory) { return _tender(id); }
    function getBid(uint256 id, address bidder) external view returns (Bid memory) {
        _tender(id); return bids[id][bidder];
    }
    function getEvidence(uint256 id, address bidder, uint64 version, Part part)
        external view returns (Evidence memory)
    { _tender(id); return evidence[id][bidder][version][part]; }
    function getOpening(uint256 id, Part part) external view returns (Opening memory) {
        _tender(id); return openings[id][part];
    }
    function getOutcome(uint256 id, address bidder, Part part) external view returns (Outcome) {
        _tender(id); return outcomes[id][bidder][part];
    }
}

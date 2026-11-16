// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @title Government administration of constructBlock identities and permissions
/// @notice Roles attest prototype approval of wallet addresses, not legal identity.
/// @dev Government administration uses OpenZeppelin's delayed two-step transfer.
///      Tender-specific commission/officer assignments live in ProcurementWorkflow.
contract RoleRegistry is AccessControlDefaultAdminRules {
    bytes32 public constant OFFICER_ROLE = keccak256("OFFICER_ROLE");
    bytes32 public constant COMMISSION_ROLE = keccak256("COMMISSION_ROLE");
    bytes32 public constant OPENING_SERVICE_ROLE = keccak256("OPENING_SERVICE_ROLE");
    bytes32 public constant APPROVAL_ROLE = keccak256("APPROVAL_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant BIDDER_ROLE = keccak256("BIDDER_ROLE");

    error ZeroAddress();
    error UnsupportedRole(bytes32 role);
    error GovernmentAdministrationRequired();

    constructor(address governmentAdmin, uint48 transferDelay)
        AccessControlDefaultAdminRules(transferDelay, governmentAdmin) {}

    function isOperationalRole(bytes32 role) public pure returns (bool) {
        return role == OFFICER_ROLE || role == COMMISSION_ROLE
            || role == OPENING_SERVICE_ROLE || role == APPROVAL_ROLE
            || role == AUDITOR_ROLE || role == BIDDER_ROLE;
    }

    /// @notice Only the government default administrator may grant operational roles.
    function grantRole(bytes32 role, address account) public override {
        if (account == address(0)) revert ZeroAddress();
        if (!isOperationalRole(role)) revert UnsupportedRole(role);
        super.grantRole(role, account);
    }

    function approveBidder(address bidder) external {
        grantRole(BIDDER_ROLE, bidder);
    }

    function revokeBidder(address bidder) external {
        revokeRole(BIDDER_ROLE, bidder);
    }

    /// @notice Transfer government administration to another address, never to zero.
    function beginDefaultAdminTransfer(address newAdmin) public override {
        if (newAdmin == address(0)) revert ZeroAddress();
        super.beginDefaultAdminTransfer(newAdmin);
    }

    /// @dev Operational users can renounce their roles; government must transfer
    ///      its administrator role instead of leaving the platform ungoverned.
    function renounceRole(bytes32 role, address confirmation) public override {
        if (role == DEFAULT_ADMIN_ROLE) revert GovernmentAdministrationRequired();
        super.renounceRole(role, confirmation);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";

/// @title DemoIssuerToken
/// @notice Testnet demo only: an issuer's ERC-20 as Tempo's ERC-20 migration
///         guide starts from (OpenZeppelin `ERC20`, `AccessControl`,
///         `Pausable`, `Burnable`; 18 decimals). Holders migrate it to its
///         TIP-20 on Tempo by locking it in nori-tempo-sdk's `NoriTokenBridge`,
///         and its `paused()` follows it there by proof.
contract DemoIssuerToken is ERC20, ERC20Burnable, ERC20Pausable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @param name_ The token's name.
    /// @param symbol_ The token's symbol.
    /// @param issuer Gets `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE` and `PAUSER_ROLE`.
    constructor(string memory name_, string memory symbol_, address issuer) ERC20(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, issuer);
        _grantRole(MINTER_ROLE, issuer);
        _grantRole(PAUSER_ROLE, issuer);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Blocks transfers, so also new locks; `NoriTokenBridge.syncPause` carries it to Tempo.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }
}

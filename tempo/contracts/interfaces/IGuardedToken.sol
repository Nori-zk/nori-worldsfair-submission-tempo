// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The bridged token a Backstop guard watches: its supply and decimals
///         (a TIP-20 on Tempo, or any ERC-20).
interface IGuardedToken {
    function totalSupply() external view returns (uint256);

    function decimals() external view returns (uint8);
}

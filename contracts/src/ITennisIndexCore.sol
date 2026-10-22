// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITennisIndexCore {
    /// TRADE_OPEN / TRADE_QUEUED / TRADE_PAUSED / TRADE_STALE (PlayerToken.sol)
    function tradeStatus(address token) external view returns (uint8);
    function targetNavOf(address token) external view returns (uint256);
    function collectFee() external payable;
}

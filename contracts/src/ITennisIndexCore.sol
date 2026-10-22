// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITennisIndexCore {
    function paused() external view returns (bool);
    function tokenLevel(address token) external view returns (uint128);
    function collectFee() external payable;
}

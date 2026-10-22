// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {TennisIndex} from "../src/TennisIndex.sol";
import {PlayerToken} from "../src/PlayerToken.sol";

contract Deploy is Script {
    function run() external returns (TennisIndex index, address impl, address admin, address oracle) {
        admin = vm.envAddress("ADMIN_ADDRESS");
        oracle = vm.envAddress("ORACLE_ADDRESS");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(pk);
        impl = address(new PlayerToken());
        index = new TennisIndex(admin, oracle, impl);
        vm.stopBroadcast();
    }
}

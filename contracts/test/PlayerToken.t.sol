// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlayerToken} from "../src/PlayerToken.sol";
import {TennisIndex} from "../src/TennisIndex.sol";

contract PlayerTokenTest is Test {
    TennisIndex internal core;
    PlayerToken internal tok;
    address internal admin = makeAddr("admin");
    address internal oracle = makeAddr("oracle");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint128 internal constant BASE = 750_000; // 7,500.00

    function setUp() public {
        core = new TennisIndex(admin, oracle, address(new PlayerToken()));
        core.topUp{value: 1000 ether}();
        vm.prank(admin);
        uint256 id = core.addPlayer("ATP-SIN", 1, BASE);
        tok = PlayerToken(payable(core.player(id).token));
        deal(alice, 1000 ether);
        deal(bob, 1000 ether);
    }

    function test_initialNavEqualsTarget() public view {
        assertEq(tok.navWad(), 1e18);
        assertEq(tok.totalSupply(), 0);
        assertEq(tok.decimals(), 18);
    }

    function test_buyMintsAtNav() public {
        uint256 out = tok.buy{value: 1 ether}(alice, 0);
        assertEq(out, 1e18); // NAV 1 CHZ at base level
        assertEq(tok.balanceOf(alice), 1e18);
        assertEq(tok.reserveWad(), 1 ether);
        assertEq(tok.navWad(), 1e18);
    }

    function test_buyRespectsSlippage() public {
        vm.expectRevert(abi.encodeWithSelector(PlayerToken.Slippage.selector, 2e18, 1e18));
        tok.buy{value: 1 ether}(alice, 2e18);
    }

    /// Buying with existing supply must price against the pre-buy NAV so the
    /// mint is exact and NAV stays pinned (no dilution).
    function test_buyWithSupplyKeepsNavPinned() public {
        tok.buy{value: 1 ether}(alice, 0); // s=1e18, r=1e18, NAV=1e18
        uint256 out = tok.buy{value: 2 ether}(bob, 0);
        assertEq(out, 2e18); // 2 CHZ at NAV 1 CHZ/token
        assertEq(tok.totalSupply(), 3e18);
        assertEq(tok.reserveWad(), 3 ether);
        assertEq(tok.navWad(), 1e18); // NAV unchanged
        // round numbers at a non-1 NAV too
        vm.prank(admin);
        core.calibrateLevel(0, 900_000); // NAV 1.2
        uint256 pre = tok.totalSupply();
        uint256 rPre = tok.reserveWad();
        uint256 out2 = tok.buy{value: 1.2 ether}(bob, 0);
        assertApproxEqRel(out2, 1e18, 1e12); // 1.2 CHZ / 1.2 = 1 token
        assertApproxEqRel(tok.navWad(), 1.2e18, 1e15); // NAV still pinned
        assertApproxEqRel(tok.reserveWad(), rPre + 1.2 ether, 1e12);
        assertEq(tok.totalSupply(), pre + out2);
    }

    function test_buyRejectsZero() public {
        vm.expectRevert(PlayerToken.ZeroAmount.selector);
        tok.buy{value: 0}(alice, 0);
    }

    function test_sellReturnsChz() public {
        tok.buy{value: 2 ether}(alice, 0);
        vm.prank(alice);
        uint256 got = tok.sell(1e18, bob, 0);
        assertEq(got, 1 ether);
        assertEq(bob.balance, 1001 ether);
        assertEq(tok.totalSupply(), 1e18);
        assertEq(tok.reserveWad(), 1 ether);
        assertEq(tok.navWad(), 1e18);
    }

    /// THE core economics test: when the index rises, holders' wealth rises
    /// proportionally, funded by the core counterparty pool.
    function test_levelUpRaisesHolderWealthProportionally() public {
        tok.buy{value: 1 ether}(alice, 0); // NAV 1e18, supply 1e18
        uint256 coreBalBefore = address(core).balance;
        vm.prank(admin);
        core.calibrateLevel(0, 900_000); // +20%
        // NAV now 1.2 CHZ; reserve topped up by core
        assertApproxEqRel(tok.navWad(), 1.2e18, 1e15);
        assertApproxEqRel(tok.reserveWad(), 1.2 ether, 1e14);
        assertEq(address(core).balance, coreBalBefore - 0.2 ether);
        // alice's wealth grew 20%
        assertApproxEqRel(tok.balanceOf(alice) * tok.navWad() / 1e18, 1.2 ether, 1e15);
    }

    function test_levelDownLowersHolderWealthProportionally() public {
        tok.buy{value: 1 ether}(alice, 0);
        vm.prank(admin);
        core.calibrateLevel(0, 600_000); // -20%
        assertApproxEqRel(tok.navWad(), 0.8e18, 1e15);
        assertApproxEqRel(tok.reserveWad(), 0.8 ether, 1e14);
        // surplus swept back to core
        assertApproxEqRel(address(core).balance, 1000 ether + 0.2 ether, 1e14);
        // alice's wealth fell 20%
        assertApproxEqRel(tok.balanceOf(alice) * tok.navWad() / 1e18, 0.8 ether, 1e15);
    }

    function test_fullIndexRoundTrip() public {
        tok.buy{value: 1 ether}(alice, 0);
        vm.prank(admin);
        core.calibrateLevel(0, 900_000);
        vm.prank(admin);
        core.calibrateLevel(0, 750_000);
        // wealth unchanged after round trip
        assertApproxEqRel(tok.balanceOf(alice) * tok.navWad() / 1e18, 1 ether, 1e15);
        assertApproxEqRel(tok.navWad(), 1e18, 1e15);
    }

    function test_underfundedCoreDegradesGracefully() public {
        core = new TennisIndex(admin, oracle, address(new PlayerToken()));
        core.topUp{value: 0.05 ether}();
        vm.prank(admin);
        uint256 id = core.addPlayer("ATP-U", 1, BASE);
        tok = PlayerToken(payable(core.player(id).token));
        tok.buy{value: 1 ether}(alice, 0);
        vm.prank(admin);
        core.calibrateLevel(id, 900_000); // needs 0.2, only 0.05 funded
        // NAV floats below target but reserve still fully covers sells
        assertLe(tok.navWad(), 1.2e18);
        uint256 s = tok.totalSupply();
        assertLe(s * tok.navWad() / 1e18, tok.reserveWad());
        uint256 bal = tok.balanceOf(alice);
        vm.prank(alice);
        tok.sell(bal, alice, 0); // full exit always possible
    }

    function test_sweepOnFallGoesToCore() public {
        tok.buy{value: 1 ether}(alice, 0);
        vm.prank(admin);
        core.calibrateLevel(0, 600_000);
        assertEq(tok.reserveWad(), 0.8 ether);
    }

    function test_feesRouteToCore() public {
        vm.prank(admin);
        core.setPlayerFees(0, 100, 100); // 1%
        uint256 out = tok.buy{value: 1.01 ether}(alice, 0);
        assertEq(out, 0.9999e18); // 1% buy fee: net 0.9999 CHZ at NAV 1 CHZ
        assertEq(address(core).balance, 1000 ether + 0.0101 ether); // fees accrue to core
        assertEq(tok.reserveWad(), 0.9999 ether);
        vm.prank(alice);
        uint256 net = tok.sell(0.9999e18, alice, 0);
        assertEq(net, 0.989901 ether); // 1% sell fee on gross 0.9999
        assertEq(tok.reserveWad(), 0); // both fees were transferred out to the core
        assertEq(address(core).balance, 1000 ether + 0.0101 ether + 0.009999 ether);
        assertEq(tok.totalSupply(), 0);
        assertEq(tok.navWad(), 1e18); // s==0 NAV comes from core level
    }

    function test_repeatedTradesKeepReserveCovered() public {
        tok.buy{value: 10 ether}(alice, 0);
        vm.prank(alice);
        tok.sell(0.5e18, alice, 0);
        tok.buy{value: 3 ether}(bob, 0);
        vm.prank(bob);
        tok.sell(1e18, bob, 0);
        tok.buy{value: 0.001 ether}(bob, 0);
        uint256 s = tok.totalSupply();
        assertLe(s * tok.navWad() / 1e18, tok.reserveWad());
    }

    function test_onlyCoreCanApplyLevel() public {
        vm.expectRevert(PlayerToken.OnlyCore.selector);
        tok.applyIndexLevel(BASE, 800_000);
    }

    function test_applyLevelFromCoreWithSupply() public {
        tok.buy{value: 1 ether}(alice, 0);
        vm.prank(address(core));
        tok.applyIndexLevel(BASE, 900_000); // core passes levels explicitly
        // without attached funding nothing moves; core._settle does the funding
        assertEq(tok.navWad(), 1e18);
        assertEq(tok.reserveWad(), 1 ether);
    }

    function test_applyLevelWithSupplyZeroRejectsValue() public {
        vm.prank(address(core));
        vm.expectRevert(PlayerToken.ZeroAmount.selector);
        tok.applyIndexLevel{value: 1 ether}(BASE, 900_000);
    }

    function test_onlyCoreCanSetFees() public {
        vm.expectRevert(PlayerToken.OnlyCore.selector);
        tok.setFees(1, 1);
    }

    function test_noCorePauseBlocksTrading() public {
        tok.buy{value: 1 ether}(alice, 0);
        vm.prank(admin);
        core.pause();
        vm.expectRevert(PlayerToken.CorePaused.selector);
        tok.buy{value: 1 ether}(bob, 0);
        vm.expectRevert(PlayerToken.CorePaused.selector);
        vm.prank(alice);
        tok.sell(1e18, alice, 0);
        vm.prank(admin);
        core.unpause();
        tok.buy{value: 1 ether}(bob, 0);
    }

    function test_transferAndAllowance() public {
        tok.buy{value: 2 ether}(alice, 0);
        vm.prank(alice);
        tok.transfer(bob, 0.5e18);
        assertEq(tok.balanceOf(bob), 0.5e18);
        vm.prank(alice);
        tok.approve(bob, 1e18);
        assertEq(tok.allowance(alice, bob), 1e18);
        vm.prank(bob);
        tok.transferFrom(alice, bob, 0.25e18);
        assertEq(tok.allowance(alice, bob), 0.75e18);
    }

    function test_fullSupplySellAlwaysSolventAcrossLevels() public {
        tok.buy{value: 5 ether}(alice, 0);
        uint128[6] memory levels = [uint128(900_000), 700_000, 830_000, 600_000, 750_000, 1_100_000];
        for (uint256 i; i < levels.length; ++i) {
            vm.prank(admin);
            core.calibrateLevel(0, levels[i]);
            uint256 s = tok.totalSupply();
            uint256 nav = tok.navWad();
            // solvency: paying out the whole supply at NAV must not exceed reserve
            assertLe(s * nav / 1e18, tok.reserveWad());
        }
    }
}

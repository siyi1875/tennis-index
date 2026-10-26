// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlayerToken} from "../src/PlayerToken.sol";
import {TennisIndex} from "../src/TennisIndex.sol";

contract TennisIndexTest is Test {
    TennisIndex internal core;
    address internal admin = makeAddr("admin");
    address internal oracle = makeAddr("oracle");
    address internal user = makeAddr("user");

    uint128 internal constant BASE = 750_000;

    function setUp() public {
        core = new TennisIndex(admin, oracle, address(new PlayerToken()));
        vm.prank(oracle);
        core.heartbeat(); // trading needs a live oracle
        deal(user, 100 ether);
    }

    function _add(uint128 level) internal returns (uint256 id) {
        vm.prank(admin);
        id = core.addPlayer("M-TST", 1, level);
    }

    function test_addPlayerDeploysToken() public {
        uint256 id = _add(BASE);
        TennisIndex.Player memory p = core.player(id);
        assertEq(p.level, BASE);
        assertEq(p.tour, 1);
        assertEq(core.playerCount(), 1);
        PlayerToken tok = PlayerToken(payable(p.token));
        assertEq(tok.core(), address(core));
        assertEq(core.tokenLevel(p.token), BASE);
        assertEq(tok.navWad(), 100e18); // 100 CHZ at base; s==0 NAV reads level from core
        assertEq(tok.symbol(), "M-TST");
        assertEq(tok.name(), "Tennis Form M-TST");
    }

    function test_addPlayerOnlyAdmin() public {
        vm.expectRevert();
        core.addPlayer("X", 1, BASE);
    }

    function test_updateLevelOracleOnly() public {
        uint256 id = _add(BASE);
        vm.expectRevert();
        core.updateLevel(id, 760_000);
    }

    function test_updateLevelFlow() public {
        uint256 id = _add(BASE);
        vm.prank(oracle);
        core.updateLevel(id, 760_000);
        assertEq(core.levelOf(id), 760_000);
    }

    function test_updateLevelEnforcesDeltaCap() public {
        uint256 id = _add(BASE);
        vm.prank(oracle);
        core.updateLevel(id, 800_000); // +6.7% ok
        vm.warp(block.timestamp + 31 minutes);
        vm.expectRevert(TennisIndex.DeltaTooBig.selector);
        vm.prank(oracle);
        core.updateLevel(id, 1_100_000); // +37% > 25%
    }

    function test_updateLevelEnforcesMinInterval() public {
        uint256 id = _add(BASE);
        vm.prank(oracle);
        core.updateLevel(id, 760_000);
        vm.expectRevert(TennisIndex.TooSoon.selector);
        vm.prank(oracle);
        core.updateLevel(id, 770_000);
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(oracle);
        core.updateLevel(id, 770_000);
    }

    function test_updateLevelEnforcesMinLevel() public {
        uint256 id = _add(BASE);
        vm.expectRevert(TennisIndex.LevelTooLow.selector);
        vm.prank(oracle);
        core.updateLevel(id, 9_999);
    }

    function test_calibrateLevelBypassesCap() public {
        uint256 id = _add(BASE);
        vm.prank(admin);
        core.calibrateLevel(id, 1_200_000); // +60% allowed for calibration
        assertEq(core.levelOf(id), 1_200_000);
    }

    function test_seasonReset() public {
        uint256 id = _add(BASE);
        vm.prank(admin);
        core.calibrateLevel(id, 1_000_000);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(oracle);
        core.seasonReset(ids);
        assertEq(core.levelOf(id), BASE);
        assertEq(core.tokenLevel(core.player(id).token), BASE);
    }

    function test_pauseBlocksUpdates() public {
        uint256 id = _add(BASE);
        vm.prank(admin);
        core.pause();
        vm.expectRevert();
        vm.prank(oracle);
        core.updateLevel(id, 760_000);
        vm.prank(admin);
        core.unpause();
        vm.prank(oracle);
        core.updateLevel(id, 760_000);
    }

    function test_playersRangeView() public {
        _add(BASE);
        _add(BASE);
        TennisIndex.Player[] memory ps = core.playersRange(0, 2);
        assertEq(ps.length, 2);
        assertEq(ps[1].level, BASE);
    }

    function test_priceScalesLinearlyFrom100ChzAtBase() public {
        uint256 id = _add(BASE);
        address t = core.player(id).token;
        assertEq(core.targetNavOf(t), 100 ether);
        vm.startPrank(admin);
        core.calibrateLevel(id, 779_556);
        assertEq(core.targetNavOf(t), 103.940800 ether); // 7,795.56 -> 103.9408 CHZ
        core.calibrateLevel(id, 600_000);
        assertEq(core.targetNavOf(t), 80 ether);
        vm.stopPrank();
    }

    /// New tokens charge the default 1%/1% from the very first trade: there is
    /// no fee-free window waiting for an off-chain job to switch fees on.
    function test_newTokenChargesDefaultFeesFromFirstTrade() public {
        PlayerToken tok = PlayerToken(payable(core.player(_add(BASE)).token));
        assertEq(tok.buyFeeBps(), 100);
        assertEq(tok.sellFeeBps(), 100);
        vm.prank(user);
        uint256 out = tok.buy{value: 10 ether}(user, 0);
        assertEq(address(core).balance, 0.1 ether); // 1% of the first buy
        assertEq(out, 0.099e18); // 9.9 CHZ net at 100 CHZ/token
        vm.prank(user);
        uint256 net = tok.sell(out, user, 0);
        assertEq(net, 9.801 ether); // 1% of 9.9 gross
        assertEq(address(core).balance, 0.199 ether);
    }

    function test_setDefaultFeesAppliesToNewTokensOnly() public {
        PlayerToken first = PlayerToken(payable(core.player(_add(BASE)).token));
        vm.prank(admin);
        core.setDefaultFees(50, 200);
        PlayerToken second = PlayerToken(payable(core.player(_add(BASE)).token));
        assertEq(first.buyFeeBps(), 100);
        assertEq(first.sellFeeBps(), 100);
        assertEq(second.buyFeeBps(), 50);
        assertEq(second.sellFeeBps(), 200);
        // batched registration uses the defaults too
        string[] memory syms = new string[](1);
        syms[0] = "W-B";
        uint8[] memory tours = new uint8[](1);
        tours[0] = 2;
        uint128[] memory lv = new uint128[](1);
        lv[0] = BASE;
        vm.prank(admin);
        uint256 id = core.addPlayers(syms, tours, lv);
        assertEq(PlayerToken(payable(core.player(id).token)).sellFeeBps(), 200);
    }

    function test_setDefaultFeesAdminOnlyAndCapped() public {
        vm.expectRevert();
        core.setDefaultFees(100, 100);
        vm.prank(admin);
        vm.expectRevert();
        core.setDefaultFees(501, 100);
        vm.prank(admin);
        vm.expectRevert();
        core.setDefaultFees(100, 501);
    }

    function test_tokenCannotBeReinitialized() public {
        PlayerToken tok = PlayerToken(payable(core.player(_add(BASE)).token));
        vm.expectRevert();
        tok.initialize("X", address(this), 0, 0);
    }

    // ------------------------------ treasury ------------------------------

    function _tradeRoundTrip() internal returns (PlayerToken tok) {
        tok = PlayerToken(payable(core.player(_add(BASE)).token));
        vm.prank(user);
        uint256 out = tok.buy{value: 10 ether}(user, 0); // fee 0.1
        vm.prank(user);
        tok.sell(out, user, 0); // fee 0.099
    }

    function test_feesSplitFiftyFiftyBetweenTreasuryAndPool() public {
        _tradeRoundTrip();
        assertEq(core.treasuryBalance(), 0.0995 ether); // 50% of 0.199
        assertEq(core.poolBalance(), 0.0995 ether);
        assertEq(address(core).balance, 0.199 ether);
    }

    function test_topUpAndSweepsGoToPoolOnly() public {
        core.topUp{value: 5 ether}();
        assertEq(core.treasuryBalance(), 0);
        PlayerToken tok = PlayerToken(payable(core.player(_add(BASE)).token));
        vm.prank(user);
        tok.buy{value: 10 ether}(user, 0); // 0.1 fee -> 0.05 treasury
        vm.prank(admin);
        core.calibrateLevel(0, 600_000); // level falls: reserve surplus swept back
        assertEq(core.treasuryBalance(), 0.05 ether);
        assertGt(core.poolBalance(), 5.05 ether);
    }

    /// Treasury revenue is never spent on level rises, even when the pool is dry.
    function test_treasuryNeverFundsLevelRises() public {
        PlayerToken tok = PlayerToken(payable(core.player(_add(BASE)).token));
        vm.prank(user);
        tok.buy{value: 10 ether}(user, 0); // pool 0.05, treasury 0.05
        vm.prank(admin);
        core.calibrateLevel(0, 900_000); // needs ~1.98, pool has 0.05
        assertEq(core.poolBalance(), 0);
        assertEq(core.treasuryBalance(), 0.05 ether);
        assertEq(address(core).balance, 0.05 ether);
    }

    function test_withdrawTreasuryPaysTreasuryAddress() public {
        _tradeRoundTrip();
        address payout = makeAddr("payout");
        vm.prank(admin);
        core.setTreasury(payout, 5_000);
        vm.prank(admin);
        core.withdrawTreasury(0.0995 ether);
        assertEq(payout.balance, 0.0995 ether);
        assertEq(core.treasuryBalance(), 0);
        assertEq(core.poolBalance(), 0.0995 ether); // pool untouched
    }

    function test_withdrawTreasuryWorksWhilePaused() public {
        _tradeRoundTrip();
        vm.prank(admin);
        core.pause();
        vm.prank(admin);
        core.withdrawTreasury(0.0995 ether);
        assertEq(admin.balance, 0.0995 ether); // treasury defaults to admin
    }

    function test_withdrawTreasuryCannotTouchPool() public {
        _tradeRoundTrip();
        core.topUp{value: 5 ether}();
        vm.prank(admin);
        vm.expectRevert();
        core.withdrawTreasury(0.0995 ether + 1);
    }

    function test_treasuryAdminOnlyAndShareCapped() public {
        _tradeRoundTrip();
        vm.expectRevert();
        core.withdrawTreasury(1);
        vm.expectRevert();
        core.setTreasury(user, 5_000);
        vm.prank(admin);
        vm.expectRevert();
        core.setTreasury(user, 8_001); // pool keeps at least 20%
        vm.prank(admin);
        vm.expectRevert();
        core.setTreasury(address(0), 5_000);
    }
}

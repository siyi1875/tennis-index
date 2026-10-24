// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlayerToken} from "../src/PlayerToken.sol";
import {TennisIndex} from "../src/TennisIndex.sol";

/// Live-match halts, the order queue, the oracle heartbeat and the season
/// carry-over reset. The attack tests replay the leaks these mechanisms close:
/// each one is first shown to pay without the fix, then shown to pay nothing.
contract LiveMatchTest is Test {
    TennisIndex internal core;
    PlayerToken internal tok;
    uint256 internal id;
    address internal admin = makeAddr("admin");
    address internal oracle = makeAddr("oracle");
    address internal holder = makeAddr("holder");
    address internal attacker = makeAddr("attacker");
    address internal bob = makeAddr("bob");

    uint128 internal constant BASE = 750_000;
    uint128 internal constant WIN = 787_500; // +5%: an upset win

    function setUp() public {
        core = new TennisIndex(admin, oracle, address(new PlayerToken()));
        core.topUp{value: 100_000 ether}();
        vm.prank(oracle);
        core.heartbeat();
        vm.prank(admin);
        id = core.addPlayer("M-SIN", 1, BASE); // default 1%/1% fees
        tok = PlayerToken(payable(core.player(id).token));
        deal(holder, 10_000 ether);
        deal(attacker, 10_000 ether);
        deal(bob, 10_000 ether);
        vm.prank(holder);
        tok.buy{value: 1_000 ether}(holder, 0); // existing book
    }

    function _ids() internal view returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _halt() internal {
        uint64[] memory froms = new uint64[](1);
        froms[0] = uint64(block.timestamp);
        vm.prank(oracle);
        core.scheduleHalts(_ids(), froms);
    }

    function _push(uint128 level) internal {
        vm.prank(oracle);
        core.updateLevel(id, level);
    }

    function _wealth(address who) internal view returns (uint256) {
        return who.balance + (tok.balanceOf(who) * tok.navWad()) / 1e18;
    }

    // ------------------------------ attacks ------------------------------

    /// Without a halt, buying after the result but before the push is free money.
    function test_attack_latencyArbitragePaysWithoutHalt() public {
        uint256 before = _wealth(attacker);
        vm.prank(attacker);
        uint256 got = tok.buy{value: 1_000 ether}(attacker, 0); // result known, price stale
        vm.warp(block.timestamp + 31 minutes);
        _push(WIN);
        vm.prank(attacker);
        tok.sell(got, attacker, 0);
        assertGt(attacker.balance, before + 25 ether); // ~+5% minus ~2% fees
    }

    /// With the halt, the same order queues and fills at the post-match price.
    function test_attack_latencyArbitrageFailsWithHalt() public {
        uint256 before = attacker.balance;
        _halt(); // scheduled start
        vm.prank(attacker);
        assertEq(tok.buy{value: 1_000 ether}(attacker, 0), 0); // queued, not filled
        _push(WIN); // post-match push fills the queue at the new price
        (uint256 got,) = tok.claim(0, attacker);
        vm.prank(attacker);
        tok.sell(got, attacker, 0);
        assertLt(attacker.balance, before); // only the fees were lost
        assertApproxEqRel(before - attacker.balance, 19.9 ether, 1e15); // 1% in + 1% out
    }

    /// A holder of the losing player cannot dump at the pre-match price.
    function test_attack_loserCannotExitAtStalePrice() public {
        _halt();
        uint256 bal = tok.balanceOf(holder);
        vm.prank(holder);
        assertEq(tok.sell(bal, holder, 0), 0); // escrowed, still exposed
        assertEq(tok.balanceOf(address(tok)), bal);
        uint128 loss = 712_500; // -5%
        _push(loss);
        uint256 pre = holder.balance;
        (, uint256 chz) = tok.claim(0, holder);
        assertEq(holder.balance, pre + chz);
        // paid at the post-match NAV (95 CHZ), not the pre-match 100
        assertApproxEqRel(chz, (bal * 95 ether / 1e18) * 99 / 100, 1e12);
    }

    // ------------------------------- queue -------------------------------

    function test_queuedBuyCHZDoesNotInflateNav() public {
        uint256 nav = tok.navWad();
        uint256 reserve = tok.reserveWad();
        _halt();
        vm.prank(attacker);
        tok.buy{value: 500 ether}(attacker, 0);
        assertEq(tok.navWad(), nav);
        assertEq(tok.reserveWad(), reserve);
        assertEq(tok.pendingChz(), 495 ether); // net of the 1% fee, which went to the core
    }

    function test_settlementFillsEveryoneAtOnePriceWithoutDilution() public {
        _halt();
        vm.prank(attacker);
        tok.buy{value: 500 ether}(attacker, 0);
        vm.prank(bob);
        tok.buy{value: 1_000 ether}(bob, 0);
        uint256 half = tok.balanceOf(holder) / 2;
        vm.prank(holder);
        tok.sell(half, holder, 0);
        _push(WIN);
        (, , , , uint256 nav, uint256 buyNav, bool settled,) = tok.batches(0);
        assertTrue(settled);
        assertApproxEqRel(nav, 105 ether, 1e12); // post-match price
        assertApproxEqRel(buyNav, nav, 1e12); // fully funded: buys and sells at one price
        assertApproxEqRel(tok.navWad(), nav, 1e12); // no dilution for remaining holders
        (uint256 aTok,) = tok.claim(0, attacker);
        (uint256 bTok,) = tok.claim(0, bob);
        assertApproxEqRel(aTok * 2, bTok, 1e12); // pro rata, same price
        assertApproxEqRel(aTok, 495 ether * 1e18 / nav, 1e12);
        assertEq(tok.epoch(), 1); // next halt uses a fresh batch
    }

    function test_queueRequiresPostMatchPushToSettle() public {
        _halt();
        vm.prank(attacker);
        tok.buy{value: 100 ether}(attacker, 0);
        vm.expectRevert(abi.encodeWithSelector(PlayerToken.NotSettled.selector, uint32(0)));
        tok.claim(0, attacker);
        // a second order while halted joins the same batch
        vm.prank(attacker);
        tok.buy{value: 100 ether}(attacker, 0);
        _push(WIN);
        (uint256 got,) = tok.claim(0, attacker);
        assertGt(got, 0);
        vm.expectRevert(PlayerToken.NothingToClaim.selector);
        tok.claim(0, attacker); // no double claim
    }

    function test_anyoneCanClaimButFillsGoToOwner() public {
        _halt();
        vm.prank(attacker);
        tok.buy{value: 100 ether}(attacker, 0);
        _push(WIN);
        vm.prank(bob);
        (uint256 got,) = tok.claim(0, attacker);
        assertEq(tok.balanceOf(attacker), got);
        assertEq(tok.balanceOf(bob), 0);
    }

    function test_claimEmitsBoughtForPortfolioPnl() public {
        _halt();
        vm.prank(attacker);
        tok.buy{value: 100 ether}(attacker, 0);
        _push(WIN);
        vm.expectEmit(true, true, false, false, address(tok));
        emit PlayerToken.Bought(attacker, attacker, 100 ether, 0, 0);
        tok.claim(0, attacker);
    }

    function test_queuedFeesBuyAtQueueSellAtSettlement() public {
        uint256 coreBefore = address(core).balance;
        _halt();
        vm.prank(attacker);
        tok.buy{value: 100 ether}(attacker, 0);
        assertEq(address(core).balance, coreBefore + 1 ether);
        uint256 bal = tok.balanceOf(holder);
        vm.prank(holder);
        tok.sell(bal, holder, 0);
        assertEq(address(core).balance, coreBefore + 1 ether); // not yet
        vm.prank(oracle);
        core.resume(_ids()); // no level change
        assertApproxEqRel(address(core).balance, coreBefore + 1 ether + 10 ether, 1e12); // 1% of 1,000
    }

    function test_resumeWithoutLevelChangeSettlesAtCurrentPrice() public {
        uint256 nav = tok.navWad();
        _halt();
        vm.prank(attacker);
        tok.buy{value: 100 ether}(attacker, 0);
        vm.prank(oracle);
        core.resume(_ids()); // walkover
        assertFalse(core.halted(address(tok)));
        (uint256 got,) = tok.claim(0, attacker);
        assertEq(got, 99 ether * 1e18 / nav);
    }

    function test_postMatchPushSkipsUpdateIntervalAndResumes() public {
        _push(760_000); // a normal update just now
        _halt();
        _push(WIN); // within 30 minutes: allowed because the player was halted
        assertEq(core.levelOf(id), WIN);
        assertFalse(core.halted(address(tok)));
        vm.expectRevert(TennisIndex.TooSoon.selector);
        _push(780_000); // not halted any more: interval applies again
    }

    function test_tradingIsInstantAgainAfterResume() public {
        _halt();
        _push(WIN);
        vm.prank(attacker);
        assertGt(tok.buy{value: 100 ether}(attacker, 0), 0);
    }

    function test_haltIsPerPlayer() public {
        vm.prank(admin);
        uint256 other = core.addPlayer("W-OTH", 2, BASE);
        PlayerToken tok2 = PlayerToken(payable(core.player(other).token));
        _halt();
        vm.prank(bob);
        assertGt(tok2.buy{value: 100 ether}(bob, 0), 0); // other player still instant
    }

    function test_onlyOracleHaltsAndResumes() public {
        uint256[] memory ids = _ids();
        vm.expectRevert();
        core.scheduleHalts(ids, new uint64[](1));
        vm.expectRevert();
        core.resume(ids);
        vm.expectRevert();
        core.heartbeat();
    }

    // ----------------------------- heartbeat -----------------------------

    function test_staleOracleStopsAllTrading() public {
        vm.warp(block.timestamp + 61 minutes);
        vm.prank(attacker);
        vm.expectRevert(PlayerToken.OracleStale.selector);
        tok.buy{value: 100 ether}(attacker, 0);
        uint256 bal = tok.balanceOf(holder);
        vm.prank(holder);
        vm.expectRevert(PlayerToken.OracleStale.selector);
        tok.sell(bal, holder, 0);
        vm.prank(oracle);
        core.heartbeat();
        vm.prank(attacker);
        assertGt(tok.buy{value: 100 ether}(attacker, 0), 0);
    }

    function test_anyOracleTxIsAHeartbeat() public {
        vm.warp(block.timestamp + 1 hours);
        _halt();
        assertEq(core.lastHeartbeat(), block.timestamp);
        vm.warp(block.timestamp + 1 hours);
        _push(WIN);
        assertEq(core.lastHeartbeat(), block.timestamp);
    }

    function test_heartbeatMaxAgeAdminOnlyAndBounded() public {
        vm.expectRevert();
        core.setHeartbeatMaxAge(1 hours);
        vm.startPrank(admin);
        vm.expectRevert();
        core.setHeartbeatMaxAge(4 minutes);
        core.setHeartbeatMaxAge(1 hours);
        vm.stopPrank();
        assertEq(core.heartbeatMaxAge(), 1 hours);
    }

    // --------------------------- season reset ---------------------------

    function _reset() internal {
        vm.prank(oracle);
        core.seasonReset(_ids());
    }

    /// Old reset: a below-base token was funded up to base on Jan 1, a
    /// guaranteed gain for anyone buying it in December. Now nothing moves.
    function test_attack_resetUpliftIsGone() public {
        vm.prank(admin);
        core.calibrateLevel(id, 730_898); // 7,308.98: lowest level in the live book
        vm.prank(attacker);
        uint256 got = tok.buy{value: 1_000 ether}(attacker, 0);
        uint256 coreBefore = address(core).balance;
        uint256 reserveBefore = tok.reserveWad();
        uint256 navBefore = tok.navWad();
        _reset();
        assertEq(core.levelOf(id), BASE);
        assertEq(address(core).balance, coreBefore); // no funding
        assertEq(tok.reserveWad(), reserveBefore); // no sweep
        assertEq(tok.navWad(), navBefore); // price carries over
        uint256 pre = attacker.balance;
        vm.prank(attacker);
        tok.sell(got, attacker, 0);
        assertLt(attacker.balance - pre, 1_000 ether); // round trip loses the fees
    }

    function test_resetCarriesPriceAndNewSeasonMovesScaleFromIt() public {
        vm.prank(admin);
        core.calibrateLevel(id, 900_000); // 120 CHZ
        uint256 nav = tok.navWad();
        assertApproxEqRel(nav, 120 ether, 1e12);
        _reset();
        assertApproxEqRel(core.targetNavOf(address(tok)), 120 ether, 1e12);
        assertApproxEqRel(tok.navWad(), 120 ether, 1e12);
        vm.warp(block.timestamp + 31 minutes);
        _push(825_000); // +10% in the new season
        assertApproxEqRel(tok.navWad(), 132 ether, 1e12); // +10% from the carried price
    }

    function test_resetCarriesPriceForUnheldTokensToo() public {
        vm.prank(admin);
        uint256 other = core.addPlayer("W-OTH", 2, 600_000); // 80 CHZ, no supply
        address t = core.player(other).token;
        uint256[] memory ids = new uint256[](1);
        ids[0] = other;
        vm.prank(oracle);
        core.seasonReset(ids);
        assertEq(core.levelOf(other), BASE);
        assertApproxEqRel(core.targetNavOf(t), 80 ether, 1e12);
        assertApproxEqRel(PlayerToken(payable(t)).navWad(), 80 ether, 1e12);
    }

    function test_repeatedResetsCompound() public {
        vm.prank(admin);
        core.calibrateLevel(id, 900_000); // x1.2
        _reset();
        vm.prank(admin);
        core.calibrateLevel(id, 675_000); // x0.9
        _reset();
        assertApproxEqRel(core.navScaleOf(address(tok)), 1.08e18, 1e12);
        assertApproxEqRel(tok.navWad(), 108 ether, 1e12);
    }

    /// A queued dust buy that would mint 0 tokens is refunded, not absorbed.
    function test_queuedDustBuyIsRefunded() public {
        vm.prank(admin);
        core.calibrateLevel(id, 45_000_000); // 6,000 CHZ per token
        _halt();
        vm.prank(attacker);
        tok.buy{value: 1000 wei}(attacker, 0); // 990 wei net: < 1 wei of token
        uint256 pre = attacker.balance;
        vm.prank(oracle);
        core.resume(_ids());
        (uint256 got, uint256 chz) = tok.claim(0, attacker);
        assertEq(got, 0);
        assertEq(chz, 990);
        assertEq(attacker.balance, pre + 990);
        assertEq(tok.pendingChz(), 0);
    }

    function test_haltWithNoOrdersKeepsTheBatchOpen() public {
        _halt();
        _push(WIN);
        assertEq(tok.epoch(), 0); // nothing settled, nothing written
        _halt();
        vm.prank(attacker);
        tok.buy{value: 100 ether}(attacker, 0);
        vm.warp(block.timestamp + 31 minutes);
        _push(BASE);
        assertEq(tok.epoch(), 1);
        (uint256 got,) = tok.claim(0, attacker);
        assertEq(got, 0.99e18); // filled at the second match's post-match price
    }

    // -------------------------- scheduled halts --------------------------

    function _schedule(uint64 from) internal {
        uint64[] memory froms = new uint64[](1);
        froms[0] = from;
        vm.prank(oracle);
        core.scheduleHalts(_ids(), froms);
    }

    /// The halt takes effect at the scheduled start with no oracle transaction
    /// at match time (the oracle may be down when play starts).
    function test_scheduledHaltStartsOnItsOwn() public {
        _schedule(uint64(block.timestamp + 30 minutes));
        vm.prank(attacker);
        assertGt(tok.buy{value: 100 ether}(attacker, 0), 0); // before the match: instant
        vm.warp(block.timestamp + 30 minutes);
        assertTrue(core.halted(address(tok)));
        vm.prank(attacker);
        assertEq(tok.buy{value: 100 ether}(attacker, 0), 0); // match time: queued
    }

    function test_earliestScheduledStartWins() public {
        uint64 t = uint64(block.timestamp);
        _schedule(t + 2 hours);
        _schedule(t + 1 hours);
        assertEq(core.haltFrom(address(tok)), t + 1 hours);
        _schedule(t + 3 hours); // later time does not delay the halt
        assertEq(core.haltFrom(address(tok)), t + 1 hours);
    }

    function test_pastStartHaltsImmediately() public {
        vm.warp(10 days);
        vm.prank(oracle);
        core.heartbeat();
        _schedule(uint64(block.timestamp - 1 hours)); // already in progress
        assertTrue(core.halted(address(tok)));
        assertEq(core.haltFrom(address(tok)), block.timestamp);
    }

    function test_pushBeforeStartKeepsTheSchedule() public {
        uint64 from = uint64(block.timestamp + 1 hours);
        _schedule(from);
        _push(760_000); // e.g. a late result from yesterday
        assertEq(core.haltFrom(address(tok)), from);
        assertFalse(core.halted(address(tok)));
    }

    function test_resumeCancelsAScheduledHalt() public {
        _schedule(uint64(block.timestamp + 1 hours)); // then the player withdraws
        vm.prank(oracle);
        core.resume(_ids());
        assertEq(core.haltFrom(address(tok)), 0);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(attacker);
        assertGt(tok.buy{value: 100 ether}(attacker, 0), 0);
    }

    function test_haltFromRangeReadsAllPlayers() public {
        vm.prank(admin);
        core.addPlayer("W-OTH", 2, BASE);
        _schedule(uint64(block.timestamp + 1 hours));
        uint64[] memory h = core.haltFromRange(0, 5); // clamps to playerCount
        assertEq(h.length, 2);
        assertEq(h[0], block.timestamp + 1 hours);
        assertEq(h[1], 0);
    }
}

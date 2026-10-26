// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {PlayerToken} from "../src/PlayerToken.sol";
import {TennisIndex} from "../src/TennisIndex.sol";

/// @notice Invariant suite: under arbitrary sequences of buys, sells and
///         level updates (with a generously funded counterparty pool), the
///         token must stay solvent and NAV must stay pinned to the level.
contract PlayerTokenInvariants is Test {
    TennisIndex internal core;
    PlayerToken internal tok;
    address internal admin = makeAddr("admin");
    address internal oracle = makeAddr("oracle");
    address[3] internal actors;
    uint256 internal seedId;
    bool internal claimFailed; // ghost: a claim for a real order reverted

    uint128 internal constant BASE = 750_000;

    function setUp() public {
        for (uint256 i; i < 3; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
            deal(actors[i], 10_000 ether);
        }
        core = new TennisIndex(admin, oracle, address(new PlayerToken()));
        vm.prank(oracle);
        core.heartbeat(); // trading needs a live oracle
        core.topUp{value: 1_000_000 ether}();
        vm.prank(admin);
        seedId = core.addPlayer("M-INV", 1, BASE);
        tok = PlayerToken(payable(core.player(seedId).token));
        // Fuzz the handlers below, not the contracts directly: direct calls
        // with random senders and zero value almost all revert (roles,
        // ZeroAmount), which left the economics unexercised.
        bytes4[] memory sel = new bytes4[](7);
        sel[0] = this.doBuy.selector;
        sel[1] = this.doSell.selector;
        sel[2] = this.doLevelChange.selector;
        sel[3] = this.doTransfer.selector;
        sel[4] = this.doHalt.selector;
        sel[5] = this.doPostMatch.selector;
        sel[6] = this.doClaim.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: sel}));
        targetContract(address(this));
    }

    /// Keep the pool far above any claim the handlers can create (supply is
    /// bounded by the buy cap; levels by 50,000.00), so "funded" invariants
    /// test the mechanism, not the pool size. Underfunding is covered by
    /// test_underfundedCoreDegradesGracefully.
    function _topUpIfLow() internal {
        if (core.poolBalance() < 1e9 ether) {
            core.topUp{value: 1e9 ether}(); // keeps treasury accounting intact
        }
    }

    // ------------------------------ handlers ------------------------------

    function doBuy(uint256 actorSeed, uint256 amount) public {
        _topUpIfLow();
        address a = actors[actorSeed % 3];
        if (amount == 0) amount = 1;
        if (amount > 100 ether) amount = 100 ether; // ~1 token at base (100 CHZ)
        if (amount > a.balance) return;
        vm.prank(a);
        try tok.buy{value: amount}(a, 0) {}
        catch (bytes memory err) {
            // only a dust buy that would mint 0 tokens may revert
            assertEq(bytes4(err), PlayerToken.ZeroAmount.selector);
        }
    }

    function doSell(uint256 actorSeed, uint256 fraction) public {
        address a = actors[actorSeed % 3];
        uint256 bal = tok.balanceOf(a);
        if (bal == 0) return;
        uint256 amt = bal < 2 ? bal : bal * (fraction % 101) / 100;
        if (amt == 0) amt = 1;
        if (amt > bal) amt = bal;
        vm.prank(a);
        tok.sell(amt, a, 0);
    }

    function doLevelChange(uint256 newLevel) public {
        _topUpIfLow();
        newLevel = newLevel % 50_000_000; // up to 50,000.00
        if (newLevel < core.MIN_LEVEL()) newLevel = core.MIN_LEVEL();
        vm.prank(admin);
        core.calibrateLevel(seedId, uint128(newLevel));
    }

    function doTransfer(uint256 actorSeed, uint256 fraction) public {
        address a = actors[actorSeed % 3];
        address b = actors[(actorSeed % 3 + 1) % 3];
        uint256 bal = tok.balanceOf(a);
        if (bal == 0) return;
        uint256 amt = bal < 2 ? bal : bal * (fraction % 101) / 100;
        if (amt == 0) amt = 1;
        vm.prank(a);
        tok.transfer(b, amt);
    }

    /// A live match starts: orders for this player queue from now on.
    function doHalt() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = seedId;
        uint64[] memory froms = new uint64[](1);
        froms[0] = uint64(block.timestamp);
        vm.prank(oracle);
        core.scheduleHalts(ids, froms);
    }

    /// Post-match push: lifts the halt and fills the queue at the new price.
    function doPostMatch(uint256 moveBps) public {
        if (!core.halted(address(tok))) return;
        _topUpIfLow();
        uint256 old = core.levelOf(seedId);
        uint256 d = (old * (moveBps % 2_501)) / 10_000; // within the ±25% cap
        uint256 lvl = moveBps % 2 == 0 ? old + d : old - d;
        if (lvl < core.MIN_LEVEL()) lvl = core.MIN_LEVEL();
        vm.prank(oracle);
        core.updateLevel(seedId, uint128(lvl));
    }

    /// Claim every settled order of one actor; a claim for an existing order
    /// must never revert (no underflow in pendingChz or the batch shares).
    function doClaim(uint256 actorSeed) public {
        address a = actors[actorSeed % 3];
        for (uint32 e; e < tok.epoch(); ++e) {
            (, uint256 buyChz, uint256 sellTokens) = tok.orders(e, a);
            if (buyChz == 0 && sellTokens == 0) continue;
            try tok.claim(e, a) {} catch { claimFailed = true; }
        }
    }

    // ----------------------------- invariants -----------------------------

    /// Queued buy CHZ and unclaimed payouts are always fully held, and every
    /// claim for a real order succeeds.
    function invariant_queueFullyBacked() public view {
        assertGe(address(tok).balance, tok.pendingChz());
        assertFalse(claimFailed, "a claim for a settled order reverted");
    }


    /// Solvency: selling the entire supply at the quoted NAV can never
    /// exceed the reserve the token actually holds.
    function invariant_reserveCoversFullRedemption() public view {
        uint256 s = tok.totalSupply();
        uint256 r = tok.reserveWad();
        uint256 nav = tok.navWad();
        assertLe(s * nav / 1e18, r, "reserve cannot cover full supply redemption");
    }

    /// NAV must never exceed the level-implied target by more than rounding
    /// dust (overcollateralization drift is bounded).
    /// Rounding always favours remaining holders, but only by wei: the reserve
    /// may exceed the level-implied target by dust, never by real value.
    /// (Checked on the reserve in wei, not on NAV: with a supply of a few wei
    /// of a token, 1 wei of reserve is a large NAV percentage.)
    function invariant_navNotAboveLevelTarget() public view {
        uint256 s = tok.totalSupply();
        if (s == 0) {
            assertEq(tok.navWad(), core.targetNavOf(address(tok)));
            return;
        }
        uint256 targetR = s * core.targetNavOf(address(tok)) / 1e18;
        // Every buy floors its mint, leaving < 1 wei-token of value (< nav/1e18
        // wei) with the holders until the next sweep; targetR also goes through
        // the floored per-token price. Bounded far below 1 gwei over a run.
        assertLe(tok.reserveWad(), targetR + s / 1e18 + 1 gwei, "reserve drifted above level target");
    }

    /// The pool is generously funded by the handlers, so funding always lands:
    /// the reserve never falls short of the level-implied target by more than
    /// rounding dust (see invariant_navNotAboveLevelTarget).
    function invariant_navNearLevelTarget() public view {
        uint256 s = tok.totalSupply();
        if (s == 0) return;
        uint256 targetR = s * core.targetNavOf(address(tok)) / 1e18;
        assertGe(tok.reserveWad() + s / 1e18 + 1 gwei, targetR, "reserve fell below level target despite funding");
    }

    /// Ghost: the sum of all actor token values plus dust equals the reserve.
    function invariant_wealthSumEqualsReserve() public view {
        uint256 nav = tok.navWad();
        uint256 wealth;
        for (uint256 i; i < 3; ++i) {
            wealth += tok.balanceOf(actors[i]) * nav / 1e18;
        }
        uint256 r = tok.reserveWad();
        // tokens held by nobody (rounding dust) account for the difference
        uint256 s = tok.totalSupply();
        uint256 held;
        for (uint256 i; i < 3; ++i) held += tok.balanceOf(actors[i]);
        uint256 dustValue = (s - held) * nav / 1e18;
        // each floor(balance * nav) loses < 1 wei, plus nav itself is floored
        // (< 1 wei per whole token of supply)
        assertApproxEqAbs(wealth + dustValue, r, s / 1e18 + 10, "holder wealth must equal reserve");
    }

    /// Accrued treasury revenue is always fully held by the core, so a
    /// withdrawal can never dip into the pool (poolBalance never underflows).
    function invariant_treasuryFullyBacked() public view {
        assertGe(address(core).balance, core.treasuryBalance());
        assertEq(core.poolBalance() + core.treasuryBalance(), address(core).balance);
    }

    /// Level bookkeeping consistency between core and token.
    function invariant_tokenLevelMatchesCore() public view {
        assertEq(core.tokenLevel(address(tok)), core.levelOf(seedId));
        assertGe(core.levelOf(seedId), core.MIN_LEVEL());
    }
}

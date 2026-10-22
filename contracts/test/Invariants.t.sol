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

    uint128 internal constant BASE = 750_000;

    function setUp() public {
        for (uint256 i; i < 3; ++i) {
            actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
            deal(actors[i], 10_000 ether);
        }
        core = new TennisIndex(admin, oracle, address(new PlayerToken()));
        core.topUp{value: 1_000_000 ether}();
        vm.prank(admin);
        seedId = core.addPlayer("ATP-INV", 1, BASE);
        tok = PlayerToken(payable(core.player(seedId).token));
        targetContract(address(tok));
        targetContract(address(core));
    }

    function _topUpIfLow() internal {
        if (address(core).balance < 100 ether) {
            vm.deal(address(core), 1_000_000 ether);
        }
    }

    // ------------------------------ handlers ------------------------------

    function doBuy(uint256 actorSeed, uint256 amount) public {
        _topUpIfLow();
        address a = actors[actorSeed % 3];
        if (amount == 0) amount = 1;
        if (amount > 1 ether) amount = 1 ether;
        if (amount > a.balance) return;
        vm.prank(a);
        tok.buy{value: amount}(a, 0);
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
        address b = actors[(actorSeed + 1) % 3];
        uint256 bal = tok.balanceOf(a);
        if (bal == 0) return;
        uint256 amt = bal < 2 ? bal : bal * (fraction % 101) / 100;
        if (amt == 0) amt = 1;
        vm.prank(a);
        tok.transfer(b, amt);
    }

    // ----------------------------- invariants -----------------------------

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
    function invariant_navNotAboveLevelTarget() public view {
        uint256 target = tok.targetNav(core.tokenLevel(address(tok)));
        uint256 nav = tok.navWad();
        if (tok.totalSupply() == 0) {
            assertEq(nav, target);
        } else {
            assertLe(nav, target + target / 1e12 + 2, "NAV drifted above level target");
        }
    }

    /// After funded updates NAV stays within 0.1% below the level target.
    function invariant_navNearLevelTarget() public view {
        uint256 target = tok.targetNav(core.tokenLevel(address(tok)));
        uint256 nav = tok.navWad();
        if (tok.totalSupply() == 0) return;
        // counterparty is generously funded by the handler, so funding
        // should always fully land; allow a 0.1% shortfall tolerance.
        assertGe(nav, (target * 999) / 1000, "NAV fell far below level target despite funding");
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
        assertApproxEqAbs(wealth + dustValue, r, 100, "holder wealth must equal reserve");
    }

    /// Level bookkeeping consistency between core and token.
    function invariant_tokenLevelMatchesCore() public view {
        assertEq(core.tokenLevel(address(tok)), core.levelOf(seedId));
        assertGe(core.levelOf(seedId), core.MIN_LEVEL());
    }
}

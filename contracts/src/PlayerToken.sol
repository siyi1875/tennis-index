// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Upgradeable} from "openzeppelin-contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "openzeppelin-contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ITennisIndexCore} from "./ITennisIndexCore.sol";

// Levels are 2dp: 750_000 == 7,500.00, the season base level.
uint128 constant BASE_LEVEL = 750_000;
// Token price at the base level: 100 CHZ. Price scales linearly with level.
uint256 constant CHZ_AT_BASE = 100;
// Highest fee either side may charge (5%).
uint16 constant MAX_FEE_BPS = 500;

// Level-implied reserve for `supply` tokens (wei CHZ). Shared by the token
// (sweep) and the core (funding) so both sides use exactly the same target.
function targetReserve(uint256 supply, uint128 level) pure returns (uint256) {
    return (supply * uint256(level) * CHZ_AT_BASE) / BASE_LEVEL;
}

/// @title PlayerToken
/// @notice Tradable index token for one tennis player (FSPI-style Points
///         Attribution Table computed off-chain, levels fed on-chain by the
///         oracle through the TennisIndex core). Deployed as a minimal proxy
///         clone from the implementation registered in the core.
///
/// Economic model
/// - At the base level (7,500.00) one token is priced at 100 CHZ.
/// - NAV (wei CHZ per 1 token) = reserve / totalSupply once supply exists;
///   before that it is the level-implied target NAV, read from the core.
/// - The core registry is the performance counterparty: on every index level
///   update it funds the reserve up to (or sweeps excess back from) the
///   level-implied target, so holder wealth tracks the player's index level.
///   If the core cannot fund fully, NAV simply floats below the target
///   (graceful degradation) and the token stays 100% reserve-backed.
/// - Buy mints at NAV; sell burns and pays from the reserve. Fees go to the
///   core's collectFee(), which splits them between treasury and pool.
///   Invariant: sells can never pay out more than the reserve holds, because
///   NAV is derived from the reserve itself.
///
/// Gas layout: one packed slot holds core (160b) | buyFee (16b) | sellFee
/// (16b) | symbol (8 ASCII chars, little-endian). The symbol is limited to 8
/// characters on purpose ("ATP-SIN" style codes).
contract PlayerToken is ERC20Upgradeable, ReentrancyGuardUpgradeable {
    uint256 private constant _PACKED_FEES_MASK = ((1 << 32) - 1) << 64;
    uint256 private _packed; // core (160b) | buyFee (16b) | sellFee (16b) | symbol (8 chars, LE)

    event Bought(address indexed buyer, address indexed to, uint256 chzIn, uint256 tokensOut, uint256 navWad);
    event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 chzOut, uint256 navWad);
    event Rebalanced(uint128 oldLevel, uint128 newLevel, uint256 supply, uint256 reserveWad, uint256 navWad);
    event FeesUpdated(uint16 buyBps, uint16 sellBps);

    error OnlyCore();
    error Slippage(uint256 expected, uint256 got);
    error ZeroAmount();
    error FeeTooHigh();
    error CorePaused();
    error BadSymbol();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {}

    /// @dev Only the core calls this, atomically right after clone creation,
    ///      so re-initialization is impossible; the `_packed != 0` guard is a
    ///      cheap backstop that also skips the OZ Initializable slot write.
    ///      Fees are live from the first trade (no fee-free window).
    function initialize(string calldata symbol_, address core_, uint16 buyBps, uint16 sellBps) external {
        if (_packed != 0) revert();
        if (core_ == address(0)) revert ZeroAmount();
        if (buyBps > MAX_FEE_BPS || sellBps > MAX_FEE_BPS) revert FeeTooHigh();
        bytes memory b = bytes(symbol_);
        if (b.length == 0 || b.length > 8) revert BadSymbol();
        uint64 sym;
        for (uint256 i = 0; i < b.length; ++i) sym |= uint64(uint8(b[i])) << (8 * i);
        // core | sellFee | buyFee | symbol
        _packed = (uint256(uint160(core_)) << 96) | (uint256(sellBps) << 80) | (uint256(buyBps) << 64) | uint256(sym);
        emit FeesUpdated(buyBps, sellBps);
    }

    function core() public view returns (address) {
        return address(uint160(_packed >> 96));
    }

    function buyFeeBps() public view returns (uint16) {
        return uint16(_packed >> 64);
    }

    function sellFeeBps() public view returns (uint16) {
        return uint16(_packed >> 80);
    }

    function setFees(uint16 buyBps, uint16 sellBps) external onlyCore {
        if (buyBps > MAX_FEE_BPS || sellBps > MAX_FEE_BPS) revert FeeTooHigh();
        _packed = (_packed & ~_PACKED_FEES_MASK) | (uint256(buyBps) << 64) | (uint256(sellBps) << 80);
        emit FeesUpdated(buyBps, sellBps);
    }

    function symbol() public view override returns (string memory out) {
        uint64 sym = uint64(_packed);
        uint256 len = 8;
        while (len > 0 && (sym >> (8 * (len - 1))) & 0xff == 0) --len;
        out = new string(len);
        bytes memory b = bytes(out);
        for (uint256 i = 0; i < len; ++i) b[i] = bytes1(uint8(sym >> (8 * i)));
    }

    function name() public view override returns (string memory) {
        return string.concat("FSPI Tennis ", symbol());
    }

    receive() external payable {}

    // --------------------------- NAV & trading ---------------------------

    function reserveWad() public view returns (uint256) {
        return address(this).balance;
    }

    /// @dev Level-implied NAV: level is 2dp (750000 -> 100 CHZ per token).
    function targetNav(uint128 level) public pure returns (uint256) {
        return targetReserve(1e18, level);
    }

    /// @notice Actual NAV in wei CHZ per token. Before any supply exists this
    ///         equals the level-implied target from the core; afterwards it is
    ///         reserve/supply (never above the reserve's ability to pay).
    function navWad() public view returns (uint256) {
        uint256 s = totalSupply();
        if (s == 0) return targetNav(ITennisIndexCore(core()).tokenLevel(address(this)));
        return (reserveWad() * 1e18) / s;
    }

    function buy(address to, uint256 minTokensOut) external payable nonReentrant returns (uint256 out) {
        if (ITennisIndexCore(core()).paused()) revert CorePaused();
        if (msg.value == 0) revert ZeroAmount();
        uint256 fee = (msg.value * buyFeeBps()) / 10_000;
        uint256 net = msg.value - fee;
        uint256 s = totalSupply();
        // NAV must be measured BEFORE the incoming value lands in the reserve:
        // address(this).balance already includes msg.value during this call.
        uint256 nav = s == 0
            ? navWad()
            : ((address(this).balance - msg.value) * 1e18) / s;
        if (nav == 0) revert ZeroAmount();
        out = (net * 1e18) / nav;
        if (out < minTokensOut) revert Slippage(minTokensOut, out);
        _mint(to, out);
        if (fee > 0) ITennisIndexCore(core()).collectFee{value: fee}();
        emit Bought(msg.sender, to, msg.value, out, nav);
    }

    /// @notice Burn tokens and receive CHZ from the reserve.
    function sell(uint256 tokenIn, address to, uint256 minChzOut) external nonReentrant returns (uint256 net) {
        if (ITennisIndexCore(core()).paused()) revert CorePaused();
        if (tokenIn == 0) revert ZeroAmount();
        uint256 s = totalSupply();
        if (s == 0) revert ZeroAmount();
        uint256 nav = (reserveWad() * 1e18) / s;
        uint256 gross = (tokenIn * nav) / 1e18;
        uint256 fee = (gross * sellFeeBps()) / 10_000;
        net = gross - fee;
        if (net < minChzOut) revert Slippage(minChzOut, net);
        _burn(msg.sender, tokenIn);
        if (fee > 0) ITennisIndexCore(core()).collectFee{value: fee}();
        _transferETH(to, net);
        emit Sold(msg.sender, to, tokenIn, net, nav);
    }

    /// @notice Settle performance P&L for a level move. The core attaches CHZ
    ///         when the level rose (funding the reserve up to the new
    ///         level-implied target) and the token sweeps any excess above
    ///         the target back to the core (level fell, or core overfunded).
    ///         Levels themselves live in the core; nothing is stored here.
    function applyIndexLevel(uint128 oldLevel, uint128 newLevel) external payable onlyCore {
        if (newLevel == oldLevel) return;
        uint256 s = totalSupply();
        if (s == 0) {
            if (msg.value > 0) revert ZeroAmount();
            emit Rebalanced(oldLevel, newLevel, 0, 0, 0);
            return;
        }
        uint256 r = address(this).balance; // includes any funding attached
        uint256 rTarget = targetReserve(s, newLevel);
        if (r > rTarget) {
            // Sweep surplus back to the core counterparty pool.
            _transferETH(core(), r - rTarget);
        }
        emit Rebalanced(oldLevel, newLevel, s, address(this).balance, navWad());
    }

    // ------------------------------ utils ------------------------------

    function _transferETH(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert();
    }

    modifier onlyCore() {
        if (msg.sender != core()) revert OnlyCore();
        _;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Upgradeable} from "openzeppelin-contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ReentrancyGuardUpgradeable} from "openzeppelin-contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {ITennisIndexCore} from "./ITennisIndexCore.sol";

// Levels are 2dp: 750_000 == 7,500.00, the season base level.
uint128 constant BASE_LEVEL = 750_000;
// Token price at the base level: 100 CHZ (before any season carry-over scale).
uint256 constant CHZ_AT_BASE = 100;
// Highest fee either side may charge (5%).
uint16 constant MAX_FEE_BPS = 500;

// Core trade status for a token (ITennisIndexCore.tradeStatus).
uint8 constant TRADE_OPEN = 0; // instant fills at NAV
uint8 constant TRADE_QUEUED = 1; // live match: orders queue, fill at the post-match NAV
uint8 constant TRADE_PAUSED = 2; // core paused
uint8 constant TRADE_STALE = 3; // oracle heartbeat missed: no trading on a stale price

// Level-implied reserve for `supply` tokens (wei CHZ). `scaleWad` is the
// token's season carry-over factor (1e18 until its first season reset).
function targetReserve(uint256 supply, uint128 level, uint256 scaleWad) pure returns (uint256) {
    return (supply * uint256(level) * CHZ_AT_BASE * scaleWad) / (uint256(BASE_LEVEL) * 1e18);
}

/// @title PlayerToken
/// @notice Tradable form token for one tennis player (form level computed
///         off-chain from match results, levels fed on-chain by the
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
/// Live-match queue
/// - While the player's match is live the core reports TRADE_QUEUED. Buys and
///   sells are then accepted but not filled: buy CHZ is held aside
///   (`pendingChz`, never part of the reserve) and sell tokens are escrowed in
///   this contract, where they still carry the match result. When the oracle
///   pushes the post-match level, the core calls settleQueue(): the whole
///   batch fills at that single post-match NAV, and each user claim()s their
///   tokens or CHZ. Queued orders cannot be cancelled — a cancel would be a
///   free option on the match outcome.
///
/// Gas layout: one packed slot holds core (160b) | buyFee (16b) | sellFee
/// (16b) | symbol (8 ASCII chars, little-endian). The symbol is limited to 8
/// characters on purpose ("M-SIN" style codes).
contract PlayerToken is ERC20Upgradeable, ReentrancyGuardUpgradeable {
    uint256 private constant _PACKED_FEES_MASK = ((1 << 32) - 1) << 64;
    uint256 private _packed; // core (160b) | buyFee (16b) | sellFee (16b) | symbol (8 chars, LE)

    /// One batch per live-match halt. Totals are per batch; fills are pro rata.
    struct Batch {
        uint256 buyChz; // queued buy CHZ, net of fee
        uint256 sellTokens; // escrowed sell tokens
        uint256 minted; // tokens minted for the buys at settlement
        uint256 payout; // CHZ for the sells at settlement, net of fee
        uint256 nav; // sell fill price (reserve / supply)
        uint256 buyNav; // buy fill price (capped at the level-implied price)
        bool settled;
        bool refunded; // buys would mint nothing: buyers get their CHZ back
    }

    struct Order {
        uint256 paid; // CHZ sent, incl. fee (for the Bought event / PnL)
        uint256 buyChz; // net of fee
        uint256 sellTokens;
    }

    /// Reserve shortfall below target treated as rounding, not underfunding.
    uint256 private constant ROUNDING_WEI = 10;

    uint32 public epoch; // current (open) batch
    uint256 public pendingChz; // queued buy CHZ + unclaimed sell payouts (not reserve)
    mapping(uint32 => Batch) public batches;
    mapping(uint32 => mapping(address => Order)) public orders;

    event Bought(address indexed buyer, address indexed to, uint256 chzIn, uint256 tokensOut, uint256 navWad);
    event Sold(address indexed seller, address indexed to, uint256 tokensIn, uint256 chzOut, uint256 navWad);
    event Rebalanced(uint128 oldLevel, uint128 newLevel, uint256 supply, uint256 reserveWad, uint256 navWad);
    event FeesUpdated(uint16 buyBps, uint16 sellBps);
    event BuyQueued(address indexed buyer, address indexed to, uint32 indexed epoch, uint256 chzIn, uint256 chzNet);
    event SellQueued(address indexed seller, address indexed to, uint32 indexed epoch, uint256 tokensIn);
    event QueueSettled(uint32 indexed epoch, uint256 navWad, uint256 buyChz, uint256 minted, uint256 sellTokens, uint256 payout);
    event Claimed(address indexed who, uint32 indexed epoch, uint256 tokensOut, uint256 chzOut);

    error OnlyCore();
    error Slippage(uint256 expected, uint256 got);
    error ZeroAmount();
    error FeeTooHigh();
    error CorePaused();
    error OracleStale();
    error BadSymbol();
    error NotSettled(uint32 epoch);
    error NothingToClaim();

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
        return string.concat("Tennis Form ", symbol());
    }

    receive() external payable {}

    // --------------------------- NAV & trading ---------------------------

    /// @notice CHZ backing the supply. Queued buy CHZ and unclaimed sell
    ///         payouts sit in this contract too but belong to their users, so
    ///         they are excluded (otherwise they would inflate NAV).
    function reserveWad() public view returns (uint256) {
        return address(this).balance - pendingChz;
    }

    /// @notice Actual NAV in wei CHZ per token. Before any supply exists this
    ///         equals the level-implied target from the core; afterwards it is
    ///         reserve/supply (never above the reserve's ability to pay).
    function navWad() public view returns (uint256) {
        uint256 s = totalSupply();
        if (s == 0) return ITennisIndexCore(core()).targetNavOf(address(this));
        return (reserveWad() * 1e18) / s;
    }

    /// @notice Buy at NAV, or queue for the post-match NAV during a live match
    ///         (returns 0 when queued; minTokensOut applies to instant fills).
    function buy(address to, uint256 minTokensOut) external payable nonReentrant returns (uint256 out) {
        uint8 st = _tradeStatus();
        if (msg.value == 0) revert ZeroAmount();
        uint256 fee = (msg.value * buyFeeBps()) / 10_000;
        uint256 net = msg.value - fee;
        if (st == TRADE_QUEUED) {
            uint32 e = epoch;
            pendingChz += net;
            batches[e].buyChz += net;
            Order storage o = orders[e][to];
            o.paid += msg.value;
            o.buyChz += net;
            if (fee > 0) ITennisIndexCore(core()).collectFee{value: fee}();
            emit BuyQueued(msg.sender, to, e, msg.value, net);
            return 0;
        }
        // NAV must be measured BEFORE the incoming value lands in the reserve:
        // address(this).balance already includes msg.value during this call.
        uint256 nav = _buyNav(reserveWad() - msg.value);
        if (nav == 0) revert ZeroAmount();
        out = (net * 1e18) / nav;
        if (out == 0) revert ZeroAmount(); // would keep the CHZ and mint nothing
        if (out < minTokensOut) revert Slippage(minTokensOut, out);
        _mint(to, out);
        if (fee > 0) ITennisIndexCore(core()).collectFee{value: fee}();
        emit Bought(msg.sender, to, msg.value, out, nav);
    }

    /// @notice Burn tokens and receive CHZ from the reserve, or escrow them for
    ///         the post-match NAV during a live match (returns 0 when queued).
    function sell(uint256 tokenIn, address to, uint256 minChzOut) external nonReentrant returns (uint256 net) {
        uint8 st = _tradeStatus();
        if (tokenIn == 0) revert ZeroAmount();
        if (st == TRADE_QUEUED) {
            uint32 e = epoch;
            _transfer(msg.sender, address(this), tokenIn); // still exposed to the result
            batches[e].sellTokens += tokenIn;
            orders[e][to].sellTokens += tokenIn;
            emit SellQueued(msg.sender, to, e, tokenIn);
            return 0;
        }
        uint256 s = totalSupply();
        if (s == 0) revert ZeroAmount();
        uint256 nav = (reserveWad() * 1e18) / s;
        // the last holder out takes the whole reserve, rounding dust included
        uint256 gross = tokenIn == s ? reserveWad() : (tokenIn * nav) / 1e18;
        uint256 fee = (gross * sellFeeBps()) / 10_000;
        net = gross - fee;
        if (net < minChzOut) revert Slippage(minChzOut, net);
        _burn(msg.sender, tokenIn);
        if (fee > 0) ITennisIndexCore(core()).collectFee{value: fee}();
        _transferETH(to, net);
        emit Sold(msg.sender, to, tokenIn, net, nav);
    }

    /// @notice Settle performance P&L for a level move. The core attaches CHZ
    ///         when the level rose (funding the reserve up to `rTarget`) and the
    ///         token sweeps any excess above `rTarget` back to the core (level
    ///         fell, or core overfunded). The core computes the target; levels
    ///         and price scale live there, nothing is stored here.
    function applyIndexLevel(uint128 oldLevel, uint128 newLevel, uint256 rTarget) external payable onlyCore {
        uint256 s = totalSupply();
        if (s == 0) {
            if (msg.value > 0) revert ZeroAmount();
            emit Rebalanced(oldLevel, newLevel, 0, 0, 0);
            return;
        }
        uint256 r = reserveWad(); // includes any funding attached
        if (r > rTarget) {
            // Sweep surplus back to the core counterparty pool.
            _transferETH(core(), r - rTarget);
        }
        emit Rebalanced(oldLevel, newLevel, s, reserveWad(), navWad());
    }

    /// @notice Fill the open batch at the current (post-match) NAV and open the
    ///         next one. Called by the core in the same transaction that pushed
    ///         the new level, so no trade can ever see the pre-match price.
    ///         O(1): users claim their share afterwards. An empty batch (the
    ///         usual case) costs nothing and stays open for the next halt.
    function settleQueue() external onlyCore {
        uint32 e = epoch;
        Batch storage b = batches[e];
        if (b.buyChz == 0 && b.sellTokens == 0) return;
        epoch = e + 1;
        uint256 nav = navWad();
        uint256 buyNav = _buyNav(reserveWad());
        b.nav = nav;
        b.buyNav = buyNav;
        b.settled = true;
        if (b.sellTokens > 0) {
            uint256 gross = b.sellTokens == totalSupply() ? reserveWad() : (b.sellTokens * nav) / 1e18;
            uint256 fee = (gross * sellFeeBps()) / 10_000;
            _burn(address(this), b.sellTokens);
            b.payout = gross - fee;
            pendingChz += b.payout; // moves out of the reserve, owed to sellers
            if (fee > 0) ITennisIndexCore(core()).collectFee{value: fee}();
        }
        if (b.buyChz > 0) {
            uint256 minted = buyNav == 0 ? 0 : (b.buyChz * 1e18) / buyNav;
            if (minted == 0) {
                b.refunded = true; // nothing to mint (dust): buyers reclaim their CHZ
            } else {
                b.minted = minted;
                pendingChz -= b.buyChz; // joins the reserve
                _mint(address(this), minted);
            }
        }
        emit QueueSettled(e, nav, b.buyChz, b.minted, b.sellTokens, b.payout);
    }

    /// @notice Deliver `who`'s fills from a settled batch. Anyone may call it;
    ///         tokens and CHZ only ever go to `who`.
    function claim(uint32 e, address who) external nonReentrant returns (uint256 tokensOut, uint256 chzOut) {
        Batch storage b = batches[e];
        if (!b.settled) revert NotSettled(e);
        Order memory o = orders[e][who];
        if (o.buyChz == 0 && o.sellTokens == 0) revert NothingToClaim();
        delete orders[e][who];
        if (o.buyChz > 0) {
            if (b.refunded) {
                chzOut += o.buyChz;
                pendingChz -= o.buyChz;
            } else {
                tokensOut = (o.buyChz * b.minted) / b.buyChz;
                _transfer(address(this), who, tokensOut);
                emit Bought(who, who, o.paid, tokensOut, b.buyNav);
            }
        }
        if (o.sellTokens > 0) {
            uint256 sellChz = (o.sellTokens * b.payout) / b.sellTokens;
            pendingChz -= sellChz;
            chzOut += sellChz;
            emit Sold(who, who, o.sellTokens, sellChz, b.nav);
        }
        if (chzOut > 0) _transferETH(who, chzOut);
        emit Claimed(who, e, tokensOut, chzOut);
    }

    // ------------------------------ utils ------------------------------

    /// @dev Price for a buy given the reserve before it: the level-implied
    ///      price, or the real NAV when the token is genuinely underfunded.
    ///      Reserve/supply is only trusted beyond wei-level rounding: at a tiny
    ///      supply, one wei of reserve moves it by a large percentage (a dust
    ///      first buy, or a CHZ donation, would let it run far above target;
    ///      the floor in funding a little below). Buyers must neither pay for
    ///      such a surplus nor buy at such a discount. Sells pay reserve/supply.
    function _buyNav(uint256 reserveBefore) internal view returns (uint256 nav) {
        nav = ITennisIndexCore(core()).targetNavOf(address(this));
        uint256 s = totalSupply();
        if (s > 0 && reserveBefore + ROUNDING_WEI < (s * nav) / 1e18) {
            nav = (reserveBefore * 1e18) / s; // underfunded: buy at the real NAV
        }
    }

    function _tradeStatus() internal view returns (uint8 st) {
        st = ITennisIndexCore(core()).tradeStatus(address(this));
        if (st == TRADE_PAUSED) revert CorePaused();
        if (st == TRADE_STALE) revert OracleStale();
    }

    function _transferETH(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert();
    }

    modifier onlyCore() {
        if (msg.sender != core()) revert OnlyCore();
        _;
    }
}

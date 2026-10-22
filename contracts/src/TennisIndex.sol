// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "openzeppelin-contracts/access/AccessControl.sol";
import {Pausable} from "openzeppelin-contracts/utils/Pausable.sol";
import {Clones} from "openzeppelin-contracts/proxy/Clones.sol";
import {
    PlayerToken,
    BASE_LEVEL,
    MAX_FEE_BPS,
    TRADE_OPEN,
    TRADE_QUEUED,
    TRADE_PAUSED,
    TRADE_STALE,
    targetReserve
} from "./PlayerToken.sol";

/// @title TennisIndex
/// @notice Registry of ATP/WTA player performance indexes (FSPI-style) with an
///         oracle-gated level feed. Each player gets its own tradable
///         PlayerToken whose NAV tracks the player's index level. Human names
///         are kept off-chain by the oracle's registry; the chain stores the
///         tradable essentials only.
///
/// Levels are stored with 2 decimals: 750_000 == 7,500.00 (FSPI base level).
/// The oracle (off-chain, ATP/WTA official results via ESPN) computes levels
/// with a published expectation-relative scoring table and pushes official closes.
///
/// The core is the performance counterparty: when a level rises it funds the
/// player token's reserve up to the level-implied target (drawn from this
/// contract's CHZ balance); when it falls the token sweeps the surplus back
/// here. Fund this contract via topUp().
///
/// Fees are split on arrival (collectFee): `treasuryShareBps` is revenue the
/// admin can withdraw to the `treasury` address; the rest joins the pool.
/// The treasury's CHZ sits in this contract's balance but is never used to
/// fund level rises — only `poolBalance()` is.
///
/// Live matches: the oracle posts each day's order of play in advance
/// (scheduleHalts); a player's token halts automatically at their scheduled
/// start, with no transaction needed at match time. While halted, the player's token queues orders instead of filling
/// them; the oracle's post-match updateLevel() lifts the halt and fills the
/// queue at the new price in the same transaction, so nobody can trade on a
/// result the price does not yet reflect. Every oracle transaction is also a
/// heartbeat: if the oracle goes quiet for `heartbeatMaxAge`, all trading
/// stops (fail closed) rather than run on a stale price.
///
/// Season reset: the level returns to 7,500.00 but the token's price carries
/// over unchanged (a per-token scale absorbs the difference). No CHZ moves at
/// the reset, so there is nothing to arbitrage around it.
contract TennisIndex is AccessControl, Pausable {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Player {
        address token;
        uint8 tour; // 1 = ATP, 2 = WTA
        uint128 level; // 2dp
        uint64 lastUpdate;
    }

    Player[] internal _players;
    mapping(address => uint128) public tokenLevel;
    address public tokenImplementation;

    uint16 public maxDeltaBps = 2_500; // ±25% per oracle update
    uint64 public minUpdateInterval = 30 minutes;
    uint128 public constant MIN_LEVEL = 10_000; // 100.00

    /// Fees every new token starts with (bps). Live from the first trade.
    uint16 public defaultBuyFeeBps = 100; // 1%
    uint16 public defaultSellFeeBps = 100; // 1%

    /// Revenue split of every trading fee. The pool always keeps at least
    /// 20% of each fee, so fees keep rebuilding the reserve buffer.
    uint16 public constant MAX_TREASURY_SHARE_BPS = 8_000;
    uint16 public treasuryShareBps = 5_000; // 50% treasury / 50% pool
    address public treasury; // payout address for withdrawTreasury
    uint256 public treasuryBalance; // accrued, not yet withdrawn

    /// Live-match halts, keyed by token: halted from this timestamp on (0 =
    /// none). Halted tokens queue their orders until the post-match push.
    mapping(address => uint64) public haltFrom;
    uint64 public lastHeartbeat; // last oracle transaction
    /// Halts are posted ahead of time, so this only guards matches the oracle
    /// never got to schedule; a short outage need not stop all trading.
    uint64 public heartbeatMaxAge = 1 hours;

    /// Season carry-over price scale per token (wei; 0 means 1e18).
    mapping(address => uint256) internal _navScale;

    error UnknownPlayer(uint256 id);
    error LevelTooLow();
    error DeltaTooBig();
    error TooSoon();

    event PlayerAdded(uint256 indexed id, address indexed token, string symbol, uint8 tour, uint128 level);
    event LevelUpdated(uint256 indexed id, uint128 oldLevel, uint128 newLevel, uint256 fundingWad, uint256 sweepWad);
    event LevelCalibrated(uint256 indexed id, uint128 oldLevel, uint128 newLevel);
    event SeasonReset(uint256 count);
    event ParamsUpdated(uint16 maxDeltaBps, uint64 minUpdateInterval);
    event DefaultFeesUpdated(uint16 buyBps, uint16 sellBps);
    event FeeCollected(address indexed token, uint256 amount, uint256 toTreasury);
    event TreasuryWithdrawn(address indexed to, uint256 amount);
    event TreasuryUpdated(address treasury, uint16 shareBps);
    event HaltScheduled(uint256 indexed id, uint64 from);
    event Resumed(uint256 indexed id);
    event Heartbeat(uint64 at);
    event HeartbeatMaxAgeUpdated(uint64 maxAge);
    event SeasonCarried(uint256 indexed id, uint128 oldLevel, uint256 navScale);

    constructor(address admin, address oracle, address tokenImplementation_) {
        require(tokenImplementation_ != address(0), "impl");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, oracle);
        _grantRole(PAUSER_ROLE, admin);
        tokenImplementation = tokenImplementation_;
        treasury = admin;
    }

    receive() external payable {}

    /// @notice Fund the counterparty pool that backs index performance gains.
    function topUp() external payable {}

    /// @notice Trading fees from player tokens. Splits each fee between the
    ///         treasury (withdrawable revenue) and the pool.
    function collectFee() external payable {
        uint256 toTreasury = (msg.value * treasuryShareBps) / 10_000;
        treasuryBalance += toTreasury;
        emit FeeCollected(msg.sender, msg.value, toTreasury);
    }

    /// @notice How a token may trade right now (see PlayerToken TRADE_*).
    function tradeStatus(address token) external view returns (uint8) {
        if (paused()) return TRADE_PAUSED;
        if (block.timestamp > uint256(lastHeartbeat) + heartbeatMaxAge) return TRADE_STALE;
        return halted(token) ? TRADE_QUEUED : TRADE_OPEN;
    }

    /// @notice True while a token's halt is in effect.
    function halted(address token) public view returns (bool) {
        uint64 from = haltFrom[token];
        return from != 0 && block.timestamp >= from;
    }

    /// @notice Season carry-over scale (1e18 until the token's first reset).
    function navScaleOf(address token) public view returns (uint256) {
        uint256 k = _navScale[token];
        return k == 0 ? 1e18 : k;
    }

    /// @notice Level-implied price of one token in wei CHZ.
    function targetNavOf(address token) external view returns (uint256) {
        return targetReserve(1e18, tokenLevel[token], navScaleOf(token));
    }

    /// @notice CHZ available to fund level rises (excludes the treasury).
    function poolBalance() public view returns (uint256) {
        return address(this).balance - treasuryBalance;
    }

    // ------------------------------- views -------------------------------

    function playerCount() external view returns (uint256) {
        return _players.length;
    }

    function player(uint256 id) external view returns (Player memory) {
        return _players[id];
    }

    function playersRange(uint256 fromId, uint256 toId) external view returns (Player[] memory out) {
        if (toId > _players.length) toId = _players.length;
        out = new Player[](toId - fromId);
        for (uint256 i = fromId; i < toId; ++i) out[i - fromId] = _players[i];
    }

    /// @notice haltFrom for a range of player ids (one call for the oracle).
    function haltFromRange(uint256 fromId, uint256 toId) external view returns (uint64[] memory out) {
        if (toId > _players.length) toId = _players.length;
        out = new uint64[](toId - fromId);
        for (uint256 i = fromId; i < toId; ++i) out[i - fromId] = haltFrom[_players[i].token];
    }

    function levelOf(uint256 id) external view returns (uint128) {
        return _players[id].level;
    }

    /// @notice CHZ required to bring a player's token reserve up to the
    ///         level-implied target (negative means surplus that would be
    ///         swept back on the next update).
    function fundingRequirement(uint256 id) public view returns (uint256 required) {
        Player storage p = _players[id];
        PlayerToken tok = PlayerToken(payable(p.token));
        uint256 s = tok.totalSupply();
        uint256 r = tok.reserveWad();
        uint256 rTarget = targetReserve(s, p.level, navScaleOf(p.token));
        required = rTarget > r ? rTarget - r : 0;
    }

    // ----------------------------- registry -----------------------------

    /// @notice Register a player and deploy its index token. `initialLevel`
    ///         comes from the oracle's season backfill; 0 means base level.
    function addPlayer(string calldata symbol, uint8 tour, uint128 initialLevel)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
        returns (uint256 id)
    {
        address clone = Clones.clone(tokenImplementation);
        PlayerToken(payable(clone)).initialize(symbol, address(this), defaultBuyFeeBps, defaultSellFeeBps);
        if (initialLevel < MIN_LEVEL) revert LevelTooLow();
        if (initialLevel == 0) initialLevel = BASE_LEVEL;
        id = _players.length;
        _players.push(Player(clone, tour, initialLevel, 0));
        tokenLevel[clone] = initialLevel;
        emit PlayerAdded(id, clone, symbol, tour, initialLevel);
    }

    /// @notice Batched registration: one tx deploys many player tokens (shares
    ///         per-tx overhead). Symbols must be unique.
    function addPlayers(string[] calldata symbols, uint8[] calldata tours, uint128[] calldata initialLevels)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
        returns (uint256 firstId)
    {
        uint256 n = symbols.length;
        if (n == 0 || tours.length != n || initialLevels.length != n) revert();
        firstId = _players.length;
        for (uint256 i; i < n; ++i) {
            address clone = Clones.clone(tokenImplementation);
            PlayerToken(payable(clone)).initialize(symbols[i], address(this), defaultBuyFeeBps, defaultSellFeeBps);
            uint128 lvl = initialLevels[i];
            if (lvl < MIN_LEVEL) revert LevelTooLow();
            if (lvl == 0) lvl = BASE_LEVEL;
            _players.push(Player(clone, tours[i], lvl, 0));
            tokenLevel[clone] = lvl;
            emit PlayerAdded(firstId + i, clone, symbols[i], tours[i], lvl);
        }
    }

    /// @notice Admin-only calibration (launch backfill / error correction).
    ///         Bypasses the delta cap and update interval; every use is logged.
    function calibrateLevel(uint256 id, uint128 newLevel) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (id >= _players.length) revert UnknownPlayer(id);
        if (newLevel < MIN_LEVEL) revert LevelTooLow();
        Player storage p = _players[id];
        uint128 old = p.level;
        if (newLevel == old) return;
        _settle(id, old, newLevel);
        p.level = newLevel;
        emit LevelCalibrated(id, old, newLevel);
    }

    // ------------------------------ oracle ------------------------------

    /// @notice Push a level. For a halted player (the post-match push) the
    ///         update interval does not apply, and the halt is lifted and the
    ///         queue filled at the new price in this same transaction.
    function updateLevel(uint256 id, uint128 newLevel) public onlyRole(ORACLE_ROLE) whenNotPaused {
        if (id >= _players.length) revert UnknownPlayer(id);
        if (newLevel < MIN_LEVEL) revert LevelTooLow();
        Player storage p = _players[id];
        bool live = halted(p.token);
        if (!live && p.lastUpdate != 0 && block.timestamp < p.lastUpdate + minUpdateInterval) revert TooSoon();
        uint256 old = p.level;
        uint256 diff = newLevel > old ? newLevel - old : old - newLevel;
        if (diff * 10_000 > old * maxDeltaBps) revert DeltaTooBig();
        uint256 funded;
        uint256 swept;
        if (newLevel != old) (funded, swept) = _settle(id, uint128(old), newLevel);
        p.level = newLevel;
        p.lastUpdate = uint64(block.timestamp);
        _beat();
        emit LevelUpdated(id, uint128(old), newLevel, funded, swept);
        if (live) _resume(id);
    }

    function updateLevels(uint256[] calldata ids, uint128[] calldata levels) external onlyRole(ORACLE_ROLE) whenNotPaused {
        if (ids.length != levels.length || ids.length == 0) revert();
        for (uint256 i; i < ids.length; ++i) updateLevel(ids[i], levels[i]);
    }

    /// @notice Halt players from their scheduled start (before the first
    ///         point): from then on their tokens queue orders until the result.
    ///         Posted ahead of time, so halts take effect even if the oracle is
    ///         down when play starts. An earlier time replaces a later one;
    ///         a time in the past halts immediately.
    function scheduleHalts(uint256[] calldata ids, uint64[] calldata froms) external onlyRole(ORACLE_ROLE) {
        if (ids.length != froms.length) revert();
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] >= _players.length) revert UnknownPlayer(ids[i]);
            address token = _players[ids[i]].token;
            uint64 from = froms[i] < block.timestamp ? uint64(block.timestamp) : froms[i];
            uint64 cur = haltFrom[token];
            if (cur != 0 && cur <= from) continue;
            haltFrom[token] = from;
            emit HaltScheduled(ids[i], from);
        }
        _beat();
    }

    /// @notice Lift or cancel halts with no level change (walkover with no
    ///         level effect, cancellation, postponement); queued orders fill at
    ///         the current price.
    function resume(uint256[] calldata ids) external onlyRole(ORACLE_ROLE) whenNotPaused {
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] >= _players.length) revert UnknownPlayer(ids[i]);
            _resume(ids[i]);
        }
        _beat();
    }

    /// @notice Oracle liveness signal; any oracle transaction also counts.
    function heartbeat() external onlyRole(ORACLE_ROLE) {
        _beat();
    }

    /// @notice Season reset (Jan 1): levels return to the 7,500.00 base while
    ///         each token's price carries over unchanged. The token's scale
    ///         absorbs the change (newScale = scale × oldLevel / base), so the
    ///         level-implied target and NAV are the same before and after, and
    ///         no CHZ moves: there is no reset uplift to buy into.
    function seasonReset(uint256[] calldata ids) external onlyRole(ORACLE_ROLE) whenNotPaused {
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] >= _players.length) revert UnknownPlayer(ids[i]);
            Player storage p = _players[ids[i]];
            uint128 old = p.level;
            if (old == BASE_LEVEL) continue;
            uint256 scale = (navScaleOf(p.token) * old) / BASE_LEVEL;
            _navScale[p.token] = scale;
            p.level = BASE_LEVEL;
            tokenLevel[p.token] = BASE_LEVEL;
            emit SeasonCarried(ids[i], old, scale);
        }
        _beat();
        emit SeasonReset(ids.length);
    }

    function _beat() internal {
        lastHeartbeat = uint64(block.timestamp);
        emit Heartbeat(uint64(block.timestamp));
    }

    /// @dev Clears an active or scheduled halt. Orders can only have queued
    ///      while it was active; settling an empty queue is a no-op.
    function _resume(uint256 id) internal {
        PlayerToken tok = PlayerToken(payable(_players[id].token));
        if (haltFrom[address(tok)] == 0) return;
        haltFrom[address(tok)] = 0;
        emit Resumed(id);
        tok.settleQueue();
    }

    /// @dev Keep tokenLevel in sync and settle performance P&L. Returns
    ///      amounts funded / swept (0/0 when no supply exists).
    function _settle(uint256 id, uint128 oldLevel, uint128 newLevel) internal returns (uint256 funded, uint256 swept) {
        Player storage p = _players[id];
        PlayerToken tok = PlayerToken(payable(p.token));
        tokenLevel[p.token] = newLevel;
        uint256 s = tok.totalSupply();
        if (s == 0) return (0, 0);
        uint256 r = tok.reserveWad();
        uint256 rTarget = targetReserve(s, newLevel, navScaleOf(p.token));
        if (rTarget > r) {
            funded = rTarget - r;
            uint256 bal = poolBalance();
            if (funded > bal) funded = bal;
        } else {
            swept = r - rTarget;
        }
        tok.applyIndexLevel{value: funded}(oldLevel, newLevel, rTarget);
    }

    // ------------------------------ admin ------------------------------

    function setPlayerFees(uint256 id, uint16 buyBps, uint16 sellBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (buyBps > MAX_FEE_BPS || sellBps > MAX_FEE_BPS) revert();
        PlayerToken(payable(_players[id].token)).setFees(buyBps, sellBps);
    }

    /// @notice Pay accrued treasury revenue out to the treasury address.
    ///         Works while paused: it never touches the pool.
    function withdrawTreasury(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (amount > treasuryBalance) revert();
        treasuryBalance -= amount;
        (bool ok,) = treasury.call{value: amount}("");
        if (!ok) revert();
        emit TreasuryWithdrawn(treasury, amount);
    }

    function setTreasury(address treasury_, uint16 shareBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(treasury_ != address(0) && shareBps <= MAX_TREASURY_SHARE_BPS, "treasury");
        (treasury, treasuryShareBps) = (treasury_, shareBps);
        emit TreasuryUpdated(treasury_, shareBps);
    }

    /// @notice Fees for tokens registered from now on (existing tokens keep
    ///         theirs; change those with setPlayerFees).
    function setDefaultFees(uint16 buyBps, uint16 sellBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (buyBps > MAX_FEE_BPS || sellBps > MAX_FEE_BPS) revert();
        (defaultBuyFeeBps, defaultSellFeeBps) = (buyBps, sellBps);
        emit DefaultFeesUpdated(buyBps, sellBps);
    }

    function setMaxDeltaBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(bps >= 100 && bps <= 5_000, "range");
        maxDeltaBps = bps;
        emit ParamsUpdated(maxDeltaBps, minUpdateInterval);
    }

    function setHeartbeatMaxAge(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(seconds_ >= 5 minutes && seconds_ <= 7 days, "range");
        heartbeatMaxAge = seconds_;
        emit HeartbeatMaxAgeUpdated(seconds_);
    }

    function setMinUpdateInterval(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(seconds_ >= 10 minutes && seconds_ <= 7 days, "range");
        minUpdateInterval = seconds_;
        emit ParamsUpdated(maxDeltaBps, minUpdateInterval);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}

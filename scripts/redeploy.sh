#!/usr/bin/env bash
# Redeploy the Courtline contracts on Chiliz Spicy (88882) and re-register
# the player universe on the new core.
#
#   scripts/redeploy.sh                 # preflight only: checks, costs, plan (no transactions)
#   scripts/redeploy.sh --go            # run every step
#   scripts/redeploy.sh --go --from register   # resume from a step
#
# Steps: deploy -> open -> register -> halts -> ui -> pages
#   deploy    forge script Deploy; record the new core in oracle/state/deployments.json
#             (the old one is kept under "previous"); archive registry.json
#   open      first oracle transaction (a fresh core refuses trades until the
#             heartbeat) + seed the counterparty pool with POOL_CHZ
#   register  refresh matches, then deploy tokens for the universe (resumable:
#             re-running skips players already registered on the new core)
#   halts     post the current order of play
#   ui        point the UI, methodology page and README at the new addresses
#   pages     rebuild the GitHub Pages snapshot in docs/
#
# Env: POOL_CHZ (default 10), MIN_CHZ (default 110), PRIORITY_GWEI (default 200),
# RPC_URL, CHAIN_ID (default 88882),
# ENV_FILE (default contracts/.deploy/env: DEPLOYER_ADDRESS, DEPLOYER_PRIVATE_KEY).
# Testnet key only.
#
# The old core is left as is: holders can still sell old tokens at their last
# price (the old oracle stops pushing, so nothing moves the old pool).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:$HOME/.foundry/bin"
RPC_URL="${RPC_URL:-https://spicy-rpc.chiliz.com}"
POOL_CHZ="${POOL_CHZ:-10}"
MIN_CHZ="${MIN_CHZ:-110}"
CHAIN_ID="${CHAIN_ID:-88882}"
TIP="${PRIORITY_GWEI:-200}gwei" # Spicy: fixed 2,500 gwei base fee + a small tip
ENV_FILE="${ENV_FILE:-$ROOT/contracts/.deploy/env}"
STEPS=(deploy open register halts ui pages)
DEPLOYMENTS="$ROOT/oracle/state/deployments.json"

GO=0
FROM=deploy
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --from) FROM="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ " ${STEPS[*]} " == *" $FROM "* ]] || { echo "unknown step: $FROM (one of: ${STEPS[*]})" >&2; exit 2; }

say() { printf '\n== %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
json() { node -e "const d=require('$DEPLOYMENTS'); console.log($1)"; }

# ------------------------------- preflight -------------------------------
say "preflight"
command -v forge >/dev/null || die "Foundry not found (expected in ~/.foundry/bin)"
command -v cast >/dev/null || die "cast not found"
[ -f "$ENV_FILE" ] || die "$ENV_FILE missing (copy contracts/.deploy/env.example, fill in the testnet deployer)"
set -a; source "$ENV_FILE"; set +a
[ -n "${DEPLOYER_ADDRESS:-}" ] && [ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || die "DEPLOYER_ADDRESS / DEPLOYER_PRIVATE_KEY not set in contracts/.deploy/env"
# the oracle CLI and UI server read their own variables: keep them on this key and chain
export ORACLE_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" SPICY_RPC_URL="$RPC_URL" RPC_URL
[ "$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")" = "$(cast to-check-sum-address "$DEPLOYER_ADDRESS")" ] \
  || die "DEPLOYER_PRIVATE_KEY does not belong to DEPLOYER_ADDRESS"
CHAIN="$(cast chain-id --rpc-url "$RPC_URL")"
[ "$CHAIN" = "$CHAIN_ID" ] || die "RPC is chain $CHAIN, expected $CHAIN_ID"
BAL="$(cast balance --ether --rpc-url "$RPC_URL" "$DEPLOYER_ADDRESS")"
echo "deployer $DEPLOYER_ADDRESS  balance $BAL CHZ  (need ~$MIN_CHZ from step deploy: ~17 deploy, ~80 for ~200 tokens, $POOL_CHZ pool seed)"
echo "current core $(json d.core)"
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then echo "warning: uncommitted changes in the repo"; fi
(cd "$ROOT/contracts" && forge test >/dev/null) || die "contract tests fail"
(cd "$ROOT/oracle" && node --test test/*.mjs >/dev/null) || die "oracle tests fail"
echo "tests pass"

if [ "$GO" -ne 1 ]; then
  say "plan (nothing sent). Run with --go to execute: ${STEPS[*]}"
  exit 0
fi
if [ "$FROM" = deploy ] && node -e "process.exit(Number($BAL) < Number($MIN_CHZ) ? 0 : 1)"; then
  die "balance $BAL CHZ < MIN_CHZ $MIN_CHZ (set MIN_CHZ lower to accept a partial registration)"
fi

run=0
step() { [ "$1" = "$FROM" ] && run=1; [ "$run" -eq 1 ]; }

# --------------------------------- deploy --------------------------------
if step deploy; then
  say "deploy contracts"
  (cd "$ROOT/contracts" && ADMIN_ADDRESS="$DEPLOYER_ADDRESS" ORACLE_ADDRESS="$DEPLOYER_ADDRESS" PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
    forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --slow --priority-gas-price "$TIP")
  node -e '
    const fs = require("fs");
    const [run, file, deployer] = process.argv.slice(1);
    const b = JSON.parse(fs.readFileSync(run, "utf8"));
    const addr = (name) => b.transactions.find((t) => t.contractName === name && t.transactionType === "CREATE")?.contractAddress;
    const core = addr("TennisIndex"), impl = addr("PlayerToken");
    if (!core || !impl) throw new Error("addresses not found in " + run);
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    const previous = [...(d.previous ?? []), { core: d.core, playerTokenImplementation: d.playerTokenImplementation, deployedAt: d.deployedAt }];
    const next = { ...d, core, playerTokenImplementation: impl, deployer, deployedAt: new Date().toISOString().slice(0, 10), previous };
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    console.log("new core", core, "impl", impl);
  ' "$ROOT/contracts/broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json" "$DEPLOYMENTS" "$DEPLOYER_ADDRESS"
  OLD_CORE="$(json 'd.previous.at(-1).core')"
  REG="$ROOT/oracle/state/registry.json"
  cp "$REG" "$ROOT/oracle/state/registry-${OLD_CORE:0:10}.json"
  echo '{"byId":{}}' > "$REG"
  echo "old registry archived as registry-${OLD_CORE:0:10}.json"
fi

CORE="$(json d.core)"
send() { cast send --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" --priority-gas-price "$TIP" "$@" >/dev/null; }

# ---------------------------------- open ---------------------------------
if step open; then
  say "open the market on $CORE"
  send "$CORE" "heartbeat()" && echo "heartbeat sent (trading is closed until the oracle's first tx)"
  send "$CORE" "topUp()" --value "${POOL_CHZ}ether" && echo "pool seeded with $POOL_CHZ CHZ"
fi

# -------------------------------- register -------------------------------
if step register; then
  say "register players (resumable)"
  (cd "$ROOT/oracle" && node src/run.js backfill && node src/run.js register)
  echo "registered: $(node -e "console.log(Object.keys(require('$ROOT/oracle/state/registry.json').byId).length)") players"
fi

# --------------------------------- halts ---------------------------------
if step halts; then
  say "post the order of play"
  (cd "$ROOT/oracle" && node src/run.js halts)
fi

# ----------------------------------- ui ----------------------------------
if step ui; then
  say "point UI and docs at the new contracts"
  OLD_CORE="$(json 'd.previous.at(-1).core')"; OLD_IMPL="$(json 'd.previous.at(-1).playerTokenImplementation')"
  NEW_IMPL="$(json d.playerTokenImplementation)"
  node -e '
    const fs = require("fs");
    const [root, oc, oi, nc, ni] = process.argv.slice(1);
    for (const f of ["app/index.html", "app/market.html", "app/docs.html", "README.md"]) {
      const p = `${root}/${f}`;
      let s = fs.readFileSync(p, "utf8");
      const before = s;
      for (const [o, n] of [[oc, nc], [oi, ni]]) s = s.replace(new RegExp(o, "gi"), n.toLowerCase());
      if (s !== before) { fs.writeFileSync(p, s); console.log("updated", f); }
    }
  ' "$ROOT" "$OLD_CORE" "$OLD_IMPL" "$CORE" "$NEW_IMPL"
fi

# --------------------------------- pages ---------------------------------
if step pages; then
  say "rebuild the GitHub Pages snapshot"
  (cd "$ROOT/app" && PORT=8099 node server.js >/dev/null 2>&1) &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do curl -s -o /dev/null http://localhost:8099/ && break; sleep 0.2; done
  (cd "$ROOT" && STATS_URL=http://localhost:8099/api/stats node scripts/build-pages.mjs)
fi

say "done"
echo "core:     $CORE"
echo "next:     cd oracle && node src/run.js watch   (keeps heartbeats, halts and pushes going)"
echo "then:     review 'git status', commit, and push main to publish the Pages snapshot"

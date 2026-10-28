# AGENT.md — Binance Trading Simulator (PWA)

Minimalist live spot-trading simulator. Vanilla HTML/CSS/JS, no build step, no dependencies. All user data lives in `localStorage`; market data comes from Binance public endpoints. No real funds or API keys are involved.

## Files
| File | Role |
|---|---|
| `index.html` | Shell: header (balance, credit buttons, feed status), 4 pages (Trade, Assets, History, Analytics), coin picker dialog |
| `style.css` | Dark minimalist theme, CSS variables in `:root`, mobile-first |
| `app.js` | All logic (ledger, market data, chart, views, import/export) |
| `sw.js` | Service worker: network-first for same-origin files, cache fallback (offline shell). Bump `C` to invalidate cache |
| `manifest.json`, `icon.svg` | PWA install metadata |

Serve over HTTPS or `localhost` (service workers and `crypto.getRandomValues` need a secure context), e.g. `python3 -m http.server 8080`.

## Core principle: the ledger is the only state
`localStorage["bsim.tx.v1"]` holds a JSON array of transactions. Balances, positions, P&L and stats are **derived** by `derive(list)` replaying the ledger in order. Nothing else is persisted, so rollback and import are trivially consistent.

### Transaction record
```json
{ "id":"time-based UUIDv7", "action":"buy|sell|deposit|withdraw", "currency":"BTC",
  "amount":0.01, "amount_in_USDT":650.12, "fees":0.78, "timestamp":1761566400000,
  "price":65012.0, "slippage_usdt":0.41 }
```
- Required by spec: `id, action, currency, amount, amount_in_USDT, fees, timestamp`. Numbers are stored as JS numbers (not strings); `timestamp` is epoch ms and is **always Binance server time** (`GET /api/v3/time` → `serverTime`, fetched in parallel with the depth snapshot for trades, and on its own for deposits/withdrawals). The local clock (`Date.now()`) is never used; if the time call fails, the transaction is not recorded.
- Extensions: `deposit`/`withdraw` actions (currency `USDT`) record virtual credit so the ledger fully reproduces the balance; `price` (average fill) and `slippage_usdt` are informational on trades.
- `amount_in_USDT` = gross notional at the average fill price. `fees` = trading fee + gas (slippage is already inside the fill price, so it is **not** added again).
- `id` is UUIDv7-style: 48-bit prefix = the same Binance `timestamp` + random, so ids sort chronologically.

### Ledger math (average-cost)
- buy: `usdt -= amount_in_USDT + fees`; position `qty += amount`, `cost += amount_in_USDT + fees`
- sell: `usdt += amount_in_USDT - fees`; `pnl = amount_in_USDT - fees - (cost/qty)*amount`; cost and qty reduced proportionally
- deposit/withdraw: `usdt ± amount_in_USDT`

## Fees and slippage
- **Slippage**: on every trade (and live estimate) the app fetches `GET /api/v3/depth?symbol=XUSDT&limit=1000` and walks the book (asks for buys by USDT spend, bids for sells by quantity). Avg fill price vs mid price gives slippage. Insufficient depth rejects the trade.
- **Trading fee**: `CFG.feeRate = 0.001` (0.1% of notional, Binance standard spot rate, no BNB discount).
- **Gas**: network is always BNB (BSC). `gas = gasUnits (200000) × gasPriceGwei (3) × 1e-9 BNB`, converted to USDT using the live BNBUSDT price. Charged per trade. Tune in `CFG`.
- Buy validation requires `notional + fee + gas <= USDT balance`; "Max" button solves for this.

## Binance APIs
- WebSocket `wss://stream.binance.com:9443/stream` (single connection, SUBSCRIBE/UNSUBSCRIBE messages): `!miniTicker@arr` (all-market 1s prices → coin list, net worth, 24h change) and `<sym>usdt@kline_1s` (1-second candles for the selected coin). Auto-reconnects after 2 s; green/red dot in header shows status.
- REST: `/klines?interval=1s&limit=200` (chart history on coin switch), `/ticker/price` (instant price seed), `/depth` (fills), `/time` (transaction timestamps).

## Features → code map
- Credit: `credit()`; header buttons add/remove virtual USDT (cannot remove more than balance).
- Chart: `draw()` — hand-rolled canvas candlesticks, last ~N candles fitting the width, right-side price axis.
- Coin selector: `#picker` dialog, `renderPicker()`, search filters all `*USDT` pairs seen on the ticker, sorted by quote volume.
- History: `renderHistory()`, `download()` (JSON `{version, exported_at, transactions:[{transaction:{…}}]}`), `importFile()` (accepts that format, a bare array, or unwrapped records; validates fields and non-negative USDT replay; **overwrites** history after confirmation), `rollback(ts)` (deletes every transaction with `timestamp > ts`, keeping the chosen one, after confirmation).
- Analytics (`renderAnalytics()`, live-updated each ticker tick):
  - net worth = USDT + Σ(qty × live price)
  - total gains = Σ positive realized sell P&L (fees included); total loss = Σ |negative realized sell P&L|
  - liquid assets = USDT balance; holdings = qty per coin (+ USDT value)
  - success rate = profitable sells ÷ all sells
  - Liquidation = selling to USDT via the normal sell flow (Max button).
- Assets (`renderAssets()`): one card per open position, sorted by USDT value — qty, avg cost (`cost/qty`), live price, value, share of net worth, and unrealized P&L **net of exit fees** (`value×(1−feeRate) − gas − cost`). Tapping a card selects that symbol and opens Trade. Live-updated while the page is visible, like Analytics.
- Missed opportunities (`renderMissed()`, `buildMissed()`, `updateMissed()`): horizontal swipe shelf of `#missed` cards, one per open position. Window = **since that asset's last buy**. Fetches `/klines` starting at that timestamp, using the smallest interval whose 1000 candles cover the span (`IVS` ladder: 1s → 1m → 5m → 15m → 1h → 4h → 1d → 1w → 1M). Each candle's **high** is treated as the best price you could have sold at, so the line is net realizable USDT `qty×high×(1−feeRate) − gas` — i.e. profit after fee and gas. The max point is the peak (green dot), the dashed line is "net if sold now", and `missed = max(0, peak − now)`. `MC` caches series per `symbol|lastBuy`; empty results are not cached. Re-render is guarded by a signature (`symbol:lastBuy:qty`) so ticker ticks only patch the live numbers/dashed line (`updateMissed`) and never rebuild the DOM or reset the swipe position. Refresh button forces a refetch.

## Conventions for agents
- Keep it dependency-free and single-purpose; never store derived values — add them to `derive()`.
- Any new transaction type must be handled in `derive()` and the import validator.
- Chart/WS code must ignore messages for non-selected symbols (`kline()` guards this).
- Limitations: no limit orders, no lot-size/min-notional rules, fills use a depth snapshot at click time, average-cost (not FIFO) accounting, quote asset is USDT only.

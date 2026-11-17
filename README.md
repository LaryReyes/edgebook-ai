# Edgebook AI — local MT5 trading journal

Made by [Lary Reyes](https://github.com/LaryReyes). MIT License (see `LICENSE`).

A self-hosted trading journal that runs on your own PC and pulls trades straight
from your MetaTrader 5 terminal. Everything stays on your machine in
`data/journal.db`; the web server only listens on `127.0.0.1`, so other devices
cannot open it. It only **reads** from MT5: it never places, changes or closes a trade.

## What's in it

- **Auto-sync from MT5** — attaches to the terminal you're already logged in to
  (no password stored). Groups MT5 deals into trades by position, including
  partial closes, and keeps deposits/withdrawals separate. Re-syncs every 60 s.
- **Dashboard** — net P&L, trade & day win %, profit factor, avg win/loss,
  expectancy, R-multiples, an edge score, cumulative P&L, daily P&L, P&L
  calendar with weekly totals, recent trades and live open positions.
- **Daily journal** — every trading day with its stats, intraday curve, trades,
  pre-market plan, end-of-day review and mood.
- **Trade view** — candle chart from MT5 with entry/exit/SL/TP marked, MAE/MFE,
  risk & R, playbook rule checklist, setup/mistake/custom tags, 1–5 rating,
  notes, screenshots (drag-drop or Ctrl+V), reviewed flag, prev/next.
- **Reports** — overview of every stat, drawdown chart, and breakdowns by
  symbol, side, weekday, hour, session (Asia/London/NY), month, hold time,
  size, R-multiple, setup/mistake/custom tags, playbook, exit reason, rating.
  Plus a **Compare** tab (e.g. long vs short, tag A vs everything).
- **Playbooks** — your setups with grouped rules; per-playbook stats and a
  "followed vs broken" table for every rule.
- **Risk rules** — daily loss limit, max drawdown, profit target, max trades
  per day, with dashboard warnings (useful for prop-firm challenges).
- **AI Review (optional)** — asks a local AI (Ollama on this PC) or an
  OpenAI-compatible router on this PC (OmniRoute, `localhost:20128`) to review a
  period. It sends only trade fields in R (no account number, balance, dollar
  amounts, lot sizes, prices, notes or screenshots) and shows you the exact text
  before sending. Put an OmniRoute key in `data/omniroute_key.txt` (never commit it).
- **Weekly / monthly review** — the period next to the one before, rule breaks,
  discipline by stage, a reflection note per period.
- **Multiple accounts** — log in to another account in MT5, press Sync, and
  it's added. Filter by account and date range everywhere. CSV export.

## Setup (Windows)

1. Install **Python 3.10+** from python.org (tick *Add python.exe to PATH*).
2. Install and open **MetaTrader 5**, log in to your account.
3. In MT5: **Tools → Options → Expert Advisors → tick "Allow algorithmic trading"**.
4. Double-click **`start.bat`**. The first run installs Flask and the
   `MetaTrader5` package into a local `.venv`, then opens
   <http://127.0.0.1:5050> in your browser.
5. Go to **Settings**, add your MT5 login under **Allowed MT5 accounts** (any
   other account is refused), set **Show times in** to your time zone, set your broker's **server time offset** (most are
   UTC+2 in winter / UTC+3 in summer — check the clock in MT5's Market Watch),
   then press **↻ Sync**.

To try it with sample data first: `start.bat --demo` (adds account 999999,
which you can remove in Settings → Accounts).

Manual alternative to `start.bat`:

```
pip install -r requirements.txt
python app.py            # --port 5050  --demo  --no-browser
```

## Notes

- The first sync with MAE/MFE enabled downloads M1 candles for each trade, so it
  can take a minute on a big history (it does up to 400 trades per sync and
  finishes the rest on later syncs). Turn it off in Settings if you don't need it.
- Risk ($) and MAE/MFE are converted with **current** exchange rates via
  `order_calc_profit`, so cross-currency values are close but not exact.
  You can override risk per trade.
- Initial SL comes from the opening order. If you placed the stop after entry,
  MT5 doesn't record it — enter the risk manually on that trade for an R value.
- Charts use Chart.js and TradingView Lightweight Charts from a CDN, so the
  browser needs internet for charts. Everything else works offline.
- Only one MT5 terminal is read at a time. If you have several installed, set
  the terminal path in Settings.
- Backup = copy the `data` folder. It holds your trades and keys, so never
  upload it (`.gitignore` keeps it out of Git).

## Credits

- Built by [Lary Reyes](https://github.com/LaryReyes).
- The Lary Reyes logo (`static/lary-reyes-logo.png`) is a personal mark. It is **not** covered by the MIT license: do not reuse it outside this project; replace it in your own copies.
- Candle charts: [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/)
  (Apache 2.0), © TradingView, Inc.
- Other charts: [Chart.js](https://www.chartjs.org/) (MIT). Python: Flask and the
  `MetaTrader5` package.
- Not financial advice. Use at your own risk.

## Files

| File | Purpose |
|---|---|
| `app.py` | Flask server and API, background auto-sync |
| `mt5_sync.py` | MT5 connection, deal → trade grouping, charts, open positions |
| `stats.py` | All metrics and report groupings |
| `db.py` | SQLite schema and settings |
| `ai_review.py` | AI Review: builds the private-safe summary, asks Ollama or OmniRoute |
| `demo.py` | Sample data generator |
| `static/` | The web interface |

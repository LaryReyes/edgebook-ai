"""Pulls closed trades from a running MetaTrader 5 terminal.

Uses the official `MetaTrader5` Python package (Windows only). It attaches to the
terminal that is already open and logged in, so no password is ever stored here.
MT5 records *deals* (fills); this module groups them by position ID into trades.
"""
import subprocess
import threading
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

try:
    import MetaTrader5 as mt5
except ImportError:  # not installed / not Windows
    mt5 = None

LOCK = threading.Lock()  # the MT5 library is not thread-safe

ENTRY_IN, ENTRY_OUT, ENTRY_INOUT, ENTRY_OUT_BY = 0, 1, 2, 3
DEAL_BUY, DEAL_SELL = 0, 1
CASHFLOW_TYPES = {2: "balance", 3: "credit", 4: "charge", 5: "correction", 6: "bonus"}
REASONS = {0: "manual", 1: "mobile", 2: "web", 3: "expert", 4: "stop loss", 5: "take profit",
           6: "stop out", 7: "rollover", 8: "var margin", 9: "split"}


class SyncError(Exception):
    pass


def available():
    return mt5 is not None


def _utc(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc)


# ---------------------------------------------------------------- time zones
# MT5 stamps everything in the broker's server clock. The journal stores and shows times
# on the display clock (set in Settings), so every report reads in local time.
def _us_dst(utc_ts):
    y = datetime.fromtimestamp(utc_ts, tz=timezone.utc).year
    march, nov = datetime(y, 3, 8, 7, tzinfo=timezone.utc), datetime(y, 11, 1, 6, tzinfo=timezone.utc)
    start = march + timedelta(days=(6 - march.weekday()) % 7)  # 2nd Sunday of March, 2 AM New York
    end = nov + timedelta(days=(6 - nov.weekday()) % 7)        # 1st Sunday of November, 2 AM New York
    return start.timestamp() <= utc_ts < end.timestamp()


def _shift(std, settings, utc_ts):
    return std + (1 if settings.get("server_dst", "us") == "us" and _us_dst(utc_ts) else 0)


def to_local(server_ts, std, settings):
    utc = server_ts - _shift(std, settings, server_ts - std * 3600) * 3600
    return int(utc + float(settings.get("display_utc_offset") or 0) * 3600)


def to_server(local_ts, std, settings):
    utc = local_ts - float(settings.get("display_utc_offset") or 0) * 3600
    return int(utc + _shift(std, settings, utc) * 3600)


def _detect_std_offset(symbols, settings):
    """Winter offset of the broker clock, from a live tick. None when the market is closed."""
    for symbol in symbols:
        mt5.symbol_select(symbol, True)
        tick = mt5.symbol_info_tick(symbol)
        if not tick or not tick.time:
            continue
        now = time.time()
        diff = tick.time - now
        hours = round(diff / 3600)
        if abs(diff - hours * 3600) <= 300:  # tick is fresh: the gap is the clock offset
            return hours - _shift(0, settings, now)
    return None


def _terminal_running(path):
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", "(Get-Process terminal64 -ErrorAction SilentlyContinue).Path"],
        capture_output=True, text=True).stdout
    running = [line.strip().lower() for line in out.splitlines() if line.strip()]
    return path.lower() in running if path else bool(running)


def _ensure(settings):
    if mt5 is None:
        raise SyncError("The MetaTrader5 Python package isn't installed (pip install MetaTrader5). "
                        "It only works on Windows.")
    if mt5.terminal_info() is None:
        path = (settings.get("terminal_path") or "").strip()
        if not _terminal_running(path):  # initialize() would launch MT5 by itself
            raise SyncError("MT5 is not open. Open your MetaTrader 5 terminal and log in.")
        ok = mt5.initialize(path=path) if path else mt5.initialize()
        if not ok:
            raise SyncError(f"Couldn't connect to MT5 ({mt5.last_error()}). "
                            "Make sure the terminal is open and logged in.")
    acc = mt5.account_info()
    allowed = [x.strip() for x in str(settings.get("allowed_accounts") or "").split(",") if x.strip()]
    if acc is not None and not allowed:
        mt5.shutdown()
        raise SyncError(f"No MT5 account is allowed yet. Add your account number ({acc.login}) in Settings > Allowed MT5 accounts, then Sync.")
    if acc is not None and str(acc.login) not in allowed:
        mt5.shutdown()
        raise SyncError(f"MT5 is on account {acc.login}, which is not in your allowed accounts. Nothing was imported.")


def status(settings):
    if mt5 is None:
        return {"connected": False, "reason": "MetaTrader5 package not installed"}
    with LOCK:
        try:
            _ensure(settings)
        except SyncError as e:
            return {"connected": False, "reason": str(e)}
        acc = mt5.account_info()
        term = mt5.terminal_info()
        return {
            "connected": acc is not None,
            "login": acc.login if acc else None,
            "server": acc.server if acc else None,
            "terminal_connected": bool(term and term.connected),
        }


def _profit_at(direction, symbol, volume, entry, price):
    """$ result of moving from entry to price, in account currency (current rates)."""
    order_type = mt5.ORDER_TYPE_BUY if direction == "long" else mt5.ORDER_TYPE_SELL
    try:
        v = mt5.order_calc_profit(order_type, symbol, volume, entry, price)
    except Exception:
        v = None
    return v


def _excursions(t):
    """MAE / MFE in $ from the ticks between open and close (M1 bars are too coarse for scalps)."""
    dur = t["close_time"] - t["open_time"]
    if dur <= 0 or dur > 2 * 86400:
        return None, None
    mt5.symbol_select(t["symbol"], True)
    ticks = mt5.copy_ticks_range(t["symbol"], _utc(t["open_time"]), _utc(t["close_time"] + 1), mt5.COPY_TICKS_ALL)
    if ticks is None or len(ticks) == 0:
        return None, None
    side = "bid" if t["direction"] == "long" else "ask"  # the price the position would close at
    prices = [float(x[side]) for x in ticks if x[side] > 0]
    if not prices:
        return None, None
    hi, lo = max(prices), min(prices)
    if t["direction"] == "long":
        best, worst = hi, lo
    else:
        best, worst = lo, hi
    mfe = _profit_at(t["direction"], t["symbol"], t["volume"], t["entry_price"], best)
    mae = _profit_at(t["direction"], t["symbol"], t["volume"], t["entry_price"], worst)
    return (min(mae, 0.0) if mae is not None else None,
            max(mfe, 0.0) if mfe is not None else None)


def _build_trades(deals, orders_by_pos):
    by_pos = defaultdict(list)
    for d in deals:
        if d.type in (DEAL_BUY, DEAL_SELL) and d.position_id:
            by_pos[d.position_id].append(d)

    trades = []
    for pid, ds in by_pos.items():
        ds.sort(key=lambda d: (d.time_msc, d.ticket))
        ins = [d for d in ds if d.entry == ENTRY_IN]
        outs = [d for d in ds if d.entry in (ENTRY_OUT, ENTRY_OUT_BY, ENTRY_INOUT)]
        if not ins or not outs:
            continue
        in_vol = sum(d.volume for d in ins)
        out_vol = sum(d.volume for d in outs)
        if out_vol + 1e-9 < in_vol:
            continue  # still partially open
        direction = "long" if ins[0].type == DEAL_BUY else "short"
        entry = sum(d.price * d.volume for d in ins) / in_vol
        exit_ = sum(d.price * d.volume for d in outs) / out_vol
        profit = sum(d.profit for d in ds)
        commission = sum(d.commission for d in ds)
        swap = sum(d.swap for d in ds)
        fee = sum(getattr(d, "fee", 0.0) for d in ds)

        sl = tp = 0.0
        orders = sorted(orders_by_pos.get(pid, []), key=lambda o: o.time_setup_msc)
        for o in orders:
            if o.sl and not sl:
                sl = o.sl
            if o.tp and not tp:
                tp = o.tp
        last = outs[-1]
        moved_sl = "Unknown"  # the final stop is only known when the stop closed the trade
        closing = next((o for o in orders if o.ticket == last.order), None)
        if last.reason == 4 and sl and closing:
            point = mt5.symbol_info(ins[0].symbol).point
            change = closing.price_open - sl if direction == "long" else sl - closing.price_open
            moved_sl = "No" if abs(change) <= 2 * point else ("Toward profit" if change > 0 else "AGAINST")
        # Deals in newer builds carry SL/TP; use them as fallback
        if not sl:
            sl = getattr(ins[0], "sl", 0.0) or 0.0
        if not tp:
            tp = getattr(ins[0], "tp", 0.0) or 0.0
        if not sl and last.reason == 4:  # closed by SL, but no initial SL recorded
            sl = last.price

        trades.append({
            "position_id": pid,
            "symbol": ins[0].symbol,
            "direction": direction,
            "volume": round(in_vol, 4),
            "open_time": int(ins[0].time),
            "close_time": int(last.time),
            "entry_price": entry,
            "exit_price": exit_,
            "sl": sl or None,
            "tp": tp or None,
            "profit": profit,
            "commission": commission,
            "swap": swap,
            "fee": fee,
            "net": profit + commission + swap + fee,
            "exit_reason": REASONS.get(last.reason, str(last.reason)),
            "moved_sl": moved_sl,
            "magic": ins[0].magic,
            "comment": ins[0].comment,
        })
    return trades


def _sync_setups(conn, account, orders, local):
    """Record pending, open, filled and cancelled orders. Notes and charts are never touched."""
    names = {0: "market", 1: "market", 2: "limit", 3: "limit", 4: "stop", 5: "stop", 6: "stop limit", 7: "stop limit"}
    open_ids = {p.ticket for p in (mt5.positions_get() or ())}
    gone = (mt5.ORDER_STATE_CANCELED, mt5.ORDER_STATE_EXPIRED, mt5.ORDER_STATE_REJECTED)
    rows = []
    for o in orders:
        if o.state == mt5.ORDER_STATE_FILLED and o.position_id == o.ticket:
            rows.append((o, "open" if o.ticket in open_ids else "filled"))
        elif o.state in gone and not o.position_id:
            rows.append((o, "cancelled"))
    rows += [(o, "pending") for o in (mt5.orders_get() or ())]
    for o, status in rows:
        conn.execute(
            """INSERT INTO setups(ticket, account, symbol, direction, order_type, volume, price, sl, tp,
                   placed_time, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(ticket) DO UPDATE SET symbol=excluded.symbol, direction=excluded.direction,
                   order_type=excluded.order_type, volume=excluded.volume, price=excluded.price,
                   sl=excluded.sl, tp=excluded.tp, placed_time=excluded.placed_time, status=excluded.status""",
            (o.ticket, account, o.symbol, "long" if o.type % 2 == 0 else "short", names.get(o.type, str(o.type)),
             o.volume_initial, o.price_open, o.sl or None, o.tp or None, local(int(o.time_setup)), status))


def sync(conn, settings, progress=None):
    """Full history sync for the logged-in account. Returns a summary dict."""
    started = time.time()
    with LOCK:
        _ensure(settings)
        acc = mt5.account_info()
        if acc is None:
            raise SyncError(f"No account is logged in to MT5 ({mt5.last_error()}).")

        try:
            start = datetime.strptime(settings.get("history_start") or "2015-01-01", "%Y-%m-%d")
        except ValueError:
            start = datetime(2015, 1, 1)
        start = start.replace(tzinfo=timezone.utc)
        end = datetime.now(timezone.utc) + timedelta(days=2)  # server clock is usually ahead

        deals = mt5.history_deals_get(start, end)
        if deals is None:
            raise SyncError(f"history_deals_get failed: {mt5.last_error()}")
        orders = mt5.history_orders_get(start, end) or []
        orders_by_pos = defaultdict(list)
        for o in orders:
            orders_by_pos[o.position_id].append(o)

        trades = _build_trades(deals, orders_by_pos)

        known = conn.execute("SELECT utc_offset FROM accounts WHERE login=?", (acc.login,)).fetchone()
        symbols = list(dict.fromkeys(["XAUUSD"] + [d.symbol for d in reversed(deals) if d.symbol]))[:5]
        std = _detect_std_offset(symbols, settings)
        if std is None:
            std = known["utc_offset"] if known and known["utc_offset"] is not None else float(settings.get("server_utc_offset") or 0)
        conn.execute(
            "INSERT INTO accounts(login, name, server, broker, currency, leverage, balance, equity, last_sync, utc_offset) "
            "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(login) DO UPDATE SET name=excluded.name, "
            "server=excluded.server, broker=excluded.broker, currency=excluded.currency, "
            "leverage=excluded.leverage, balance=excluded.balance, equity=excluded.equity, "
            "last_sync=excluded.last_sync, utc_offset=excluded.utc_offset",
            (acc.login, acc.name, acc.server, acc.company, acc.currency, acc.leverage,
             acc.balance, acc.equity, int(time.time()), std))
        conn.execute("INSERT INTO settings(key, value) VALUES ('server_utc_offset', ?) "
                     "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(std),))
        local = lambda ts: to_local(ts, std, settings)

        existing = {r["position_id"]: r for r in conn.execute(
            "SELECT position_id, risk, mae, mfe FROM trades WHERE account=?", (acc.login,))}

        new_count = 0
        excursion_budget = 400 if settings.get("compute_excursions", True) else 0
        for t in trades:
            prev = existing.get(t["position_id"])
            if prev is None:
                new_count += 1
            risk = prev["risk"] if prev and prev["risk"] is not None else None
            if risk is None and t["sl"]:
                loss = _profit_at(t["direction"], t["symbol"], t["volume"], t["entry_price"], t["sl"])
                if loss is not None and loss < 0:
                    risk = -loss
            mae = prev["mae"] if prev else None
            mfe = prev["mfe"] if prev else None
            if (mae is None or mfe is None) and excursion_budget > 0:
                excursion_budget -= 1
                try:
                    mae, mfe = _excursions(t)
                except Exception:
                    mae = mfe = None
            conn.execute(
                """INSERT INTO trades(account, position_id, symbol, direction, volume, open_time, close_time,
                       entry_price, exit_price, sl, tp, profit, commission, swap, fee, net, risk, mae, mfe,
                       exit_reason, moved_sl, magic, comment)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(account, position_id) DO UPDATE SET
                       symbol=excluded.symbol, direction=excluded.direction, volume=excluded.volume,
                       open_time=excluded.open_time, close_time=excluded.close_time,
                       entry_price=excluded.entry_price, exit_price=excluded.exit_price,
                       sl=excluded.sl, tp=excluded.tp, profit=excluded.profit,
                       commission=excluded.commission, swap=excluded.swap, fee=excluded.fee,
                       net=excluded.net, risk=excluded.risk, mae=excluded.mae, mfe=excluded.mfe,
                       exit_reason=excluded.exit_reason, moved_sl=excluded.moved_sl,
                       magic=excluded.magic, comment=excluded.comment""",
                (acc.login, t["position_id"], t["symbol"], t["direction"], t["volume"], local(t["open_time"]),
                 local(t["close_time"]), t["entry_price"], t["exit_price"], t["sl"], t["tp"], t["profit"],
                 t["commission"], t["swap"], t["fee"], t["net"], risk, mae, mfe, t["exit_reason"],
                 t["moved_sl"], t["magic"], t["comment"]))

        _sync_setups(conn, acc.login, orders, local)

        for d in deals:
            if d.type in CASHFLOW_TYPES:
                conn.execute(
                    "INSERT INTO cashflow(account, ticket, time, amount, kind, comment) VALUES (?,?,?,?,?,?) "
                    "ON CONFLICT(account, ticket) DO UPDATE SET time=excluded.time",
                    (acc.login, d.ticket, local(int(d.time)), d.profit, CASHFLOW_TYPES[d.type], d.comment))
        conn.commit()

    return {"account": acc.login, "trades": len(trades), "new": new_count,
            "seconds": round(time.time() - started, 2)}


def open_positions(settings):
    if mt5 is None:
        return []
    with LOCK:
        try:
            _ensure(settings)
        except SyncError:
            return []
        out = []
        for p in mt5.positions_get() or []:
            out.append({
                "ticket": p.ticket, "symbol": p.symbol,
                "direction": "long" if p.type == 0 else "short",
                "volume": p.volume, "entry_price": p.price_open,
                "open_time": to_local(int(p.time), float(settings.get("server_utc_offset") or 0), settings),
                "price": p.price_current, "sl": p.sl or None, "tp": p.tp or None,
                "profit": p.profit, "swap": p.swap,
            })
        return out


TIMEFRAMES = [  # (max trade duration seconds, tf name, tf seconds)
    (2 * 3600, "M1", 60),
    (10 * 3600, "M5", 300),
    (2 * 86400, "M15", 900),
    (8 * 86400, "H1", 3600),
    (10 ** 12, "H4", 14400),
    (10 ** 13, "D1", 86400),  # only when picked by hand
]


def trade_chart(settings, symbol, open_time, close_time, tf=None, std=0.0):
    """open_time / close_time are display-clock times; candles come back on the same clock."""
    if mt5 is None:
        raise SyncError("MT5 isn't available, so there are no candles to draw.")
    dur = max(close_time - open_time, 60)
    choice = None
    if tf:
        choice = next((x for x in TIMEFRAMES if x[1] == tf), None)
    if choice is None:
        choice = next(x for x in TIMEFRAMES if dur <= x[0])
    _, name, sec = choice
    pad = max(int(dur * 0.8), 60 * sec)
    with LOCK:
        _ensure(settings)
        mt5.symbol_select(symbol, True)
        rates = mt5.copy_rates_range(symbol, getattr(mt5, f"TIMEFRAME_{name}"),
                                     _utc(to_server(open_time, std, settings) - pad),
                                     _utc(to_server(close_time, std, settings) + pad))
        if rates is None or len(rates) == 0:
            raise SyncError(f"No {name} history for {symbol} in that range ({mt5.last_error()}).")
        info = mt5.symbol_info(symbol)
    candles = [{"time": to_local(int(r["time"]), std, settings), "open": float(r["open"]), "high": float(r["high"]),
                "low": float(r["low"]), "close": float(r["close"])} for r in rates]
    return {"timeframe": name, "digits": info.digits if info else 5, "candles": candles}

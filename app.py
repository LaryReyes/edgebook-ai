"""Edgebook — a local trading journal for MetaTrader 5.

Run:  python app.py            (then open http://127.0.0.1:5050)
      python app.py --demo     (adds a demo account with sample trades)
"""
import argparse
import calendar
import json
import os
import threading
import time
import uuid
import webbrowser
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, request, send_from_directory, abort

import ai_review
import db
import mt5_sync
import stats

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 25 * 1024 * 1024
app.json.sort_keys = False  # keep report order

SYNC_STATE = {"running": False, "last": None, "error": None, "last_result": None}
SYNC_GUARD = threading.Lock()
ALLOWED_IMG = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


# ---------------------------------------------------------------- helpers
def conn():
    return db.connect()


def to_ts(date_str, end=False):
    d = datetime.strptime(date_str, "%Y-%m-%d")
    if end:
        d += timedelta(days=1)
    return calendar.timegm(d.timetuple())


def filters_from(args):
    f = {}
    for k in ("account", "playbook", "tag"):
        v = args.get(k)
        if v not in (None, "", "all"):
            f[k] = int(v)
    for k in ("from", "to", "symbol", "direction", "result"):
        v = args.get(k)
        if v not in (None, "", "all"):
            f[k] = v
    return f


def tilt_flags(c):
    s = db.get_settings(c)
    trades = [dict(r) for r in c.execute(
        "SELECT id, account, open_time, close_time, net, risk, manual_risk, moved_sl, playbook_id, rules_followed "
        "FROM trades")]
    mistakes = {}
    for r in c.execute("SELECT x.trade_id, g.name FROM trade_tags x JOIN tags g ON g.id = x.tag_id "
                       "WHERE g.kind = 'mistake' ORDER BY g.name"):
        mistakes.setdefault(r[0], []).append(r[1])
    rules = {r["id"]: stats.required(json.loads(r["rules"] or "[]")) for r in c.execute("SELECT id, rules FROM playbooks")}
    balances = {r["login"]: r["balance"] for r in c.execute("SELECT login, balance FROM accounts")}
    flags = stats.tilt_flags(trades, float(s.get("be_zone_r") or 0), float(s.get("risk_per_trade_pct") or 0),
                             int(s.get("max_trades_per_day") or 0), mistakes, rules, balances)
    for t in trades:
        if not graded(s, t["open_time"]):
            flags.pop(t["id"], None)
    return flags


def graded(s, open_time):
    """False for trades opened before the 'grade discipline from' day."""
    start = s.get("discipline_start")
    return not start or stats.day_of(open_time) >= start  # stored times are already in the display clock


def load_trades(c, f=None, order="ASC"):
    f = f or {}
    sql = ["SELECT t.*, p.name AS playbook_name, p.color AS playbook_color FROM trades t "
           "LEFT JOIN playbooks p ON p.id = t.playbook_id WHERE 1=1"]
    params = []
    if "account" in f:
        sql.append("AND t.account = ?"); params.append(f["account"])
    if "from" in f:
        sql.append("AND t.close_time >= ?"); params.append(to_ts(f["from"]))
    if "to" in f:
        sql.append("AND t.close_time < ?"); params.append(to_ts(f["to"], end=True))
    if "symbol" in f:
        sql.append("AND t.symbol = ?"); params.append(f["symbol"])
    if "direction" in f:
        sql.append("AND t.direction = ?"); params.append(f["direction"])
    if "playbook" in f:
        sql.append("AND t.playbook_id = ?"); params.append(f["playbook"])
    if "tag" in f:
        sql.append("AND EXISTS (SELECT 1 FROM trade_tags x WHERE x.trade_id = t.id AND x.tag_id = ?)")
        params.append(f["tag"])
    sql.append(f"ORDER BY t.close_time {order}, t.id {order}")
    rows = [dict(r) for r in c.execute(" ".join(sql), params)]
    s = db.get_settings(c)
    zone = float(s.get("be_zone_r") or 0)
    tilt = tilt_flags(c)
    for r in rows:
        r["graded"] = graded(s, r["open_time"])
        r["outcome"] = stats.outcome(r, zone)
        r["tilt"] = tilt.get(r["id"], [])
    wanted = {"win": 1, "loss": -1, "be": 0}.get(f.get("result"))
    if wanted is not None:
        rows = [r for r in rows if r["outcome"] == wanted]
    if rows:
        ids = [r["id"] for r in rows]
        tags = {}
        for i in range(0, len(ids), 900):
            chunk = ids[i:i + 900]
            q = ("SELECT x.trade_id, g.id, g.name, g.kind FROM trade_tags x JOIN tags g ON g.id = x.tag_id "
                 f"WHERE x.trade_id IN ({','.join('?' * len(chunk))}) ORDER BY g.kind, g.name")
            for r in c.execute(q, chunk):
                tags.setdefault(r["trade_id"], []).append({"id": r["id"], "name": r["name"], "kind": r["kind"]})
        n_rules = {p["id"]: stats.required(json.loads(p["rules"] or "[]")) for p in c.execute("SELECT id, rules FROM playbooks")}
        for r in rows:
            r["tags"] = tags.get(r["id"], [])
            r["r"] = stats.r_multiple(r)
            r["rules_followed"] = json.loads(r["rules_followed"] or "[]")
            r["process_rules"], r["process_behaviour"] = (
                stats.process_parts(r, n_rules.get(r["playbook_id"])) if r["graded"] else (None, None))
    return rows


def err(msg, code=400):
    return jsonify({"error": msg}), code


# ---------------------------------------------------------------- sync
def run_sync():
    if not SYNC_GUARD.acquire(blocking=False):
        return {"skipped": "sync already running"}
    SYNC_STATE["running"] = True
    try:
        c = conn()
        try:
            res = mt5_sync.sync(c, db.get_settings(c))
        finally:
            c.close()
        SYNC_STATE.update(last=int(time.time()), error=None, last_result=res)
        return res
    except mt5_sync.SyncError as e:
        SYNC_STATE.update(error=str(e))
        raise
    except Exception as e:  # keep the loop alive
        SYNC_STATE.update(error=f"{type(e).__name__}: {e}")
        raise
    finally:
        SYNC_STATE["running"] = False
        SYNC_GUARD.release()


def auto_sync_loop():
    time.sleep(3)
    while True:
        c = conn()
        s = db.get_settings(c)
        c.close()
        interval = max(int(s.get("sync_interval") or 60), 15)
        if s.get("auto_sync") and mt5_sync.available():
            try:
                run_sync()
            except Exception:
                pass
        time.sleep(interval)


# ---------------------------------------------------------------- pages
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/uploads/<path:name>")
def uploads(name):
    return send_from_directory(db.UPLOAD_DIR, name)


# ---------------------------------------------------------------- status / sync
@app.get("/api/status")
def api_status():
    c = conn()
    s = db.get_settings(c)
    accounts = [dict(r) for r in c.execute("SELECT * FROM accounts ORDER BY login")]
    c.close()
    return jsonify({
        "mt5_package": mt5_sync.available(),
        "sync": SYNC_STATE,
        "accounts": accounts,
        "settings": s,
    })


@app.get("/api/mt5")
def api_mt5():
    c = conn()
    s = db.get_settings(c)
    c.close()
    return jsonify(mt5_sync.status(s))


@app.post("/api/sync")
def api_sync():
    try:
        return jsonify(run_sync())
    except mt5_sync.SyncError as e:
        return err(str(e), 503)
    except Exception as e:
        return err(f"Sync failed: {e}", 500)


@app.get("/api/positions")
def api_positions():
    c = conn()
    s = db.get_settings(c)
    c.close()
    return jsonify(mt5_sync.open_positions(s))


# ---------------------------------------------------------------- dashboard
@app.get("/api/dashboard")
def api_dashboard():
    f = filters_from(request.args)
    c = conn()
    s = db.get_settings(c)
    trades = load_trades(c, f)
    summary = stats.summarize(trades)
    recent = list(reversed(trades[-12:]))

    # risk-rule status for "today" (server date) — unaffected by the date filter
    today = datetime.now(timezone.utc) + timedelta(hours=float(s.get("display_utc_offset") or 0))
    today_str = today.strftime("%Y-%m-%d")
    tf = {k: v for k, v in f.items() if k == "account"}
    tf.update({"from": today_str, "to": today_str})
    today_trades = load_trades(c, tf)
    all_trades = load_trades(c, {k: v for k, v in f.items() if k == "account"})
    all_sum = stats.summarize(all_trades)
    cur_dd = 0.0
    if all_trades:
        curve = stats.equity_curve(all_trades)
        peak = max([0.0] + [p["value"] for p in curve])
        cur_dd = peak - curve[-1]["value"]
    cash_sql = "SELECT COALESCE(SUM(amount),0) FROM cashflow" + (" WHERE account=?" if "account" in f else "")
    deposits = c.execute(cash_sql, (f["account"],) if "account" in f else ()).fetchone()[0]
    c.close()

    return jsonify({
        "summary": summary,
        "equity": stats.equity_curve(trades),
        "daily": stats.daily(trades),
        "recent": recent,
        "rules": {
            "today": today_str,
            "today_net": sum(t["net"] for t in today_trades),
            "today_trades": len(today_trades),
            "daily_loss_limit": s.get("daily_loss_limit") or 0,
            "max_drawdown_limit": s.get("max_drawdown_limit") or 0,
            "profit_target": s.get("profit_target") or 0,
            "max_trades_per_day": s.get("max_trades_per_day") or 0,
            "current_drawdown": cur_dd,
            "total_net": all_sum["net"],
            "deposits": deposits,
        },
    })


@app.get("/api/calendar")
def api_calendar():
    month = request.args.get("month") or datetime.utcnow().strftime("%Y-%m")
    y, m = map(int, month.split("-"))
    last = calendar.monthrange(y, m)[1]
    f = filters_from(request.args)
    f["from"], f["to"] = f"{y:04d}-{m:02d}-01", f"{y:04d}-{m:02d}-{last:02d}"
    c = conn()
    trades = load_trades(c, f)
    acct = f.get("account", 0)
    notes = {r["date"] for r in c.execute(
        "SELECT date FROM journal WHERE account=? AND date BETWEEN ? AND ? AND "
        "(COALESCE(plan,'')<>'' OR COALESCE(plan_ny,'')<>'' OR COALESCE(review,'')<>'')", (acct, f["from"], f["to"]))}
    c.close()
    days = {d["date"]: d for d in stats.daily(trades)}
    for d in days.values():
        d["r"] = sum((t["r"] or 0) for t in trades if stats.day_of(t["close_time"]) == d["date"])
    return jsonify({"month": month, "days": days, "notes": sorted(notes),
                    "summary": stats.summarize(trades)})


# ---------------------------------------------------------------- day journal
@app.get("/api/days")
def api_days():
    f = filters_from(request.args)
    limit = int(request.args.get("limit", 30))
    offset = int(request.args.get("offset", 0))
    acct = f.get("account", 0)
    c = conn()
    trades = load_trades(c, f)
    by_day = {}
    for t in trades:
        by_day.setdefault(stats.day_of(t["close_time"]), []).append(t)
    q = "SELECT * FROM journal WHERE account=?"
    p = [acct]
    if "from" in f:
        q += " AND date >= ?"; p.append(f["from"])
    if "to" in f:
        q += " AND date <= ?"; p.append(f["to"])
    notes = {r["date"]: dict(r) for r in c.execute(q, p)}
    c.close()
    all_days = sorted(set(by_day) | set(notes), reverse=True)
    out = []
    for d in all_days[offset:offset + limit]:
        ts = by_day.get(d, [])
        out.append({"date": d, "summary": stats.summarize(ts), "trades": ts,
                    "curve": stats.equity_curve(ts), "journal": notes.get(d)})
    return jsonify({"days": out, "total": len(all_days)})


@app.get("/api/journal/<date>")
def api_journal_get(date):
    acct = int(request.args.get("account") or 0)
    c = conn()
    r = c.execute("SELECT * FROM journal WHERE date=? AND account=?", (date, acct)).fetchone()
    c.close()
    return jsonify(dict(r) if r else {"date": date, "account": acct, "plan": "", "plan_ny": "", "review": "", "mood": None})


@app.put("/api/journal/<date>")
def api_journal_put(date):
    b = request.get_json(force=True)
    acct = int(b.get("account") or 0)
    c = conn()
    c.execute("INSERT INTO journal(date, account, plan, plan_ny, review, mood) VALUES (?,?,?,?,?,?) "
              "ON CONFLICT(date, account) DO UPDATE SET plan=excluded.plan, plan_ny=excluded.plan_ny, "
              "review=excluded.review, mood=excluded.mood",
              (date, acct, b.get("plan", ""), b.get("plan_ny", ""), b.get("review", ""), b.get("mood")))
    c.commit()
    c.close()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- trades
@app.get("/api/trades")
def api_trades():
    f = filters_from(request.args)
    c = conn()
    trades = load_trades(c, f, order="DESC")
    c.close()
    return jsonify({"trades": trades, "summary": stats.summarize(trades)})


@app.get("/api/symbols")
def api_symbols():
    c = conn()
    rows = [r[0] for r in c.execute("SELECT DISTINCT symbol FROM trades ORDER BY symbol")]
    c.close()
    return jsonify(rows)


@app.get("/api/trades/<int:tid>")
def api_trade(tid):
    c = conn()
    rows = [dict(r) for r in c.execute(
        "SELECT t.*, p.name AS playbook_name FROM trades t LEFT JOIN playbooks p ON p.id=t.playbook_id "
        "WHERE t.id=?", (tid,))]
    if not rows:
        c.close()
        abort(404)
    t = rows[0]
    t["tags"] = [dict(r) for r in c.execute(
        "SELECT g.id, g.name, g.kind FROM trade_tags x JOIN tags g ON g.id=x.tag_id WHERE x.trade_id=?", (tid,))]
    t["rules_followed"] = json.loads(t["rules_followed"] or "[]")
    t["r"] = stats.r_multiple(t)
    t["tilt"] = tilt_flags(c).get(tid, [])
    t["screenshots"] = [dict(r) for r in c.execute(
        "SELECT * FROM screenshots WHERE trade_id=? ORDER BY id", (tid,))]
    # neighbours for prev/next navigation (same account, by close time)
    prev = c.execute("SELECT id FROM trades WHERE account=? AND (close_time < ? OR (close_time = ? AND id < ?)) "
                     "ORDER BY close_time DESC, id DESC LIMIT 1",
                     (t["account"], t["close_time"], t["close_time"], tid)).fetchone()
    nxt = c.execute("SELECT id FROM trades WHERE account=? AND (close_time > ? OR (close_time = ? AND id > ?)) "
                    "ORDER BY close_time ASC, id ASC LIMIT 1",
                    (t["account"], t["close_time"], t["close_time"], tid)).fetchone()
    t["plan_charts"] = [dict(r) for r in c.execute(
        "SELECT * FROM setup_charts WHERE ticket=? ORDER BY id", (t["position_id"],))]
    plan = c.execute("SELECT notes FROM setups WHERE ticket=?", (t["position_id"],)).fetchone()
    t["plan_notes"] = plan["notes"] if plan else None
    t["prev_id"] = prev[0] if prev else None
    t["next_id"] = nxt[0] if nxt else None
    if t["playbook_id"]:
        pb = c.execute("SELECT rules FROM playbooks WHERE id=?", (t["playbook_id"],)).fetchone()
        t["playbook_rules"] = json.loads(pb["rules"] or "[]") if pb else []
    else:
        t["playbook_rules"] = []
    c.close()
    return jsonify(t)


@app.patch("/api/trades/<int:tid>")
def api_trade_patch(tid):
    b = request.get_json(force=True)
    c = conn()
    fields = {}
    for k in ("notes", "result_notes", "rating", "manual_risk", "playbook_id", "reviewed"):
        if k in b:
            v = b[k]
            if v == "":
                v = None
            fields[k] = v
    if "rules_followed" in b:
        fields["rules_followed"] = json.dumps(b["rules_followed"] or [])
    if "playbook_id" in fields and "rules_followed" not in b:
        fields["rules_followed"] = "[]"
    if fields:
        c.execute(f"UPDATE trades SET {', '.join(k + '=?' for k in fields)} WHERE id=?",
                  list(fields.values()) + [tid])
    if "tags" in b:
        c.execute("DELETE FROM trade_tags WHERE trade_id=?", (tid,))
        c.executemany("INSERT OR IGNORE INTO trade_tags(trade_id, tag_id) VALUES (?,?)",
                      [(tid, int(g)) for g in b["tags"]])
    c.commit()
    c.close()
    return api_trade(tid)


@app.post("/api/trades/bulk")
def api_trades_bulk():
    b = request.get_json(force=True)
    ids = [int(i) for i in b.get("ids", [])]
    c = conn()
    if "playbook_id" in b:
        c.executemany("UPDATE trades SET playbook_id=?, rules_followed='[]' WHERE id=?",
                      [(b["playbook_id"] or None, i) for i in ids])
    for g in b.get("add_tags", []):
        c.executemany("INSERT OR IGNORE INTO trade_tags(trade_id, tag_id) VALUES (?,?)", [(i, int(g)) for i in ids])
    if "reviewed" in b:
        c.executemany("UPDATE trades SET reviewed=? WHERE id=?", [(1 if b["reviewed"] else 0, i) for i in ids])
    c.commit()
    c.close()
    return jsonify({"ok": True, "count": len(ids)})


@app.get("/api/trades/<int:tid>/chart")
def api_trade_chart(tid):
    c = conn()
    t = c.execute("SELECT t.symbol, t.open_time, t.close_time, a.utc_offset FROM trades t "
                  "LEFT JOIN accounts a ON a.login = t.account WHERE t.id=?", (tid,)).fetchone()
    s = db.get_settings(c)
    c.close()
    if not t:
        abort(404)
    try:
        std = t["utc_offset"] if t["utc_offset"] is not None else float(s.get("server_utc_offset") or 0)
        return jsonify(mt5_sync.trade_chart(s, t["symbol"], t["open_time"], t["close_time"],
                                            request.args.get("tf"), std))
    except mt5_sync.SyncError as e:
        return err(str(e), 503)


@app.post("/api/trades/<int:tid>/screenshots")
def api_upload(tid):
    files = request.files.getlist("file")
    if not files:
        return err("No file")
    c = conn()
    for f in files:
        ext = os.path.splitext(f.filename or "")[1].lower() or ".png"
        if ext not in ALLOWED_IMG:
            continue
        name = f"{tid}_{uuid.uuid4().hex[:10]}{ext}"
        f.save(os.path.join(db.UPLOAD_DIR, name))
        c.execute("INSERT INTO screenshots(trade_id, filename, created) VALUES (?,?,?)",
                  (tid, name, int(time.time())))
    c.commit()
    c.close()
    return api_trade(tid)


@app.delete("/api/screenshots/<int:sid>")
def api_screenshot_delete(sid):
    c = conn()
    r = c.execute("SELECT filename FROM screenshots WHERE id=?", (sid,)).fetchone()
    if r:
        try:
            os.remove(os.path.join(db.UPLOAD_DIR, r["filename"]))
        except OSError:
            pass
        c.execute("DELETE FROM screenshots WHERE id=?", (sid,))
        c.commit()
    c.close()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- setups (plan charts, skipped setups)
@app.get("/api/setups")
def api_setups():
    c = conn()
    rows = [dict(r) for r in c.execute(
        "SELECT s.*, (SELECT COUNT(*) FROM setup_charts x WHERE x.ticket = s.ticket) AS charts "
        "FROM setups s ORDER BY placed_time DESC")]
    c.close()
    return jsonify({"waiting": [r for r in rows if r["status"] in ("pending", "open")],
                    "skipped": [r for r in rows if r["status"] in ("cancelled", "missed")]})


@app.post("/api/setups")
def api_setup_create():
    """A missed trade typed in by hand: a setup that was seen but never ordered in MT5."""
    b = request.get_json(force=True)
    symbol = (b.get("symbol") or "").strip().upper()
    if not symbol or b.get("direction") not in ("long", "short"):
        return err("Symbol and side are needed.")
    num = lambda k: float(b[k]) if b.get(k) not in (None, "") else None
    c = conn()
    s = db.get_settings(c)
    try:  # typed in the display clock, stored the same way as synced times
        placed = calendar.timegm(datetime.strptime(b.get("placed") or "", "%Y-%m-%dT%H:%M").timetuple())
    except ValueError:
        placed = int(time.time() + float(s.get("display_utc_offset") or 0) * 3600)
    acc = c.execute("SELECT login FROM accounts ORDER BY last_sync DESC").fetchone()
    ticket = min(c.execute("SELECT COALESCE(MIN(ticket), 0) FROM setups").fetchone()[0], 0) - 1
    c.execute("INSERT INTO setups(ticket, account, symbol, direction, order_type, volume, price, sl, tp, placed_time, "
              "status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
              (ticket, acc["login"] if acc else 0, symbol, b["direction"], "missed", None, num("price"), num("sl"),
               num("tp"), placed, "missed", b.get("notes") or ""))
    c.commit()
    c.close()
    return jsonify({"ticket": ticket})


@app.delete("/api/setups/<int(signed=True):ticket>")
def api_setup_delete(ticket):
    c = conn()
    row = c.execute("SELECT status FROM setups WHERE ticket=?", (ticket,)).fetchone()
    if not row or row["status"] != "missed":
        c.close()
        return err("Only missed trades you typed in can be deleted.")
    for r in c.execute("SELECT filename FROM setup_charts WHERE ticket=?", (ticket,)).fetchall():
        try:
            os.remove(os.path.join(db.UPLOAD_DIR, r["filename"]))
        except OSError:
            pass
    c.execute("DELETE FROM setup_charts WHERE ticket=?", (ticket,))
    c.execute("DELETE FROM setups WHERE ticket=?", (ticket,))
    c.commit()
    c.close()
    return jsonify({"ok": True})


@app.get("/api/setups/<int(signed=True):ticket>")
def api_setup(ticket):
    c = conn()
    row = c.execute("SELECT * FROM setups WHERE ticket=?", (ticket,)).fetchone()
    if not row:
        c.close()
        abort(404)
    s = dict(row)
    s["charts"] = [dict(r) for r in c.execute("SELECT * FROM setup_charts WHERE ticket=? ORDER BY id", (ticket,))]
    trade = c.execute("SELECT id FROM trades WHERE position_id=?", (ticket,)).fetchone()
    s["trade_id"] = trade["id"] if trade else None
    c.close()
    return jsonify(s)


@app.patch("/api/setups/<int(signed=True):ticket>")
def api_setup_patch(ticket):
    c = conn()
    c.execute("UPDATE setups SET notes=? WHERE ticket=?", (request.get_json(force=True).get("notes"), ticket))
    c.commit()
    c.close()
    return api_setup(ticket)


@app.post("/api/setups/<int(signed=True):ticket>/charts")
def api_setup_upload(ticket):
    c = conn()
    for f in request.files.getlist("file"):
        ext = os.path.splitext(f.filename or "")[1].lower() or ".png"
        if ext not in ALLOWED_IMG:
            continue
        name = f"plan_{ticket}_{uuid.uuid4().hex[:10]}{ext}"
        f.save(os.path.join(db.UPLOAD_DIR, name))
        c.execute("INSERT INTO setup_charts(ticket, filename, created) VALUES (?,?,?)",
                  (ticket, name, int(time.time())))
    c.commit()
    c.close()
    return api_setup(ticket)


@app.delete("/api/setup_charts/<int:cid>")
def api_setup_chart_delete(cid):
    c = conn()
    r = c.execute("SELECT filename FROM setup_charts WHERE id=?", (cid,)).fetchone()
    if r:
        try:
            os.remove(os.path.join(db.UPLOAD_DIR, r["filename"]))
        except OSError:
            pass
        c.execute("DELETE FROM setup_charts WHERE id=?", (cid,))
        c.commit()
    c.close()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- reports
@app.get("/api/reports")
def api_reports():
    group = request.args.get("group", "symbol")
    f = filters_from(request.args)
    c = conn()
    s = db.get_settings(c)
    trades = load_trades(c, f)
    out = {"group": group, "groups": stats.REPORTS,
           "rows": stats.report(trades, group, s.get("display_utc_offset")),
           "summary": stats.summarize(trades)}
    if group == "tilt":
        pb_rules = {r["id"]: json.loads(r["rules"] or "[]") for r in c.execute("SELECT id, rules FROM playbooks")}
        out["stages"] = stats.stage_discipline(trades, pb_rules)
        out["edge"] = stats.clean_vs_flagged(trades)
    c.close()
    return jsonify(out)


@app.get("/api/ai_review")
def api_ai_review_preview():
    """Shows exactly what would be sent to the AI. Sends nothing."""
    c = conn()
    trades = load_trades(c, filters_from(request.args))
    offset = db.get_settings(c).get("display_utc_offset")
    c.close()
    return jsonify({"trades": min(len(trades), ai_review.MAX_TRADES), "prompt": ai_review.build_prompt(trades, offset),
                    "models": ai_review.models()})


@app.post("/api/ai_review")
def api_ai_review():
    c = conn()
    trades = load_trades(c, filters_from(request.args))
    offset = db.get_settings(c).get("display_utc_offset")
    c.close()
    if not trades:
        return err("No trades in this date range.")
    try:
        answer, model = ai_review.ask(ai_review.build_prompt(trades, offset), request.args.get("model", ""))
    except RuntimeError as e:
        return err(str(e), 502)
    return jsonify({"answer": answer, "model": model})


PERIODS = {"week": "week", "month": "month", "3m": "3 months"}


def _month(d, n=0):
    """First day of d's month, moved n months."""
    m = d.year * 12 + d.month - 1 + n
    return datetime(m // 12, m % 12 + 1, 1)


def _period(day, period):
    """(anchor, start, end, before_start, before_end, nav_prev, nav_next) for the period holding `day`.
    week = Monday to Sunday; month = calendar month; 3m = that month and the two before it."""
    one = timedelta(days=1)
    if period == "week":
        start = day - timedelta(days=day.weekday())
        return start, start, start + 6 * one, start - 7 * one, start - one, start - 7 * one, start + 7 * one
    n = 1 if period == "month" else 3
    anchor = _month(day)                       # 3m is named by its last month
    start, end = _month(anchor, 1 - n), _month(anchor, 1) - one
    return anchor, start, end, _month(start, -n), start - one, _month(anchor, -n), _month(anchor, n)


def _review(c):
    """Trades of the asked period and of the one before, shared by the review page and its AI prompt."""
    offset = float(db.get_settings(c).get("display_utc_offset") or 0)
    period = request.args.get("period") if request.args.get("period") in PERIODS else "week"
    day = request.args.get("week") or (datetime.now(timezone.utc) + timedelta(hours=offset)).strftime("%Y-%m-%d")
    anchor, start, end, b_start, b_end, nav_prev, nav_next = _period(datetime.strptime(day, "%Y-%m-%d"), period)
    base = {k: v for k, v in filters_from(request.args).items() if k == "account"}
    ymd = lambda x: x.strftime("%Y-%m-%d")

    def span(a, b):
        f = dict(base)
        f["from"], f["to"] = ymd(a), ymd(b)
        return load_trades(c, f)

    pb_rules = {r["id"]: json.loads(r["rules"] or "[]") for r in c.execute("SELECT id, rules FROM playbooks")}
    return {"period": period, "offset": offset, "account": base.get("account", 0), "anchor": ymd(anchor),
            "from": ymd(start), "to": ymd(end), "nav_prev": ymd(nav_prev), "nav_next": ymd(nav_next),
            # weeks keep their old plain-date note key; the other periods get a prefix so they never collide
            "key": ymd(start) if period == "week" else f"{period}:{ymd(anchor)}",
            "trades": span(start, end), "before": span(b_start, b_end), "pb_rules": pb_rules}


@app.get("/api/weekly")
def api_weekly():
    """One period (week, month or 3 months, display clock) next to the period before it."""
    c = conn()
    r = _review(c)
    trades, offset = r["trades"], r["offset"]
    note = c.execute("SELECT note FROM weekly_notes WHERE week=? AND account=?", (r["key"], r["account"])).fetchone()
    journal = {x["date"]: dict(x) for x in c.execute(
        "SELECT * FROM journal WHERE account=? AND date BETWEEN ? AND ?", (r["account"], r["from"], r["to"]))}
    by_day = {}
    for t in trades:  # grouped by closing day, for the day boxes
        by_day.setdefault(stats.day_of(t["close_time"]), []).append({"id": t["id"], "net": t["net"]})
    daily = [{"date": d, "net": sum(t["net"] for t in by_day.get(d, [])), "trades": by_day.get(d, []), "journal": journal.get(d)}
             for d in sorted(set(by_day) | set(journal))]
    c.close()
    return jsonify({
        **{k: r[k] for k in ("period", "anchor", "from", "to", "nav_prev", "nav_next", "key")},
        "note": note["note"] if note else "", "daily": daily,
        "summary": stats.summarize(trades), "prev": stats.summarize(r["before"]),
        "hours": stats.report(trades, "hour", offset),
        "days": stats.report(trades, "weekday", offset),
        "playbooks": stats.report(trades, "playbook", offset),
        "flags": [x for x in stats.report(trades, "tilt", offset) if x["key"] not in ("Clean", "Not graded")],
        "stages": stats.stage_discipline(trades, r["pb_rules"]),
        "edge": stats.clean_vs_flagged(trades),
    })


@app.route("/api/weekly_ai", methods=["GET", "POST"])
def api_weekly_ai():
    """GET shows what would be sent for this period (sends nothing). POST asks the chosen AI."""
    c = conn()
    r = _review(c)
    c.close()
    trades, offset = r["trades"], r["offset"]
    flags = [x for x in stats.report(trades, "tilt", offset) if x["key"] not in ("Clean", "Not graded")]
    prompt = ai_review.build_week_prompt(r["from"], r["to"], trades, stats.summarize(trades), stats.summarize(r["before"]),
                                         flags, stats.stage_discipline(trades, r["pb_rules"]), offset, PERIODS[r["period"]])
    if request.method == "GET":
        return jsonify({"trades": min(len(trades), ai_review.MAX_TRADES), "prompt": prompt, "models": ai_review.models()})
    if not trades:
        return err("No trades in this period.")
    try:
        answer, model = ai_review.ask(prompt, request.args.get("model", ""), ai_review.WEEK_SYSTEM)
    except RuntimeError as e:
        return err(str(e), 502)
    return jsonify({"answer": answer, "model": model})


@app.put("/api/weekly/<week>")
def api_weekly_note(week):
    b = request.get_json(force=True)
    period, _, day = week.rpartition(":")
    if period not in ("", "month", "3m"):
        return err("Unknown period")
    datetime.strptime(day, "%Y-%m-%d")  # must be a real date
    c = conn()
    c.execute("INSERT INTO weekly_notes(week, account, note) VALUES (?,?,?) "
              "ON CONFLICT(week, account) DO UPDATE SET note=excluded.note",
              (week, int(b.get("account") or 0), b.get("note", "")))
    c.commit()
    c.close()
    return jsonify({"ok": True})


@app.get("/api/compare")
def api_compare():
    """Compare two filter sets, e.g. group A = a tag, group B = everything else."""
    base = filters_from(request.args)
    c = conn()
    out = []
    for side in ("a", "b"):
        f = dict(base)
        sub = {k[2:]: v for k, v in request.args.items() if k.startswith(side + "_")}
        f.update(filters_from(sub))
        ts = load_trades(c, f)
        out.append({"summary": stats.summarize(ts), "equity": stats.equity_curve(ts)})
    c.close()
    return jsonify(out)


# ---------------------------------------------------------------- tags
@app.get("/api/tags")
def api_tags():
    c = conn()
    rows = [dict(r) for r in c.execute(
        "SELECT g.*, (SELECT COUNT(*) FROM trade_tags x WHERE x.tag_id=g.id) AS uses "
        "FROM tags g ORDER BY kind, name")]
    c.close()
    return jsonify(rows)


@app.post("/api/tags")
def api_tag_create():
    b = request.get_json(force=True)
    name = (b.get("name") or "").strip()
    kind = b.get("kind") if b.get("kind") in ("setup", "mistake", "custom") else "custom"
    if not name:
        return err("Name required")
    c = conn()
    c.execute("INSERT OR IGNORE INTO tags(name, kind) VALUES (?,?)", (name, kind))
    c.commit()
    r = dict(c.execute("SELECT * FROM tags WHERE name=? AND kind=?", (name, kind)).fetchone())
    c.close()
    return jsonify(r)


@app.delete("/api/tags/<int:gid>")
def api_tag_delete(gid):
    c = conn()
    c.execute("DELETE FROM tags WHERE id=?", (gid,))
    c.commit()
    c.close()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- playbooks
def _pb(row):
    d = dict(row)
    d["rules"] = json.loads(d["rules"] or "[]")
    return d


@app.get("/api/playbooks")
def api_playbooks():
    f = filters_from(request.args)
    c = conn()
    pbs = [_pb(r) for r in c.execute("SELECT * FROM playbooks ORDER BY archived, name")]
    trades = load_trades(c, {k: v for k, v in f.items() if k != "playbook"})
    c.close()
    for p in pbs:
        ts = [t for t in trades if t["playbook_id"] == p["id"]]
        p["stats"] = stats.summarize(ts)
        req = stats.required(p["rules"])
        followed = [len(req & set(t["rules_followed"])) / len(req) for t in ts if req and t["rules_followed"]]
        p["rule_adherence"] = (sum(followed) / len(followed)) if followed else None
    return jsonify(pbs)


@app.get("/api/playbooks/<int:pid>")
def api_playbook(pid):
    f = filters_from(request.args)
    f["playbook"] = pid
    c = conn()
    s = db.get_settings(c)
    r = c.execute("SELECT * FROM playbooks WHERE id=?", (pid,)).fetchone()
    if not r:
        c.close()
        abort(404)
    p = _pb(r)
    p["photos"] = _pb_photos(c, pid)
    trades = load_trades(c, f)
    c.close()
    p["stats"] = stats.summarize(trades)
    p["equity"] = stats.equity_curve(trades)
    p["trades"] = list(reversed(trades))
    p["by_symbol"] = stats.report(trades, "symbol", s.get("display_utc_offset"))
    p["by_session"] = stats.report(trades, "session", s.get("display_utc_offset"))
    # per-rule: performance when followed vs not
    rule_stats = []
    for i, rule in enumerate(p["rules"]):
        yes = [t for t in trades if i in t["rules_followed"]]
        no = [t for t in trades if t["rules_followed"] and i not in t["rules_followed"]]
        rule_stats.append({"rule": rule, "followed": stats.summarize(yes), "broken": stats.summarize(no)})
    p["rule_stats"] = rule_stats
    return jsonify(p)


def _pb_photos(c, pid):
    return [dict(r) for r in c.execute("SELECT * FROM playbook_photos WHERE playbook_id=? ORDER BY id", (pid,))]


@app.post("/api/playbooks/<int:pid>/photos")
def api_playbook_photo_upload(pid):
    c = conn()
    for f in request.files.getlist("file"):
        ext = os.path.splitext(f.filename or "")[1].lower() or ".png"
        if ext not in ALLOWED_IMG:
            continue
        name = f"pb_{pid}_{uuid.uuid4().hex[:10]}{ext}"
        f.save(os.path.join(db.UPLOAD_DIR, name))
        c.execute("INSERT INTO playbook_photos(playbook_id, filename, created) VALUES (?,?,?)",
                  (pid, name, int(time.time())))
    c.commit()
    photos = _pb_photos(c, pid)
    c.close()
    return jsonify({"photos": photos})


@app.delete("/api/playbook_photos/<int:phid>")
def api_playbook_photo_delete(phid):
    c = conn()
    r = c.execute("SELECT filename FROM playbook_photos WHERE id=?", (phid,)).fetchone()
    if r:
        try:
            os.remove(os.path.join(db.UPLOAD_DIR, r["filename"]))
        except OSError:
            pass
        c.execute("DELETE FROM playbook_photos WHERE id=?", (phid,))
        c.commit()
    c.close()
    return jsonify({"ok": True})


@app.post("/api/playbooks")
def api_playbook_create():
    b = request.get_json(force=True)
    c = conn()
    cur = c.execute("INSERT INTO playbooks(name, description, rules, color, created) VALUES (?,?,?,?,?)",
                    (b.get("name") or "Untitled playbook", b.get("description", ""),
                     json.dumps(b.get("rules", [])), b.get("color") or "#3fb68b", int(time.time())))
    c.commit()
    pid = cur.lastrowid
    c.close()
    return jsonify({"id": pid})


@app.put("/api/playbooks/<int:pid>")
def api_playbook_update(pid):
    b = request.get_json(force=True)
    c = conn()
    c.execute("UPDATE playbooks SET name=?, description=?, rules=?, color=?, archived=? WHERE id=?",
              (b.get("name"), b.get("description", ""), json.dumps(b.get("rules", [])),
               b.get("color") or "#3fb68b", 1 if b.get("archived") else 0, pid))
    if "rule_map" in b:  # rule_map[new position] = old position: keep each trade's ticks on the same rules
        for t in c.execute("SELECT id, rules_followed FROM trades WHERE playbook_id=?", (pid,)).fetchall():
            old = json.loads(t["rules_followed"] or "[]")
            new = [n for n, o in enumerate(b["rule_map"]) if o in old]
            if new != old:
                c.execute("UPDATE trades SET rules_followed=? WHERE id=?", (json.dumps(new), t["id"]))
    c.commit()
    c.close()
    return jsonify({"ok": True})


@app.delete("/api/playbooks/<int:pid>")
def api_playbook_delete(pid):
    c = conn()
    for r in _pb_photos(c, pid):
        try:
            os.remove(os.path.join(db.UPLOAD_DIR, r["filename"]))
        except OSError:
            pass
    c.execute("DELETE FROM playbooks WHERE id=?", (pid,))
    c.commit()
    c.close()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- settings / accounts
@app.put("/api/settings")
def api_settings():
    b = request.get_json(force=True)
    c = conn()
    db.save_settings(c, b)
    s = db.get_settings(c)
    c.close()
    return jsonify(s)


@app.delete("/api/accounts/<int:login>")
def api_account_delete(login):
    c = conn()
    ids = [r[0] for r in c.execute("SELECT id FROM trades WHERE account=?", (login,))]
    for i in range(0, len(ids), 900):
        chunk = ids[i:i + 900]
        for r in c.execute(f"SELECT filename FROM screenshots WHERE trade_id IN ({','.join('?' * len(chunk))})",
                           chunk):
            try:
                os.remove(os.path.join(db.UPLOAD_DIR, r[0]))
            except OSError:
                pass
    c.execute("DELETE FROM trades WHERE account=?", (login,))
    c.execute("DELETE FROM cashflow WHERE account=?", (login,))
    c.execute("DELETE FROM journal WHERE account=?", (login,))
    c.execute("DELETE FROM accounts WHERE login=?", (login,))
    c.commit()
    c.close()
    return jsonify({"ok": True})


@app.get("/api/export.csv")
def api_export():
    import csv
    import io
    f = filters_from(request.args)
    c = conn()
    trades = load_trades(c, f)
    c.close()
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = ["account", "position_id", "symbol", "direction", "volume", "open_time", "close_time",
            "entry_price", "exit_price", "sl", "tp", "profit", "commission", "swap", "fee", "net",
            "risk", "r", "mae", "mfe", "exit_reason", "playbook_name", "rating", "notes"]
    w.writerow(cols + ["tags"])
    for t in trades:
        row = []
        for k in cols:
            v = t.get(k)
            if k in ("open_time", "close_time"):
                v = datetime.fromtimestamp(v, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            row.append(v)
        row.append("; ".join(g["name"] for g in t["tags"]))
        w.writerow(row)
    return app.response_class(buf.getvalue(), mimetype="text/csv",
                              headers={"Content-Disposition": "attachment; filename=edgebook_trades.csv"})


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5051)
    ap.add_argument("--demo", action="store_true", help="add a demo account with sample trades")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    db.init()
    if args.demo:
        import demo
        demo.seed()
        print("Demo account 999999 added.")

    threading.Thread(target=auto_sync_loop, daemon=True).start()
    url = f"http://127.0.0.1:{args.port}"
    print(f"Edgebook AI running at {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    # bound to localhost only: nothing is reachable from other machines
    app.run(host="127.0.0.1", port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()

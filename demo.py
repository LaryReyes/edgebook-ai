"""Seeds a demo account (login 999999) so you can try the app without MT5.
Remove it any time from Settings > Accounts."""
import json
import random
import time
from datetime import datetime, timedelta, timezone

import db

DEMO = 999999
SYMBOLS = {  # symbol: (price, $ per 1.0 price unit per lot, typical move)
    "EURUSD": (1.085, 100000, 0.0025),
    "GBPUSD": (1.27, 100000, 0.003),
    "USDJPY": (151.0, 660, 0.4),
    "XAUUSD": (2650.0, 100, 9.0),
    "US30": (43000.0, 1, 120.0),
}


def seed(n_days=150):
    rnd = random.Random(42)
    c = db.connect()
    c.execute("DELETE FROM trades WHERE account=?", (DEMO,))
    c.execute("DELETE FROM cashflow WHERE account=?", (DEMO,))
    c.execute("INSERT OR REPLACE INTO accounts(login, name, server, broker, currency, leverage, balance, "
              "equity, last_sync) VALUES (?,?,?,?,?,?,?,?,?)",
              (DEMO, "Demo account", "Demo-Server", "Demo Broker", "USD", 100, 10000, 10000, int(time.time())))

    if c.execute("SELECT COUNT(*) FROM playbooks").fetchone()[0] == 0:
        for name, color, desc, rules in [
            ("London Breakout", "#3fb68b", "Trade the break of the Asian range after London opens.",
             [{"group": "Entry", "text": "Asian range under 40 pips"},
              {"group": "Entry", "text": "Clean 15m close outside the range"},
              {"group": "Risk", "text": "Stop beyond the opposite side of the range"},
              {"group": "Exit", "text": "Take half at 1R, trail the rest"}]),
            ("Trend Pullback", "#5b8def", "Join the H4 trend on a pullback to the 20 EMA.",
             [{"group": "Context", "text": "H4 making higher highs / lower lows"},
              {"group": "Entry", "text": "Rejection candle at the 20 EMA"},
              {"group": "Risk", "text": "Risk no more than 1% of balance"}]),
            ("NY Reversal", "#e0a43a", "Fade the first push of the New York session into a key level.",
             [{"group": "Context", "text": "Price at daily high/low or HTF level"},
              {"group": "Entry", "text": "Break of 5m structure"},
              {"group": "Risk", "text": "No trading 15 min either side of red news"}]),
        ]:
            c.execute("INSERT INTO playbooks(name, description, rules, color, created) VALUES (?,?,?,?,?)",
                      (name, desc, json.dumps(rules), color, int(time.time())))
    pbs = [(r["id"], len(json.loads(r["rules"]))) for r in c.execute("SELECT id, rules FROM playbooks")]
    tags = {k: [r["id"] for r in c.execute("SELECT id FROM tags WHERE kind=?", (k,))]
            for k in ("setup", "mistake", "custom")}

    now = datetime.now(timezone.utc) + timedelta(hours=2)
    start = (now - timedelta(days=n_days)).replace(hour=0, minute=0, second=0, microsecond=0)
    c.execute("INSERT INTO cashflow(account, ticket, time, amount, kind, comment) VALUES (?,?,?,?,?,?)",
              (DEMO, 1, int(start.timestamp()) - 86400, 10000.0, "balance", "Initial deposit"))
    pid = 5000000
    day = start
    while day < now:
        if day.weekday() < 5:
            for _ in range(rnd.choice([0, 1, 1, 2, 2, 3, 4])):
                sym = rnd.choice(list(SYMBOLS))
                price, mult, move = SYMBOLS[sym]
                price *= 1 + rnd.uniform(-0.04, 0.04)
                hour = rnd.choice([1, 3, 9, 10, 10, 11, 15, 15, 16, 17, 18])
                o = day + timedelta(hours=hour, minutes=rnd.randint(0, 59))
                dur = int(rnd.choice([3, 8, 20, 45, 90, 180, 400, 1500]) * 60 * rnd.uniform(0.5, 1.5))
                cl = o + timedelta(seconds=dur)
                if cl > now:
                    continue
                direction = rnd.choice(["long", "short"])
                vol = rnd.choice([0.1, 0.2, 0.3, 0.5, 1.0]) if sym != "US30" else rnd.choice([1, 2, 5])
                if sym == "XAUUSD":
                    vol = rnd.choice([0.05, 0.1, 0.2])
                stop_dist = move * rnd.uniform(0.5, 1.2)
                risk = stop_dist * mult * vol
                rr = rnd.choices([-1.0, -0.5, 0.0, 0.8, 1.5, 2.2, 3.0], [32, 10, 6, 14, 18, 13, 7])[0]
                rr += rnd.uniform(-0.15, 0.15)
                profit = round(risk * rr, 2)
                sign = 1 if direction == "long" else -1
                exit_price = price + sign * stop_dist * rr
                sl = price - sign * stop_dist
                tp = price + sign * stop_dist * 2
                commission = -round(3.5 * vol * (2 if sym in ("EURUSD", "GBPUSD", "USDJPY") else 1), 2)
                mae = -round(risk * rnd.uniform(0.1, 1.0 if rr > -0.9 else 1.0), 2)
                mfe = round(max(profit, 0) + risk * rnd.uniform(0, 1.2), 2)
                reason = "stop loss" if rr < -0.9 else ("take profit" if rr > 1.9 else "manual")
                pid += 1
                cur = c.execute(
                    """INSERT INTO trades(account, position_id, symbol, direction, volume, open_time, close_time,
                         entry_price, exit_price, sl, tp, profit, commission, swap, fee, net, risk, mae, mfe,
                         exit_reason, magic, comment, rating, reviewed)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (DEMO, pid, sym, direction, vol, int(o.timestamp()), int(cl.timestamp()), price,
                     exit_price, sl, tp, profit, commission, 0.0, 0.0, profit + commission, risk, mae, mfe,
                     reason, 0, "", rnd.choice([None, None, 3, 4, 5, 2]), rnd.random() < 0.6))
                tid = cur.lastrowid
                if rnd.random() < 0.75:
                    pb, nrules = rnd.choice(pbs)
                    followed = [i for i in range(nrules) if rnd.random() < (0.85 if rr > 0 else 0.55)]
                    c.execute("UPDATE trades SET playbook_id=?, rules_followed=? WHERE id=?",
                              (pb, json.dumps(followed), tid))
                for kind, p in (("setup", 0.7), ("mistake", 0.35 if rr < 0 else 0.1), ("custom", 0.15)):
                    if tags[kind] and rnd.random() < p:
                        c.execute("INSERT OR IGNORE INTO trade_tags VALUES (?,?)", (tid, rnd.choice(tags[kind])))
        day += timedelta(days=1)
    c.commit()
    c.close()


if __name__ == "__main__":
    db.init()
    seed()
    print("Demo data seeded.")

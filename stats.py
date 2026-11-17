"""Performance metrics and report groupings."""
import json
from collections import defaultdict, OrderedDict
from datetime import datetime, timezone

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DURATION_BUCKETS = [
    (60, "< 1 min"), (300, "1–5 min"), (900, "5–15 min"), (3600, "15–60 min"),
    (4 * 3600, "1–4 hours"), (86400, "4–24 hours"), (7 * 86400, "1–7 days"), (10 ** 12, "> 1 week"),
]
R_BUCKETS = [(-2, "< -2R"), (-1, "-2R to -1R"), (0, "-1R to 0R"), (1, "0R to 1R"),
             (2, "1R to 2R"), (3, "2R to 3R"), (10 ** 9, "> 3R")]
SESSIONS = ["Asia", "London", "London/NY overlap", "New York", "After hours"]


def day_of(ts):
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def r_multiple(t):
    risk = t.get("manual_risk") or t.get("risk")
    if risk and risk > 0:
        return t["net"] / risk
    return None


def session_of(ts, offset):
    h = (datetime.fromtimestamp(ts, tz=timezone.utc).hour - int(offset or 0)) % 24
    if h < 7:
        return "Asia"
    if h < 12:
        return "London"
    if h < 16:
        return "London/NY overlap"
    if h < 21:
        return "New York"
    return "After hours"


def outcome(t, zone):
    """1 win, -1 loss, 0 breakeven. Within ±zone R is breakeven; without a known risk, the sign decides."""
    risk = t.get("manual_risk") or t.get("risk")
    if zone and risk and risk > 0 and abs(t["net"]) / risk < zone:
        return 0
    return (t["net"] > 0) - (t["net"] < 0)


TILT = ["Moved stop against", "No SL at entry", "Oversized", "After 2 losses",
        "Over daily trade limit", "Broke playbook rules"]


def tilt_flags(trades, zone, risk_pct, max_per_day, mistake_ids, rule_counts, balances):
    """Rule breaks per trade id, from plain facts only. trades: every trade of every account."""
    out = {}
    by_day = defaultdict(list)
    for t in trades:
        by_day[(t["account"], day_of(t["open_time"]))].append(t)
    for day in by_day.values():
        day.sort(key=lambda t: t["open_time"])
        for i, t in enumerate(day):
            flags = []
            risk = t.get("manual_risk") or t.get("risk")
            if t.get("moved_sl") == "AGAINST":
                flags.append("Moved stop against")
            if not risk:
                flags.append("No SL at entry")
            limit = (balances.get(t["account"]) or 0) * risk_pct / 100
            if risk and limit and risk > limit * 1.25:
                flags.append("Oversized")
            streak = 0
            for x in sorted((x for x in day if x["close_time"] <= t["open_time"]), key=lambda x: x["close_time"], reverse=True):
                if outcome(x, zone) != -1:
                    break
                streak += 1
            if streak >= 2:
                flags.append("After 2 losses")
            if max_per_day and i >= max_per_day:
                flags.append("Over daily trade limit")
            req = rule_counts.get(t.get("playbook_id"))  # positions of the required rules
            if req and not req <= set(json.loads(t.get("rules_followed") or "[]")):
                flags.append("Broke playbook rules")
            flags += mistake_ids.get(t["id"], [])  # each mistake tag is its own tilt flag
            if flags:
                out[t["id"]] = flags
    return out


def _out(t):
    return t["outcome"] if "outcome" in t else (t["net"] > 0) - (t["net"] < 0)


def summarize(trades):
    n = len(trades)
    wins = [t for t in trades if _out(t) == 1]
    losses = [t for t in trades if _out(t) == -1]
    gp = sum(t["net"] for t in wins)
    gl = sum(t["net"] for t in losses)
    net = sum(t["net"] for t in trades)
    decided = len(wins) + len(losses)

    ordered = sorted(trades, key=lambda t: t["close_time"])
    cum = peak = max_dd = 0.0
    cur_w = cur_l = max_w = max_l = 0
    for t in ordered:
        cum += t["net"]
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)
        if _out(t) == 1:
            cur_w, cur_l = cur_w + 1, 0
        elif _out(t) == -1:
            cur_l, cur_w = cur_l + 1, 0
        max_w, max_l = max(max_w, cur_w), max(max_l, cur_l)

    days = defaultdict(float)
    for t in trades:
        days[day_of(t["close_time"])] += t["net"]
    green_days = sum(1 for v in days.values() if v > 0)
    red_days = sum(1 for v in days.values() if v < 0)

    rs = [r for r in (r_multiple(t) for t in trades) if r is not None]
    hold = lambda ts: (sum(t["close_time"] - t["open_time"] for t in ts) / len(ts)) if ts else None
    avg_win = gp / len(wins) if wins else 0.0
    avg_loss = gl / len(losses) if losses else 0.0
    longs = [t for t in trades if t["direction"] == "long"]
    shorts = [t for t in trades if t["direction"] == "short"]
    win_rate = len(wins) / decided if decided else None
    # Edge score 0-100: blend of win rate, profit factor, payoff and drawdown vs gross profit
    pf = (gp / -gl) if gl else (None if not gp else float("inf"))

    tilted = sum(1 for t in trades if t.get("tilt"))
    avg = lambda k: (lambda v: sum(v) / len(v) if v else None)([t[k] for t in trades if t.get(k) is not None])
    rules_score, behaviour_score = avg("process_rules"), avg("process_behaviour")
    both = [v for v in (rules_score, behaviour_score) if v is not None]
    parts = _outcome_parts(win_rate, pf, (avg_win / -avg_loss) if avg_loss else None, max_dd, gp, net, days, n)
    graded = sum(1 for t in trades if t.get("graded", True))
    return {
        "trades": n,
        "tilt_trades": tilted,
        "graded_trades": graded,
        "discipline": 1 - tilted / graded if graded else None,
        "wins": len(wins),
        "losses": len(losses),
        "breakeven": n - decided,
        "net": net,
        "gross_profit": gp,
        "gross_loss": gl,
        "win_rate": win_rate,
        "profit_factor": None if pf == float("inf") else pf,
        "profit_factor_inf": pf == float("inf"),
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "payoff": (avg_win / -avg_loss) if avg_loss else None,
        "expectancy": net / n if n else 0.0,
        "largest_win": max((t["net"] for t in trades), default=0.0),
        "largest_loss": min((t["net"] for t in trades), default=0.0),
        "max_drawdown": max_dd,
        "max_win_streak": max_w,
        "max_loss_streak": max_l,
        "current_streak": cur_w if cur_w else -cur_l,
        "avg_hold": hold(trades),
        "avg_hold_win": hold(wins),
        "avg_hold_loss": hold(losses),
        "days": len(days),
        "green_days": green_days,
        "red_days": red_days,
        "day_win_rate": green_days / (green_days + red_days) if (green_days + red_days) else None,
        "avg_day": (sum(days.values()) / len(days)) if days else 0.0,
        "best_day": max(days.values(), default=0.0),
        "worst_day": min(days.values(), default=0.0),
        "avg_r": (sum(rs) / len(rs)) if rs else None,
        "total_r": sum(rs) if rs else None,
        "r_count": len(rs),
        "longs": len(longs),
        "long_net": sum(t["net"] for t in longs),
        "long_win_rate": _wr(longs),
        "shorts": len(shorts),
        "short_net": sum(t["net"] for t in shorts),
        "short_win_rate": _wr(shorts),
        "commission": sum(t["commission"] + t.get("fee", 0) for t in trades),
        "swap": sum(t["swap"] for t in trades),
        "volume": sum(t["volume"] for t in trades),
        "edge_score": round(sum(p["score"] for p in parts) / len(parts)) if parts else None,
        "outcome_parts": parts,
        "rules_score": None if rules_score is None else round(rules_score),
        "behaviour_score": None if behaviour_score is None else round(behaviour_score),
        "process_score": round(sum(both) / len(both)) if both else None,  # overall of the two
    }


def _wr(ts):
    w = sum(1 for t in ts if _out(t) == 1)
    l = sum(1 for t in ts if _out(t) == -1)
    return w / (w + l) if (w + l) else None


def _outcome_parts(win_rate, pf, payoff, max_dd, gp, net, days, n):
    """Outcome score: six result measures, each 0-100, equal weight. Results only, no behaviour."""
    if n < 5:
        return None
    green = [v for v in days.values() if v > 0]
    parts = [
        ("Win rate", min((win_rate or 0) / 0.6, 1.0)),                      # full marks at 60%
        ("Profit factor", min((pf if pf not in (None, float("inf")) else 3.0) / 2.5, 1.0)),  # at 2.5
        ("Avg win / loss", min((payoff or 0) / 2.0, 1.0)),                  # at 2.0
        ("Drawdown", 1.0 - min(max_dd / gp, 1.0) if gp > 0 else 0.0),       # biggest drop vs all winnings
        ("Recovery", 0.0 if net <= 0 else min(net / max_dd / 3.0, 1.0) if max_dd else 1.0),  # net / drop, at 3
        ("Consistency", 1.0 - max(green) / sum(green) if net > 0 and green else 0.0),  # profit not from one day
    ]
    return [{"name": k, "score": round(100 * v)} for k, v in parts]


def required(rules):
    """Positions of the rules that count. Rules in the group "Optional" are nice-to-have and never scored."""
    return {i for i, r in enumerate(rules) if (r.get("group") or "").strip().lower() != "optional"}


def process_parts(t, req):
    """One trade's process, as (rules, behaviour), each 0-100: how it was traded, not how it ended.
    rules = playbook rules ticked; None without a playbook or without any tick (not filled in yet).
    behaviour = 100 minus 25 per tilt flag."""
    flags = [f for f in t.get("tilt") or [] if f != "Broke playbook rules"]  # rules are scored by the rules part
    rules = 100 * len(req & set(t["rules_followed"])) / len(req) if req and t.get("rules_followed") else None
    return rules, 100 * max(0.0, 1 - 0.25 * len(flags))


def equity_curve(trades):
    cum = 0.0
    out = []
    for t in sorted(trades, key=lambda t: t["close_time"]):
        cum += t["net"]
        out.append({"time": t["close_time"], "value": round(cum, 2)})
    return out


def daily(trades):
    days = OrderedDict()
    for t in sorted(trades, key=lambda t: t["close_time"]):
        d = day_of(t["close_time"])
        x = days.setdefault(d, {"date": d, "net": 0.0, "trades": 0, "wins": 0, "losses": 0})
        x["net"] += t["net"]
        x["trades"] += 1
        x["wins"] += _out(t) == 1
        x["losses"] += _out(t) == -1
    return list(days.values())


def _bucket(value, buckets):
    for limit, label in buckets:
        if value < limit:
            return label
    return buckets[-1][1]


REPORTS = OrderedDict([
    ("symbol", "Symbol"),
    ("direction", "Long vs short"),
    ("weekday", "Day of week"),
    ("hour", "Hour opened"),
    ("session", "Session"),
    ("month", "Month"),
    ("duration", "Hold time"),
    ("volume", "Position size"),
    ("r", "R-multiple"),
    ("setup", "Setup tags"),
    ("mistake", "Mistake tags"),
    ("custom", "Custom tags"),
    ("playbook", "Playbook"),
    ("exit", "Exit reason"),
    ("rating", "Trade rating"),
    ("tilt", "Tilt"),
])


def group_keys(t, group, offset):
    if group == "symbol":
        return [t["symbol"]]
    if group == "direction":
        return [t["direction"].capitalize()]
    if group == "weekday":
        return [WEEKDAYS[datetime.fromtimestamp(t["open_time"], tz=timezone.utc).weekday()]]
    if group == "hour":
        return ["%02d:00" % datetime.fromtimestamp(t["open_time"], tz=timezone.utc).hour]
    if group == "session":
        return [session_of(t["open_time"], offset)]
    if group == "month":
        return [datetime.fromtimestamp(t["close_time"], tz=timezone.utc).strftime("%Y-%m")]
    if group == "duration":
        return [_bucket(t["close_time"] - t["open_time"], DURATION_BUCKETS)]
    if group == "volume":
        return [("%.2f" % t["volume"]).rstrip("0").rstrip(".") + " lots"]
    if group == "r":
        r = r_multiple(t)
        return [_bucket(r, R_BUCKETS)] if r is not None else ["No stop loss"]
    if group in ("setup", "mistake", "custom"):
        names = [g["name"] for g in t.get("tags", []) if g["kind"] == group]
        return names or ["(untagged)"]
    if group == "playbook":
        return [t.get("playbook_name") or "(no playbook)"]
    if group == "exit":
        return [(t.get("exit_reason") or "unknown").capitalize()]
    if group == "rating":
        return [("★" * t["rating"]) if t.get("rating") else "(unrated)"]
    if group == "tilt":
        return t.get("tilt") or (["Clean"] if t.get("graded", True) else ["Not graded"])
    return ["All"]


def _order(group, keys):
    if group == "weekday":
        return [k for k in WEEKDAYS if k in keys]
    if group == "tilt":
        fixed = ["Clean"] + TILT
        return [k for k in fixed if k in keys] + sorted(k for k in keys if k not in fixed)
    if group == "session":
        return [k for k in SESSIONS if k in keys]
    if group == "duration":
        return [l for _, l in DURATION_BUCKETS if l in keys]
    if group == "r":
        return [l for _, l in R_BUCKETS if l in keys] + (["No stop loss"] if "No stop loss" in keys else [])
    if group in ("hour", "month", "rating"):
        return sorted(keys)
    if group == "volume":
        return sorted(keys, key=lambda k: float(k.split()[0]))
    return None  # sort by net


def stage_discipline(trades, pb_rules):
    """Share of playbook rules ticked, per rule group (Entry, Risk, ...).
    Only graded trades with at least one tick count: no ticks means not filled in yet."""
    ok, total = defaultdict(int), defaultdict(int)
    for t in trades:
        rules = pb_rules.get(t.get("playbook_id")) or []
        if not (t.get("graded", True) and t.get("rules_followed") and rules):
            continue
        for i in sorted(required(rules)):
            g = rules[i].get("group") or "Other"
            total[g] += 1
            ok[g] += i in t["rules_followed"]
    return [{"stage": g, "followed": ok[g], "total": total[g]} for g in total]


def clean_vs_flagged(trades):
    graded = [t for t in trades if t.get("graded", True)]
    return {"clean": summarize([t for t in graded if not t.get("tilt")]),
            "flagged": summarize([t for t in graded if t.get("tilt")])}


def report(trades, group, offset=0):
    buckets = defaultdict(list)
    for t in trades:
        for k in group_keys(t, group, offset):
            buckets[k].append(t)
    rows = []
    for k, ts in buckets.items():
        s = summarize(ts)
        rows.append({
            "key": k, "trades": s["trades"], "wins": s["wins"], "losses": s["losses"],
            "win_rate": s["win_rate"], "net": s["net"], "profit_factor": s["profit_factor"],
            "profit_factor_inf": s["profit_factor_inf"], "expectancy": s["expectancy"],
            "avg_win": s["avg_win"], "avg_loss": s["avg_loss"], "avg_r": s["avg_r"],
            "volume": s["volume"],
        })
    order = _order(group, set(buckets))
    if order is not None:
        idx = {k: i for i, k in enumerate(order)}
        rows.sort(key=lambda r: idx.get(r["key"], 999))
    else:
        rows.sort(key=lambda r: -r["net"])
    return rows

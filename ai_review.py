"""AI Review: packs trades into a private-safe text summary and asks the AI Lary picks:
a local model (Ollama, stays on this PC) or an outside model through OmniRoute.

What is sent: date, weekday, session, symbol, side, R result, hold time, exit reason, moved stop,
rating, playbook, tags and tilt flags. Never sent: account number, balance, dollar amounts,
lot size, prices, notes, screenshots.
"""
import json
import os
import re
import urllib.error
import urllib.request

import db
import stats

OMNIROUTE_URL = "http://localhost:20128/v1/chat/completions"
OLLAMA_URL = "http://localhost:11434"   # local AI on this PC
# "coding-auto" is a combo: tries each AI in order and moves on when one is out
OMNIROUTE_MODELS = ["coding-auto", "codex/gpt-reserve", "agnes/agnes-2.5-flash",
                    "openrouter/dots-studio/dots-3-note-preview:free", "kilocode/openrouter/free",
                    "aion/aion-labs/aion-2.0"]
KEY_PATH = os.path.join(db.DATA_DIR, "omniroute_key.txt")
MAX_TRADES = 200               # most recent ones

SYSTEM = (
    "You are a trading journal reviewer. You get a trader's closed trades as one line each, "
    "with results in R (multiples of planned risk). Find patterns in the data only: which sessions, "
    "weekdays, setups and behaviours win or lose, and where the trader breaks their own rules "
    "(moved stops, tilt flags, mistake tags). Use plain, short English. Give: 1) three things that work, "
    "2) three things that lose money, 3) the one rule that would have helped most, with the numbers. "
    "Say how many trades each point is based on, and say when the sample is too small to trust. "
    "Do not predict the market and do not give buy or sell calls."
)


def trade_line(n, t, offset):
    r = t.get("r")
    mins = max(0, (t["close_time"] - t["open_time"]) // 60)
    parts = [
        f"#{n}", stats.day_of(t["open_time"]),
        stats.group_keys(t, "weekday", offset)[0][:3],
        stats.group_keys(t, "session", offset)[0],
        t["symbol"], t["direction"],
        "R=%+.2f" % r if r is not None else "R=unknown(%s)" % {1: "win", -1: "loss", 0: "breakeven"}[t["outcome"]],
        f"hold={mins}min",
    ]
    if t.get("exit_reason"):
        parts.append(f"exit={t['exit_reason']}")
    if t.get("moved_sl") and t["moved_sl"] not in ("No", "Unknown"):
        parts.append(f"movedSL={t['moved_sl']}")
    if t.get("rating"):
        parts.append(f"rating={t['rating']}/5")
    if t.get("playbook_name"):
        parts.append(f"playbook={t['playbook_name']}")
    tags = [f"{g['kind']}:{g['name']}" for g in t.get("tags", [])]
    if tags:
        parts.append("tags=" + ",".join(tags))
    if t.get("tilt"):
        parts.append("tilt=" + ",".join(t["tilt"]))
    return " | ".join(str(p) for p in parts)


def build_prompt(trades, offset):
    trades = trades[-MAX_TRADES:]
    rs = [t["r"] for t in trades if t.get("r") is not None]
    wins = sum(1 for t in trades if t["outcome"] == 1)
    losses = sum(1 for t in trades if t["outcome"] == -1)
    head = [
        f"Trades: {len(trades)} (wins {wins}, losses {losses}, breakeven {len(trades) - wins - losses})",
        "Total R: %+.2f over %d trades with known risk" % (sum(rs), len(rs)) if rs else "Total R: unknown",
        "Times are broker server time. Oldest first.",
        "",
    ]
    return "\n".join(head + [trade_line(i + 1, t, offset) for i, t in enumerate(trades)])


WEEK_SYSTEM = (
    "You are a trading journal reviewer. You get one period (a week, a month or three months) of a trader's "
    "closed trades (one line each, results in R = multiples of planned risk), the period's totals next to the "
    "period before, the rule breaks and the playbook rules ticked per stage. Use only this data. Plain text only, "
    "no markdown symbols. Short, plain English. Answer in exactly two parts, each starting with its heading on "
    "its own line. "
    "STATEMENT: 4 to 6 sentences on how the period went: results, how well the rules were followed, and what "
    "changed from the period before, with the numbers. "
    "SUMMARY: up to 3 lines 'Worked: ...', up to 3 lines 'Fix: ...', then one line 'Focus next: ...'. "
    "Say so where a point rests on 1 or 2 trades. "
    "Do not predict the market and do not give buy or sell calls."
)


def _totals(x):
    """One line of week totals. No dollar amounts."""
    f = lambda v, fmt: "unknown" if v is None else fmt % v
    return (f"{x['trades']} trades ({x['wins']} wins, {x['losses']} losses, {x['breakeven']} breakeven), "
            f"win rate {f(x['win_rate'] and x['win_rate'] * 100, '%.0f%%') if x['win_rate'] is not None else 'unknown'}, "
            f"total R {f(x['total_r'], '%+.2f')} over {x['r_count']} trades with known risk, avg R {f(x['avg_r'], '%+.2f')}, "
            f"outcome score {f(x['edge_score'], '%d')}, process score {f(x['process_score'], '%d')} "
            f"(rules {f(x['rules_score'], '%d')}, behaviour {f(x['behaviour_score'], '%d')})")


def build_week_prompt(start, end, trades, summary, prev, flags, stages, offset, label="week"):
    trades = trades[-MAX_TRADES:]
    out = [f"Period: one {label}, {start} to {end}.", "This period: " + _totals(summary),
           "Period before: " + (_totals(prev) if prev["trades"] else "no trades"),
           "Scores are 0 to 100. Outcome = results only. Process = average of rules (playbook rules ticked) "
           "and behaviour (100 minus 25 per tilt flag). 'unknown' rules score = no rules were ticked.", ""]
    if flags:
        out.append("Rule breaks this period: " + ", ".join(f"{r['key']} x{r['trades']}" for r in flags))
    if stages:
        out.append("Playbook rules ticked by stage: " + ", ".join(f"{g['stage']} {g['followed']}/{g['total']}" for g in stages))
    out += ["", "Trades, oldest first (times are broker server time):"]
    out += [trade_line(i + 1, t, offset) for i, t in enumerate(trades)]
    return "\n".join(out)


def models():
    """Choices for the picker. Local ones first: those never leave this PC."""
    out = []
    try:
        with urllib.request.urlopen(OLLAMA_URL + "/api/tags", timeout=3) as resp:
            for m in json.loads(resp.read()).get("models", []):
                if "completion" in m.get("capabilities", ["completion"]):
                    out.append({"id": "local:" + m["name"], "label": m["name"], "local": True})
    except (urllib.error.URLError, TimeoutError, ValueError):
        pass  # Ollama not running: only OmniRoute choices are shown
    out += [{"id": "omniroute:" + m, "label": m, "local": False} for m in OMNIROUTE_MODELS]
    return out


def _post(url, body, headers, timeout, name):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{name} answered {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"Can't reach {name}. Is it running? ({e})")


def ask(prompt, choice, system=SYSTEM):
    """Returns (answer, model_used). Raises RuntimeError with a plain message on failure."""
    if choice not in [m["id"] for m in models()]:
        raise RuntimeError("That AI is not available right now. Pick another one.")
    where, model = choice.split(":", 1)
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    if where == "local":
        # num_ctx: Ollama's small default would cut off a long trade list
        data = _post(OLLAMA_URL + "/api/chat", {"model": model, "messages": messages, "stream": False,
                                                "think": False,  # thinking first is too slow on this PC
                                                "options": {"num_ctx": 16384}}, {}, 900, "Ollama (local AI)")
        answer = data.get("message", {}).get("content")
    else:
        if not os.path.exists(KEY_PATH):
            raise RuntimeError("No OmniRoute key found (data/omniroute_key.txt).")
        with open(KEY_PATH, encoding="utf-8") as f:
            key = f.read().strip()
        data = _post(OMNIROUTE_URL, {"model": model, "messages": messages, "stream": False},
                     {"Authorization": "Bearer " + key}, 180, "OmniRoute")
        answer = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        model = data.get("model") or model
    answer = re.sub(r"<think>.*?</think>", "", answer or "", flags=re.S).strip()
    if not answer:
        raise RuntimeError("The AI sent back an empty answer. Try again.")
    return answer, model

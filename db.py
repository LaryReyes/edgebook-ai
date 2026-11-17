"""SQLite storage for Edgebook."""
import os
import json
import sqlite3

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
DB_PATH = os.path.join(DATA_DIR, "journal.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    login        INTEGER PRIMARY KEY,
    name         TEXT,
    server       TEXT,
    broker       TEXT,
    currency     TEXT,
    leverage     INTEGER,
    balance      REAL,
    equity       REAL,
    last_sync    INTEGER,
    utc_offset   REAL                       -- broker server offset in winter, detected at sync
);

CREATE TABLE IF NOT EXISTS trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    account       INTEGER NOT NULL,
    position_id   INTEGER NOT NULL,
    symbol        TEXT NOT NULL,
    direction     TEXT NOT NULL,           -- 'long' | 'short'
    volume        REAL NOT NULL,
    open_time     INTEGER NOT NULL,        -- MT5 server time, unix seconds
    close_time    INTEGER NOT NULL,
    entry_price   REAL,
    exit_price    REAL,
    sl            REAL,
    tp            REAL,
    profit        REAL DEFAULT 0,
    commission    REAL DEFAULT 0,
    swap          REAL DEFAULT 0,
    fee           REAL DEFAULT 0,
    net           REAL DEFAULT 0,
    risk          REAL,                    -- $ at risk from initial SL (computed)
    mae           REAL,                    -- max adverse excursion, $ (negative)
    mfe           REAL,                    -- max favourable excursion, $
    exit_reason   TEXT,
    moved_sl      TEXT,                    -- No | Toward profit | AGAINST | Unknown
    magic         INTEGER,
    comment       TEXT,
    -- user journal fields (never overwritten by sync)
    manual_risk   REAL,
    playbook_id   INTEGER REFERENCES playbooks(id) ON DELETE SET NULL,
    rating        INTEGER,
    notes         TEXT,
    rules_followed TEXT,                   -- JSON list of rule indexes
    reviewed      INTEGER DEFAULT 0,
    UNIQUE(account, position_id)
);
CREATE INDEX IF NOT EXISTS idx_trades_close ON trades(account, close_time);

CREATE TABLE IF NOT EXISTS cashflow (
    account  INTEGER NOT NULL,
    ticket   INTEGER NOT NULL,
    time     INTEGER NOT NULL,
    amount   REAL NOT NULL,
    kind     TEXT,
    comment  TEXT,
    UNIQUE(account, ticket)
);

CREATE TABLE IF NOT EXISTS tags (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    kind  TEXT NOT NULL DEFAULT 'custom',  -- 'setup' | 'mistake' | 'custom'
    UNIQUE(name, kind)
);

CREATE TABLE IF NOT EXISTS trade_tags (
    trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (trade_id, tag_id)
);

CREATE TABLE IF NOT EXISTS playbooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    rules       TEXT DEFAULT '[]',         -- JSON list of {group, text}
    color       TEXT DEFAULT '#3fb68b',
    archived    INTEGER DEFAULT 0,
    created     INTEGER
);

CREATE TABLE IF NOT EXISTS playbook_photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playbook_id INTEGER NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
    filename    TEXT NOT NULL,
    created     INTEGER
);

CREATE TABLE IF NOT EXISTS screenshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id  INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    filename  TEXT NOT NULL,
    created   INTEGER
);

-- MT5 orders: pending, open, filled or cancelled. ticket = position_id once filled.
CREATE TABLE IF NOT EXISTS setups (
    ticket      INTEGER PRIMARY KEY,
    account     INTEGER NOT NULL,
    symbol      TEXT NOT NULL,
    direction   TEXT NOT NULL,
    order_type  TEXT,
    volume      REAL,
    price       REAL,
    sl          REAL,
    tp          REAL,
    placed_time INTEGER,
    status      TEXT NOT NULL,             -- pending | open | filled | cancelled | missed (typed in, ticket < 0)
    notes       TEXT                       -- user field, never overwritten by sync
);

CREATE TABLE IF NOT EXISTS setup_charts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket   INTEGER NOT NULL,
    filename TEXT NOT NULL,
    created  INTEGER
);

CREATE TABLE IF NOT EXISTS weekly_notes (
    week     TEXT NOT NULL,                -- Monday of the week, YYYY-MM-DD
    account  INTEGER NOT NULL DEFAULT 0,   -- 0 = all accounts
    note     TEXT,
    PRIMARY KEY (week, account)
);

CREATE TABLE IF NOT EXISTS journal (
    date     TEXT NOT NULL,                -- YYYY-MM-DD
    account  INTEGER NOT NULL DEFAULT 0,   -- 0 = all accounts
    plan     TEXT,                         -- London session plan
    plan_ny  TEXT,                         -- New York session plan
    review   TEXT,
    mood     INTEGER,
    PRIMARY KEY (date, account)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

DEFAULT_SETTINGS = {
    "server_utc_offset": 2,      # fallback broker offset (winter); detected automatically at sync
    "server_dst": "us",          # broker clock moves 1 hour with New York summer time ("us") or never ("none")
    "display_utc_offset": 0,     # times are shown in this zone (hours from UTC); set yours in Settings
    "auto_sync": True,
    "sync_interval": 60,         # seconds
    "terminal_path": r"C:\Program Files\MetaTrader 5\terminal64.exe",
    "allowed_accounts": "",      # comma-separated MT5 logins; empty = none yet, set yours in Settings
    "history_start": "2015-01-01",
    "compute_excursions": True,  # MAE / MFE from M1 bars
    "currency_symbol": "$",
    "be_zone_r": 0.1,            # trades within ±this many R count as breakeven, not win or loss
    "daily_loss_limit": 0,       # 0 = off
    "max_drawdown_limit": 0,
    "profit_target": 0,
    "max_trades_per_day": 0,
    "discipline_start": "",      # YYYY-MM-DD; trades opened before this day are not graded for discipline
    "risk_per_trade_pct": 0.25,  # planned risk; above 1.25x this counts as oversized in the tilt score
}

DEFAULT_TAGS = [
    ("Breakout", "setup"), ("Pullback", "setup"), ("Reversal", "setup"), ("Range", "setup"),
    ("FOMO entry", "mistake"), ("Moved stop", "mistake"), ("Early exit", "mistake"),
    ("Oversized", "mistake"), ("Revenge trade", "mistake"), ("No stop loss", "mistake"),
    ("News", "custom"), ("A+ setup", "custom"),
]


def connect():
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init():
    conn = connect()
    conn.executescript(SCHEMA)
    if "utc_offset" not in {r[1] for r in conn.execute("PRAGMA table_info(accounts)")}:
        conn.execute("ALTER TABLE accounts ADD COLUMN utc_offset REAL")
    if "result_notes" not in {r[1] for r in conn.execute("PRAGMA table_info(trades)")}:
        conn.execute("ALTER TABLE trades ADD COLUMN result_notes TEXT")  # note under the result chart
        # the old general Notes box is gone from the page: its text moves under the result chart (notes column kept)
        conn.execute("UPDATE trades SET result_notes = notes WHERE TRIM(COALESCE(notes, '')) <> ''")
    if "plan_ny" not in {r[1] for r in conn.execute("PRAGMA table_info(journal)")}:
        conn.execute("ALTER TABLE journal ADD COLUMN plan_ny TEXT")  # New York plan; plan = London plan
    if conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0] == 0:
        conn.executemany("INSERT OR IGNORE INTO tags(name, kind) VALUES (?, ?)", DEFAULT_TAGS)
    conn.commit()
    conn.close()


def get_settings(conn):
    out = dict(DEFAULT_SETTINGS)
    for row in conn.execute("SELECT key, value FROM settings"):
        try:
            out[row["key"]] = json.loads(row["value"])
        except (TypeError, ValueError):
            out[row["key"]] = row["value"]
    return out


def save_settings(conn, values):
    for k, v in values.items():
        if k in DEFAULT_SETTINGS:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, json.dumps(v)),
            )
    conn.commit()

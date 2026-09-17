"""TELG — Technical English Listening Generator · Backend

FastAPI + SQLite. Current scope:
  - Full CRUD for materials (Generation Artifact persisted as: core columns +
    meta_json for runtime fidelity, plus dialogue/vocabulary/questions/patterns
    child tables)
  - Playlists CRUD (backend ready; frontend wiring comes in a later phase)
  - generation_jobs table reserved for a later async pipeline (no jobs yet)
  - /generate runs the real LLM (OpenAI-compatible, pydantic-validated JSON
    with retry); Test Data on the frontend switches to fixed templates
  - /materials/{mid}/synthesize runs real edge-tts: per-sentence synthesis,
    ffmpeg merge and start_ms/end_ms backfill
  - Serves the single-file frontend (../frontend/index.html) at / so the app
    is reachable over http:// (file:// would block fetch)

Run:  uvicorn main:app --reload --port 8000   (from this directory)
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from openai import OpenAI

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
DB_PATH = BASE_DIR / "telg.db"
SEED_PATH = BASE_DIR / "seed_materials.json"
STORAGE_DIR = BASE_DIR / "storage" / "audio"

app = FastAPI(title="TELG API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------------------------------------------------------
# DB helpers
# ----------------------------------------------------------------------------
def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT,
  domain TEXT,
  role TEXT,
  scenario TEXT,
  dialogue_type TEXT,
  difficulty TEXT,
  length TEXT,
  llm_provider TEXT,
  tts_provider TEXT,
  voice TEXT,
  depth INTEGER DEFAULT 3,
  breadth INTEGER DEFAULT 3,
  tone TEXT,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | audio_ready | published
  audio_url TEXT,
  total_duration_ms INTEGER DEFAULT 0,
  tag TEXT,
  filter TEXT,
  meta_json TEXT NOT NULL,                    -- full meta (runtime fidelity)
  technical_background TEXT,
  technical_principle TEXT,
  engineering_scenario TEXT,
  technical_background_zh TEXT,
  technical_principle_zh TEXT,
  engineering_scenario_zh TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  version INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dialogue_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT,
  role TEXT,
  voice TEXT,
  text_en TEXT,
  text_zh TEXT,
  start_ms INTEGER DEFAULT 0,
  end_ms INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vocabulary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  en TEXT, zh TEXT, symbol TEXT, def TEXT
);
CREATE TABLE IF NOT EXISTS listening_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  q TEXT,
  options TEXT,                                -- JSON array (en)
  answer TEXT, explain TEXT,
  q_zh TEXT,
  options_zh TEXT,                             -- JSON array (zh)
  explain_zh TEXT
);
CREATE TABLE IF NOT EXISTS core_sentence_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  title TEXT, pattern TEXT, example TEXT,
  title_zh TEXT, pattern_zh TEXT, example_zh TEXT
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS playlist_materials (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0,
  PRIMARY KEY (playlist_id, material_id)
);
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  material_id TEXT,
  phase TEXT,                                  -- corpus | tts | publish
  status TEXT DEFAULT 'pending',               -- pending | running | done | failed
  progress_pct INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  action TEXT NOT NULL,                        -- generate | regenerate | test-llm
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
"""


def init_db():
    conn = db()
    conn.executescript(SCHEMA)
    migrate_bilingual_columns(conn)
    conn.commit()
    seed(conn)
    sync_seed_bilingual(conn)
    migrate_audio_status(conn)
    conn.close()


def sync_seed_bilingual(conn: sqlite3.Connection) -> int:
    """Upgrade pre-bilingual seed rows (m1/m2/m3) with the *_zh fields defined
    in seed_materials.json when they are missing. Idempotent: rows that already
    carry zh (or that no longer exist) are left untouched. The zh upgrade only
    fills the bilingual columns; dialogue/vocabulary zh already existed."""
    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    changed = 0
    for art in data:
        mid = art["id"]
        row = conn.execute(
            "SELECT technical_background_zh FROM materials WHERE id = ?", (mid,)
        ).fetchone()
        if row is None or row["technical_background_zh"] is not None:
            continue
        bg = art.get("background", {})
        conn.execute(
            """UPDATE materials SET technical_background_zh = ?, technical_principle_zh = ?,
               engineering_scenario_zh = ?, updated_at = ? WHERE id = ?""",
            (
                bg.get("technical_background_zh"),
                bg.get("technical_principle_zh"),
                bg.get("engineering_scenario_zh"),
                int(time.time()),
                mid,
            ),
        )
        qids = [r["id"] for r in conn.execute(
            "SELECT id FROM listening_questions WHERE material_id = ? ORDER BY id", (mid,)
        ).fetchall()]
        for pos, q in enumerate(art.get("listening_questions") or []):
            if pos >= len(qids):
                break
            conn.execute(
                "UPDATE listening_questions SET q_zh = ?, options_zh = ?, explain_zh = ? WHERE id = ?",
                (
                    q.get("q_zh"),
                    json.dumps(q.get("options_zh") or [], ensure_ascii=False),
                    q.get("explain_zh"),
                    qids[pos],
                ),
            )
        pids = [r["id"] for r in conn.execute(
            "SELECT id FROM core_sentence_patterns WHERE material_id = ? ORDER BY id", (mid,)
        ).fetchall()]
        for pos, p in enumerate(art.get("core_sentence_patterns") or []):
            if pos >= len(pids):
                break
            conn.execute(
                "UPDATE core_sentence_patterns SET title_zh = ?, pattern_zh = ?, example_zh = ? WHERE id = ?",
                (p.get("title_zh"), p.get("pattern_zh"), p.get("example_zh"), pids[pos]),
            )
        changed += 1
    if changed:
        conn.commit()
    return changed


def migrate_bilingual_columns(conn: sqlite3.Connection) -> None:
    """Idempotently add bilingual (zh) columns to databases created before the
    bilingual inspector change. CREATE TABLE IF NOT EXISTS does not alter
    existing tables, so columns are added explicitly when missing."""
    migrations = {
        "materials": [
            "technical_background_zh",
            "technical_principle_zh",
            "engineering_scenario_zh",
        ],
        "listening_questions": ["q_zh", "options_zh", "explain_zh"],
        "core_sentence_patterns": ["title_zh", "pattern_zh", "example_zh"],
    }
    for table, cols in migrations.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for col in cols:
            if col not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} TEXT")


def migrate_audio_status(conn: sqlite3.Connection) -> int:
    """Old databases seeded materials as 'published' without real audio files.
    Demote them to 'draft' so the UI shows them as unsynthesized until the
    real /synthesize pipeline produces an mp3."""
    rows = conn.execute(
        "SELECT id, audio_url FROM materials WHERE status IN ('audio_ready','published')"
    ).fetchall()
    changed = 0
    for r in rows:
        url = r["audio_url"] or ""
        m = re.search(r"/api/v1/audio/([^/]+)$", url)
        f = STORAGE_DIR / m.group(1) if m else None
        if not f or not f.exists():
            conn.execute(
                "UPDATE materials SET status='draft', updated_at=? WHERE id=?",
                (int(time.time()), r["id"]),
            )
            changed += 1
    if changed:
        conn.commit()
    return changed


# ----------------------------------------------------------------------------
# Seed — template materials become draft seed data (synthesize later produces
# the audio); same schema as user-created materials
# ----------------------------------------------------------------------------
def seed(conn: sqlite3.Connection):
    cur = conn.execute("SELECT COUNT(*) AS c FROM materials")
    if cur.fetchone()["c"] > 0:
        return
    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    for art in data:
        insert_artifact(conn, art, status="draft")
    # Seed playlists mirroring the frontend defaults
    playlists = [
        ("pl-vd", "Vehicle Dynamics & Chassis", ["m1", "m3"]),
        ("pl-int", "Technical Interview Prep", ["m2"]),
        ("pl-ad", "Autonomous Driving Planning", ["m3"]),
        ("pl-emb", "Embedded Debugging & RTOS", ["m2"]),
    ]
    for pid, name, members in playlists:
        conn.execute(
            "INSERT OR IGNORE INTO playlists (id, name, created_at) VALUES (?,?,?)",
            (pid, name, int(time.time())),
        )
        for pos, mid in enumerate(members):
            conn.execute(
                "INSERT OR IGNORE INTO playlist_materials (playlist_id, material_id, position) VALUES (?,?,?)",
                (pid, mid, pos),
            )
    conn.commit()


def insert_artifact(conn: sqlite3.Connection, art: dict, status: str):
    meta = dict(art["meta"])
    # v2: structured speakers may ride on the artifact top level; persist them
    # inside meta so artifact_of can always restore the speaker list.
    if meta.get("speakers") is None and art.get("speakers"):
        meta["speakers"] = art["speakers"]
        if meta.get("speakerCount") is None:
            meta["speakerCount"] = len(art["speakers"])
    mid = art["id"]
    now = int(time.time())
    conn.execute(
        """INSERT OR REPLACE INTO materials
           (id,title,topic,domain,role,scenario,dialogue_type,difficulty,length,
            llm_provider,tts_provider,voice,depth,breadth,tone,status,audio_url,
            total_duration_ms,tag,"filter",meta_json,technical_background,
            technical_principle,engineering_scenario,
            technical_background_zh,technical_principle_zh,engineering_scenario_zh,
            created_at,updated_at,version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            mid,
            meta.get("title", ""),
            meta.get("topic"),
            meta.get("domain"),
            meta.get("role"),
            meta.get("scenario"),
            meta.get("dialogue_type"),
            meta.get("difficulty"),
            meta.get("length"),
            meta.get("llm_provider"),
            meta.get("tts_provider"),
            meta.get("voice"),
            meta.get("depth", 3),
            meta.get("breadth", 3),
            meta.get("tone"),
            status,
            meta.get("audio_url"),
            int(meta.get("total_duration_ms", 0) or 0),
            meta.get("tag"),
            meta.get("filter"),
            json.dumps(meta, ensure_ascii=False),
            art.get("background", {}).get("technical_background"),
            art.get("background", {}).get("technical_principle"),
            art.get("background", {}).get("engineering_scenario"),
            art.get("background", {}).get("technical_background_zh"),
            art.get("background", {}).get("technical_principle_zh"),
            art.get("background", {}).get("engineering_scenario_zh"),
            now,
            now,
            1,
        ),
    )
    for i, s in enumerate(art.get("dialogue", [])):
        # No timeline at generation time: the TTS pass is the only writer of
        # start_ms/end_ms. Store NULL (not 0) so the frontend can distinguish
        # "not synthesized yet" from a real 0ms start.
        st = s.get("start_ms")
        en = s.get("end_ms")
        conn.execute(
            """INSERT INTO dialogue_segments
               (material_id,seq,speaker,role,voice,text_en,text_zh,start_ms,end_ms)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                mid, i,
                s.get("speakerId") or s.get("speaker"),  # v2: stable speakerId; legacy: name
                s.get("role"), s.get("voice"),
                s.get("text_en"), s.get("text_zh"),
                int(st) if st is not None else None,
                int(en) if en is not None else None,
            ),
        )
    for v in art.get("vocabulary", []):
        conn.execute(
            "INSERT INTO vocabulary (material_id,en,zh,symbol,def) VALUES (?,?,?,?,?)",
            (mid, v.get("en"), v.get("zh"), v.get("symbol"), v.get("def")),
        )
    for q in art.get("listening_questions", []):
        conn.execute(
            "INSERT INTO listening_questions (material_id,q,options,answer,explain,q_zh,options_zh,explain_zh) VALUES (?,?,?,?,?,?,?,?)",
            (mid, q.get("q"), json.dumps(q.get("options", [])), q.get("answer"), q.get("explain"),
             q.get("q_zh"), json.dumps(q.get("options_zh", [])), q.get("explain_zh")),
        )
    for p in art.get("core_sentence_patterns", []):
        conn.execute(
            "INSERT INTO core_sentence_patterns (material_id,title,pattern,example,title_zh,pattern_zh,example_zh) VALUES (?,?,?,?,?,?,?)",
            (mid, p.get("title"), p.get("pattern"), p.get("example"),
             p.get("title_zh"), p.get("pattern_zh"), p.get("example_zh")),
        )
    conn.commit()


# ----------------------------------------------------------------------------
# Artifact assembly — DB row -> full Generation Artifact (frontend contract)
# ----------------------------------------------------------------------------
def _status_meta(meta: dict, status: str) -> dict:
    """Map DB status back to the runtime flags the frontend already understands."""
    m = dict(meta)
    m["generated"] = True
    m["saved"] = status == "published"
    m["audioReady"] = status in ("audio_ready", "published")
    if status == "published" and m.get("saved") is None:
        pass
    return m


def artifact_of(conn: sqlite3.Connection, mid: str) -> dict | None:
    row = conn.execute("SELECT * FROM materials WHERE id = ?", (mid,)).fetchone()
    if not row:
        return None
    meta = json.loads(row["meta_json"])
    meta = _status_meta(meta, row["status"])
    meta["audio_url"] = meta.get("audio_url") or row["audio_url"]
    meta["total_duration_ms"] = int(meta.get("total_duration_ms", 0) or row["total_duration_ms"] or 0)
    segs = conn.execute(
        "SELECT * FROM dialogue_segments WHERE material_id = ? ORDER BY seq",
        (mid,),
    ).fetchall()
    # v2 speakers: prefer the persisted structured list; legacy materials (and
    # imported artifacts) fall back to deriving speakers from dialogue names.
    if not meta.get("speakers"):
        seen: list[dict] = []
        idx: dict = {}
        for s in segs:
            name = s["speaker"] or ""
            if name and name not in idx:
                idx[name] = "speaker_%d" % (len(seen) + 1)
                seen.append({"id": idx[name], "role": s["role"] or name, "voiceTag": "neutral"})
        if seen:
            meta["speakers"] = seen
            meta["speakerCount"] = len(seen)
            if not meta.get("format"):
                meta["format"] = "dialogue" if len(seen) > 1 else "solo"
    vocab = conn.execute("SELECT * FROM vocabulary WHERE material_id = ?", (mid,)).fetchall()
    qs = conn.execute(
        "SELECT * FROM listening_questions WHERE material_id = ?", (mid,)
    ).fetchall()
    pats = conn.execute(
        "SELECT * FROM core_sentence_patterns WHERE material_id = ?", (mid,)
    ).fetchall()
    return {
        "id": mid,
        "meta": meta,
        "background": {
            "technical_background": row["technical_background"],
            "technical_principle": row["technical_principle"],
            "engineering_scenario": row["engineering_scenario"],
            "technical_background_zh": row["technical_background_zh"],
            "technical_principle_zh": row["technical_principle_zh"],
            "engineering_scenario_zh": row["engineering_scenario_zh"],
        },
        "dialogue": [
            {
                "id": s["id"], "speaker": s["speaker"], "role": s["role"],
                "voice": s["voice"], "text_en": s["text_en"], "text_zh": s["text_zh"],
                "start_ms": s["start_ms"], "end_ms": s["end_ms"],
            }
            for s in segs
        ],
        "vocabulary": [{"en": v["en"], "zh": v["zh"], "symbol": v["symbol"], "def": v["def"]} for v in vocab],
        "listening_questions": [
            {"q": q["q"], "options": json.loads(q["options"] or "[]"), "answer": q["answer"], "explain": q["explain"],
             "q_zh": q["q_zh"], "options_zh": json.loads(q["options_zh"] or "[]"), "explain_zh": q["explain_zh"]}
            for q in qs
        ],
        "core_sentence_patterns": [
            {"title": p["title"], "pattern": p["pattern"], "example": p["example"],
             "title_zh": p["title_zh"], "pattern_zh": p["pattern_zh"], "example_zh": p["example_zh"]}
            for p in pats
        ],
    }


def update_meta_json(conn: sqlite3.Connection, mid: str, patch: dict):
    row = conn.execute("SELECT meta_json, status FROM materials WHERE id = ?", (mid,)).fetchone()
    if not row:
        raise HTTPException(404, "material not found")
    meta = json.loads(row["meta_json"])
    meta.update(patch.get("meta", {}))
    status = row["status"]
    if patch.get("saved") is True:
        status = "published"
    if patch.get("saved") is False and status == "published":
        status = "draft"
    if patch.get("audioReady") is True and status == "draft":
        status = "audio_ready"
    title = patch.get("title", meta.get("title", ""))
    if patch.get("title"):
        meta["title"] = patch["title"]
    conn.execute(
        "UPDATE materials SET meta_json=?, title=?, status=?, updated_at=? WHERE id=?",
        (json.dumps(meta, ensure_ascii=False), title, status, int(time.time()), mid),
    )
    conn.commit()


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
class GenerateIn(BaseModel):
    topic: str
    domain: str = ""
    domainLabel: str = ""
    # --- structured conversation format (v2) ---
    # format: solo (1 speaker, exact-fill) | dialogue (2 speakers, exact-fill;
    #   asymmetric=True uses lead/respond slots) | discussion (3-5 speakers,
    #   candidate-pool with speakerCount)
    format: str = "discussion"
    asymmetric: bool = False
    roles: dict = {}               # solo: {"speaker": "..."}; dialogue: {"a","b"} or {"lead","respond"}
    roleSelection: dict = {}       # discussion: {"candidates": [...], "speakerCount": n}
    context: str = ""              # free-text scene context (what/where the conversation happens)
    # --- legacy fields (kept for dev endpoints; new frontend uses v2 fields) ---
    role: str = ""
    scenario: str = ""
    difficulty: int = 3
    length: str = "medium"
    llm: str = ""
    tts: str = ""
    voice: str = ""
    advanced: dict = {}
    llm_config: dict = {}          # {provider, base_url, api_key, model, temperature}
    test_mode: bool = False        # dev-only: use template response instead of a real LLM call


# ----------------------------------------------------------------------------
# Conversation structure primitives (v2)
#   Structure is a closed enum; context is free text. Role selection mode:
#     exact-fill    — the user names every speaker (solo / dialogue)
#     candidate-pool— the user gives a pool + headcount; LLM picks who speaks
# ----------------------------------------------------------------------------
FORMATS = {
    "solo":       {"speakerMode": ("fixed", 1), "roleSelectionMode": "exact-fill"},
    "dialogue":   {"speakerMode": ("fixed", 2), "roleSelectionMode": "exact-fill", "supportsAsymmetric": True},
    "discussion": {"speakerMode": ("range", 3, 5), "roleSelectionMode": "candidate-pool"},
}


def request_roles(p: GenerateIn) -> list[str]:
    """Ordered role names for exact-fill formats; [] for discussion."""
    fmt = (p.format or "").strip().lower()
    if fmt == "solo":
        v = ((p.roles or {}).get("speaker") or p.role or "").strip()
        return [v] if v else []
    if fmt == "dialogue":
        r = p.roles or {}
        if p.asymmetric:
            out = []
            for k in ("lead", "respond"):
                v = r.get(k, "").strip()
                if v:
                    out.append(v)
            return out
        out = []
        for k in ("a", "b"):
            v = r.get(k, "").strip()
            if v:
                out.append(v)
        if not out:
            out = [v for v in r.values() if isinstance(v, str) and v.strip()][:2]
        return out
    return []


def validate_request(p: GenerateIn) -> list[str]:
    """Pre-flight structure validation — pure code, runs BEFORE any LLM call.
    Prevents contradictions like "technical presentation + 10 roles"."""
    errs = []
    fmt = (p.format or "").strip().lower()
    spec = FORMATS.get(fmt)
    if not spec:
        return ["format 必须为 solo / dialogue / discussion（收到：%r）" % (p.format or "")]
    if fmt == "solo":
        if len(request_roles(p)) != 1:
            errs.append("solo 形态需要恰好 1 个讲者角色（roles.speaker）")
    elif fmt == "dialogue":
        roles = request_roles(p)
        if len(roles) != 2 or not all(x.strip() for x in roles):
            errs.append("dialogue 形态需要恰好 2 个角色" +
                        ("（roles.lead / roles.respond）" if p.asymmetric else "（roles.a / roles.b）"))
    else:  # discussion
        rs = p.roleSelection or {}
        cands = rs.get("candidates") or []
        n = rs.get("speakerCount")
        if not isinstance(cands, list) or len(cands) < 1:
            errs.append("discussion 形态需要候选角色列表 roleSelection.candidates")
        if not isinstance(n, int) or not (3 <= n <= 5):
            errs.append("discussion 出场人数 speakerCount 必须在 3–5")
        elif isinstance(cands, list) and len(cands) < n:
            errs.append("候选角色数量（%d）少于要求出场人数（%d）" % (len(cands), n))
    return errs


class PatchMaterialIn(BaseModel):
    title: str | None = None
    saved: bool | None = None
    audioReady: bool | None = None
    meta: dict = {}


class PlaylistIn(BaseModel):
    name: str


class PlaylistMaterialIn(BaseModel):
    material_id: str


class TestLLMIn(BaseModel):
    provider: str = ""
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    temperature: float = 0.7


class TestTTSIn(BaseModel):
    provider: str = ""
    voice: str = ""
    speech_rate: float = 1.0
    style: str = ""
    text: str = ""


class SynthIn(BaseModel):
    """Optional per-run TTS override from the frontend (voice roles + rate).
    voices: 'VoiceA + VoiceB' (frontend settings); '' falls back to meta.voice.
    Lenient on purpose: unknown fields from older frontends are ignored and
    null values fall back to defaults instead of failing with 422."""

    model_config = {"extra": "allow"}

    voices: str | list | None = None
    rate: float | None = None
    provider: str | None = None   # 'edge-tts' | 'kokoro'; None falls back to meta


# ----------------------------------------------------------------------------
# Mock generator (mirror of the frontend mockGenerate — Phase 2 replaces with
# DeepSeek JSON mode; the returned Artifact schema stays identical)
# ----------------------------------------------------------------------------
def parse_sec(l: str) -> int | None:
    if not l:
        return None
    if l == "short":
        return 60
    if l == "medium":
        return 120
    if l == "long":
        return 180
    m = re.match(r"^\d+$", str(l))
    return int(l) if m else None


TEMPLATE_SPEAKERS = [
    {"id": "speaker_1", "role": "System Lead", "voiceTag": "lead"},
    {"id": "speaker_2", "role": "Controls Engineer", "voiceTag": "respond"},
]
TEMPLATE_DIALOGUE = [
    {"speakerId": "speaker_1", "text_en": "Let's walk through the current {topic} baseline and see where the margin is.", "text_zh": "我们先过一遍当前 {topic} 的基线，看看裕度在哪里。"},
    {"speakerId": "speaker_2", "text_en": "The key constraint is response time — we only have a narrow window before the condition escalates.", "text_zh": "关键约束是响应时间——在状况恶化之前，我们只有很窄的时间窗口。"},
    {"speakerId": "speaker_1", "text_en": "Right. So the compensation logic should trigger from the sensor estimate, not wait for the effect to show up.", "text_zh": "对。所以补偿逻辑应基于传感器估计触发，而不是等效应显现出来。"},
    {"speakerId": "speaker_2", "text_en": "Agreed, but we still need to verify it under the worst-case load, including degraded sensor quality.", "text_zh": "同意，但我们仍要在最恶劣工况下验证，包括传感器质量退化的情况。"},
    {"speakerId": "speaker_1", "text_en": "Then we close the loop with a conservative calibration and validate it on the HIL bench this week.", "text_zh": "那我们就用保守标定闭环，本周在 HIL 台架上做验证。"},
    {"speakerId": "speaker_2", "text_en": "Sounds good. Let's track the margin over time and review it again at the next design review.", "text_zh": "可以。我们持续跟踪裕度变化，下次设计评审再回顾一次。"},
]
TEMPLATE_VOCAB = [
    {"en": "response time", "zh": "响应时间", "symbol": "t_resp", "def": "Time from event onset to actuator response, a key control margin factor."},
    {"en": "compensation logic", "zh": "补偿逻辑", "symbol": "", "def": "Control logic that counteracts an unwanted disturbance or deviation."},
    {"en": "sensor estimate", "zh": "传感器估计", "symbol": "", "def": "A computed quantity derived from raw sensor readings."},
    {"en": "worst-case load", "zh": "最恶劣工况", "symbol": "", "def": "The most demanding operating condition the system must survive."},
    {"en": "calibration", "zh": "标定", "symbol": "", "def": "Tuning controller parameters to match hardware and environment behavior."},
    {"en": "design review", "zh": "设计评审", "symbol": "", "def": "A structured review meeting where designs are challenged and approved."},
]
TEMPLATE_QUESTIONS = [
    {"q": "What is the key constraint mentioned at the start of the discussion?", "options": ["Cost of the hardware", "Response time window", "Fuel efficiency", "Software license"], "answer": "Response time window", "explain": "Engineer B: 'The key constraint is response time — we only have a narrow window before the condition escalates.'",
     "q_zh": "讨论开始时提到的关键约束是什么？", "options_zh": ["硬件成本", "响应时间窗口", "燃油效率", "软件许可"], "explain_zh": "工程师B：“关键约束是响应时间——在状况恶化之前，我们只有很窄的时间窗口。”"},
    {"q": "How should the compensation logic be triggered?", "options": ["By waiting for the effect to appear", "By a manual operator switch", "From the sensor estimate", "On a fixed timer"], "answer": "From the sensor estimate", "explain": "Alex: 'So the compensation logic should trigger from the sensor estimate, not wait for the effect to show up.'",
     "q_zh": "补偿逻辑应如何触发？", "options_zh": ["等效应显现出来再触发", "由操作员手动开关触发", "基于传感器估计触发", "按固定定时器触发"], "explain_zh": "Alex：“所以补偿逻辑应基于传感器估计触发，而不是等效应显现出来。”"},
    {"q": "Where will the final validation be performed this week?", "options": ["On the HIL bench", "On the public road", "In a thermal chamber", "In simulation only"], "answer": "On the HIL bench", "explain": "Alex: 'validate it on the HIL bench this week.'",
     "q_zh": "本周最终验证将在哪里进行？", "options_zh": ["在HIL台架上", "在公开道路上", "在热环境舱中", "仅在仿真中"], "explain_zh": "Alex：“本周在HIL台架上进行验证。”"},
]
TEMPLATE_PATTERNS = [
    {"title": "Constraint Statement", "pattern": "The key constraint is [X] — we only have [limit] before [condition].", "example": "The key constraint is power draw — we only have 2 seconds before the cell overheats.",
     "title_zh": "约束陈述", "pattern_zh": "关键约束是[X]——在[条件]发生之前，我们只有[限度]。", "example_zh": "关键约束是功耗——在电芯过热之前，我们只有2秒。"},
    {"title": "Trigger Decision", "pattern": "So the [logic] should trigger from the [signal], not wait for the [effect].", "example": "So the limiter should trigger from the torque estimate, not wait for the overspeed.",
     "title_zh": "触发决策", "pattern_zh": "所以[逻辑]应基于[信号]触发，而不是等[效应]显现。", "example_zh": "所以限制器应基于扭矩估计触发，而不是等超速发生。"},
    {"title": "Verification Plan", "pattern": "Then we close the loop with [approach] and validate it on [rig] this week.", "example": "Then we close the loop with a soft ramp and validate it on the dyno this week.",
     "title_zh": "验证计划", "pattern_zh": "然后我们用[方案]闭环，本周在[台架]上验证。", "example_zh": "然后我们用软斜坡闭环，本周在测功机上验证。"},
]


def mock_generate(p: GenerateIn) -> dict:
    t = (p.topic or "").lower()
    seeds = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    if re.search(r"tire|burst|blowout", t):
        base = seeds[0]
    elif re.search(r"can|bus|jitter|packet", t):
        base = seeds[1]
    elif re.search(r"torque|vectoring|turn|yaw", t):
        base = seeds[2]
    else:
        topic = p.topic or "the control problem"
        base = {
            "meta": {
                "domain": "Engineering", "role": "Engineer", "scenario": "Technical Discussion",
                "dialogue_type": "technical_discussion", "difficulty": "Level 3", "length": "120",
                "total_duration_ms": 120000, "title": "", "topic": "",
                "llm_provider": "template", "tts_provider": "edge-tts", "voice": "", "audio_url": "",
            },
            "background": {
                "technical_background": "This is a template response used for dev testing. The scenario is a working discussion about %s." % topic,
                "technical_principle": "The system relies on sensor estimates, conservative calibration and closed-loop validation to keep the operating margin safe.",
                "engineering_scenario": "Two engineers discuss the baseline, constraint, trigger logic and validation plan during a routine design review.",
                "technical_background_zh": "这是用于开发测试的模板响应。场景是围绕 %s 的工作讨论。" % topic,
                "technical_principle_zh": "该系统依靠传感器估计、保守标定与闭环验证来保持运行裕度安全。",
                "engineering_scenario_zh": "两位工程师在例行设计评审中讨论基线、约束、触发逻辑与验证计划。",
            },
            "dialogue": [
                {**d, "text_en": d["text_en"].replace("{topic}", topic), "text_zh": d["text_zh"].replace("{topic}", topic)}
                for d in TEMPLATE_DIALOGUE
            ],
            "vocabulary": TEMPLATE_VOCAB,
            "listening_questions": TEMPLATE_QUESTIONS,
            "core_sentence_patterns": TEMPLATE_PATTERNS,
        }
    art = json.loads(json.dumps(base))
    art["id"] = "gen-" + str(int(time.time() * 1000))
    art["meta"]["title"] = p.topic or base["meta"]["title"]
    art["meta"]["topic"] = p.topic or base["meta"]["topic"]
    art["meta"]["domain"] = p.domainLabel or base["meta"]["domain"]
    art["meta"]["scenario"] = p.context or base["meta"]["scenario"]
    art["meta"]["context"] = p.context or ""
    # v2 structured speakers: derive from the request format
    fmt = (p.format or "discussion").strip().lower()
    art["meta"]["format"] = fmt
    art["meta"]["asymmetric"] = bool(p.asymmetric)
    # Normalize dialogue lines to speakerId (seed rows carry legacy "speaker" names).
    mapping: dict = {}
    for d in art["dialogue"]:
        key = d.get("speakerId") or d.get("speaker") or "speaker_1"
        if key not in mapping:
            mapping[key] = "speaker_%d" % (len(mapping) + 1)
    for d in art["dialogue"]:
        key = d.get("speakerId") or d.get("speaker") or "speaker_1"
        d["speakerId"] = mapping[key]
        d.pop("speaker", None)
    if fmt == "solo":
        role = request_roles(p)
        art["speakers"] = [{"id": "speaker_1", "role": role[0] if role else "Technical Presenter", "voiceTag": "neutral"}]
        art["dialogue"] = [{**d, "speakerId": "speaker_1"} for d in art["dialogue"]]
        art["meta"]["speakerCount"] = 1
    elif fmt == "dialogue":
        roles = request_roles(p)
        if p.asymmetric and len(roles) == 2:
            art["speakers"] = [
                {"id": "speaker_1", "role": roles[0], "voiceTag": "lead"},
                {"id": "speaker_2", "role": roles[1], "voiceTag": "respond"},
            ]
        else:
            while len(roles) < 2:
                roles.append("Engineer %d" % (len(roles) + 1))
            art["speakers"] = [
                {"id": "speaker_1", "role": roles[0], "voiceTag": "lead"},
                {"id": "speaker_2", "role": roles[1], "voiceTag": "respond"},
            ]
        art["dialogue"] = [
            {**d, "speakerId": "speaker_1" if i % 2 == 0 else "speaker_2"}
            for i, d in enumerate(art["dialogue"])
        ]
        art["meta"]["speakerCount"] = 2
    else:
        rs = p.roleSelection or {}
        cands = [c for c in (rs.get("candidates") or []) if isinstance(c, str) and c.strip()]
        n = int(rs.get("speakerCount") or min(3, len(cands) or 3))
        n = max(1, min(n, len(cands) or 1))
        art["speakers"] = [
            {"id": "speaker_%d" % (i + 1), "role": cands[i], "voiceTag": "neutral"}
            for i in range(n)
        ]
        art["dialogue"] = [
            {**d, "speakerId": "speaker_%d" % (i % n + 1)} for i, d in enumerate(art["dialogue"])
        ]
        art["meta"]["speakerCount"] = n
    art["meta"]["speakers"] = art["speakers"]
    art["meta"]["dialogue_type"] = fmt
    art["meta"]["difficulty"] = "Level " + str(p.difficulty)
    art["meta"]["length"] = p.length
    sec = parse_sec(p.length)
    if sec:
        base_ms = max(int(base["meta"]["total_duration_ms"] or 0), 1)
        scale = (sec * 1000) / base_ms
        art["meta"]["total_duration_ms"] = sec * 1000
        art["dialogue"] = [
            {
                **d,
                "start_ms": int(round(d.get("start_ms", 0) * scale)),
                "end_ms": int(round(d.get("end_ms", 0) * scale)),
            }
            for d in art["dialogue"]
        ]
    adv = p.advanced or {}
    art["meta"]["depth"] = adv.get("depth", 3)
    art["meta"]["breadth"] = adv.get("breadth", 3)
    art["meta"]["tone"] = adv.get("tone", "neutral")
    art["meta"]["ttsStyle"] = adv.get("style")
    art["meta"]["speechRate"] = adv.get("vocabDensity")
    art["meta"]["audio_url"] = "/api/v1/audio/" + art["id"] + ".mp3"
    art["meta"]["total_duration_ms"] = int(art["meta"]["total_duration_ms"] or 0)
    return art


# ----------------------------------------------------------------------------
# LLM engine (Phase 2 — real generation via OpenAI-compatible API)
# ----------------------------------------------------------------------------
LENGTH_WORDS = {60: 140, 90: 215, 120: 290, 180: 435, 240: 580}

DIFFICULTY_DEFS = {
    1: "短句为主，每句 8-15 词；技术词汇密度约 10%，出现即伴随解释；不含复合从句。",
    2: "标准工程词汇，每句 10-20 词；术语约 20% 且伴随解释；复合从句不超过 1 层。",
    3: "真实工程师讨论，每句 12-25 词；术语密集约 35% 但有上下文支撑；含权衡与因果推理；复合从句不超过 2 层。",
    4: "高密度技术交流，每句 15-30 词；术语约 50% 且不加解释；隐含推理；允许复杂从句。",
    5: "主审级评审，每句 18-35 词；术语密集约 65% 且跨域引用；常省略主语；隐含含义为主。",
}

BREADTH_DEFS = {
    1: "单人讲解：一位工程师系统讲解（speaker 用真实人名或岗位名，全程一致）。",
    2: "双人技术讨论：两位工程师一问一答推进（每位 speaker 用真实人名或岗位名，如 Alex / Priya）。",
    3: "三人小组讨论：加入测试/仿真第三视角，围绕同一问题多轮交锋（三人各用真实人名或岗位名）。",
    4: "跨团队评审：动力、控制、安全等不同岗位协作决策（speaker 用具体岗位名或人名）。",
    5: "全链路多方：从开发、整车集成到量产/供应商多视角，体现端到端权衡（多岗位轮转，各自用真实人名或岗位名）。",
}

TONE_DEFS = {
    "neutral": "冷静客观的日常工作讨论。",
    "urgent": "模拟生产/测试现场紧急排查：语速感急促、直截了当、短句多。",
    "interview": "技术面试问答：一问一答、层层深入、要求对方解释原理。",
    "collaborative": "团队协作：积极回应、主动补全信息、互相确认理解。",
    "debate": "技术辩论：观点碰撞、给出反对理由与数据依据。",
    "mentoring": "导师带教：解释性强、带引导性提问。",
}

DEPTH_DEFS = {
    1: "概览级：讲清概念与用途，不深入机理。",
    2: "核心概念：覆盖主要术语与基本工作原理。",
    3: "机理与权衡：解释工作机制，讨论参数权衡与设计取舍。",
    4: "深入推导：包含公式、量级数据、时域/频域细节。",
    5: "主审级：研究前沿、边界条件、局限性与权衡深度分析。",
}

LLM_SYSTEM_PROMPT = """你是 TELG 技术英语听力素材生成引擎，为研发工程师生成真实、自然、可直接用于听力训练的双语技术对话（英文对话 + 中文翻译）。

## 输出契约（硬约束，违反即失败）
- 必须输出合法 JSON 对象。禁止 Markdown 代码块、注释、或任何 JSON 之外的文字。JSON 示例仅供参考，输出时不得包含注释。
- JSON 结构（字段名必须完全一致；所有 *_zh 字段是对应英文内容的标准中文翻译）：
{
  "background": {
    "technical_background": "英文：该主题工程背景，2-3 句",
    "technical_principle": "英文：核心技术原理，2-3 句，可含公式符号如 C_alpha",
    "engineering_scenario": "英文：这段内容发生在什么工作场景，1-2 句",
    "technical_background_zh": "上述工程背景的中文翻译",
    "technical_principle_zh": "上述技术原理的中文翻译",
    "engineering_scenario_zh": "上述工作场景的中文翻译"
  },
  "speakers": [
    {"id": "speaker_1", "role": "说话人的具体角色名（如 Sales Consultant / Calibration Engineer / Interviewer）", "voiceTag": "lead | respond | neutral"}
  ],
  "dialogue": [
    {"speakerId": "speaker_1（必须属于 speakers[].id）", "text_en": "英文台词", "text_zh": "对应中文翻译"}
  ],
  "vocabulary": [
    {"en": "英文术语", "zh": "标准译法", "symbol": "符号，无则空串", "def": "英文释义"}
  ],
  "listening_questions": [
    {"q": "问题", "options": ["选项1", "选项2", "选项3"], "answer": "正确选项的完整原文", "explain": "答案出自哪句台词",
     "q_zh": "问题的中文翻译", "options_zh": ["各选项的中文翻译，与 options 一一对应"], "explain_zh": "答案出处的中文翻译"}
  ],
  "core_sentence_patterns": [
    {"title": "句型名", "pattern": "句式模板", "example": "例句",
     "title_zh": "句型名的中文翻译", "pattern_zh": "句式模板的中文翻译", "example_zh": "例句的中文翻译"}
  ]
}
- speakers[].id 必须是稳定的 speaker_1 / speaker_2 / … 标识；dialogue 每句的 speakerId 必须指向 speakers 中已声明的 id。严禁 dialogue 中出现 speakers 之外的说话人。
- 说话人数量、角色、出场方式由用户消息中的「形态」（solo / dialogue / discussion）约束决定，必须严格遵守。
- dialogue 元素中不得出现 start_ms/end_ms/voice 等字段。

## 质量红线（按优先级排序，违反前者比违反后者更严重）
1. 技术真实性：所有概念、参数、因果必须真实，宁浅勿错；严禁编造工程原理。
2. 可听性：对话必须像真实工程师在现场讨论——有语气词、有追问、有观点碰撞；严禁教科书腔与 "Today we are going to talk about..." 式生硬开头。
3. 信息密度：每句都要携带具体信息（数值、时序、参数、权衡、因果），删除所有空泛寒暄。
- text_en 必须是地道工程英语口语；text_zh 是 text_en 的准确中文翻译，工程术语用标准译法。

## 对话结构（由用户消息中的「形态」决定，严格遵守）
- solo（单人讲解/演讲/课程）：speakers 恰好 1 人，全程一人连贯讲解，可带少量自问自答，但不得出现第二个说话人。
- dialogue 对称：speakers 恰好 2 人，双方对等交流，围绕焦点来回推进。
- dialogue 不对称（用户消息指定 lead/respond）：speakers 恰好 2 人，lead 角色主动开场、掌控话题节奏与提问，respond 角色回应并可反问；lead 话轮占比应明显高于 respond。
- discussion：speakers 的数量与角色按用户消息从候选池中挑选，不得使用候选池之外的角色，围绕同一焦点多轮交锋。

## 角色命名（硬约束）
- speakers[].role 使用具体、真实的角色名（如 "4S店销售顾问"、"Calibration Engineer"、"Supplier QA Manager"、"Interviewer"）；严禁 "Engineer A"、"Speaker 1" 式占位。
- 同一角色全部台词使用完全一致的 speakerId，拼写不得漂移。

请直接输出 JSON。"""


def build_user_prompt(p: GenerateIn, action: str = "generate") -> str:
    """需求简报式 user prompt：把参数组织成任务陈述，让模型理解"为什么生成"而非"填什么字段"。
    生成约束（难度/广度/深度等可执行化定义）随请求动态组装，System 保持完全静态以命中缓存。"""
    advanced = p.advanced if isinstance(p.advanced, dict) else {}
    breadth = advanced.get("breadth", 2)
    depth = advanced.get("depth", 3)
    tone = advanced.get("tone", "neutral")
    sec = parse_sec(p.length) or 120
    target_words = LENGTH_WORDS.get(sec, 290)
    turns = max(4, round(target_words / 38))  # ~38 词/轮 → 轮数，避免篇幅与时长脱节
    domain = p.domainLabel or p.domain or "Engineering"
    fmt = (p.format or "discussion").strip().lower()

    # --- format-specific role/structure lines ---
    if fmt == "solo":
        roles = request_roles(p)
        struct = [
            "- 形态：单人讲解独白（solo），全程 1 位讲者",
            "- 讲者角色：" + (roles[0] if roles else "领域工程师"),
        ]
    elif fmt == "dialogue":
        roles = request_roles(p)
        if p.asymmetric and len(roles) == 2:
            struct = [
                "- 形态：双人不对称对话（dialogue，一方主导）",
                "- 主导方 lead：" + roles[0] + "（主动开场、掌控话题节奏与提问）",
                "- 应答方 respond：" + roles[1] + "（回应并可反问）",
            ]
        else:
            while len(roles) < 2:
                roles.append("Engineer %d" % (len(roles) + 1))
            struct = [
                "- 形态：双人平等对话（dialogue，对称）",
                "- 角色：" + roles[0] + " 与 " + roles[1] + "（双方对等交流）",
            ]
    else:  # discussion
        rs = p.roleSelection or {}
        cands = [c for c in (rs.get("candidates") or []) if isinstance(c, str) and c.strip()]
        n = int(rs.get("speakerCount") or 3)
        n = max(1, min(n, len(cands) or 1))
        struct = [
            "- 形态：多人讨论（discussion），出场 " + str(n) + " 人",
            "- 候选角色：" + ("、".join(cands) if cands else "领域工程师"),
            "- 请从候选角色中挑选最贴合语境的 " + str(n) + " 位出场，不得使用候选池之外的角色",
        ]

    lines = [
        "请生成一套可直接用于听力训练的技术英语素材（英文内容 + 中文翻译）。",
        "",
        "## 本次任务",
        "- 主题：" + (p.topic or ""),
        "- 领域：" + domain + "（必须符合该领域研发工程师的真实语境与术语惯例）",
    ]
    lines += struct
    lines += [
        "- 场景语境：" + (p.context or "通用专业场景"),
        "- 语气：" + TONE_DEFS.get(tone, TONE_DEFS["neutral"]),
        "",
        "## 生成约束",
        "- 难度 Level " + str(p.difficulty) + "：" + DIFFICULTY_DEFS.get(p.difficulty, DIFFICULTY_DEFS[3]),
        "- 广度 Level " + str(breadth) + "：" + BREADTH_DEFS.get(breadth, BREADTH_DEFS[2]),
        "- 技术深度：" + DEPTH_DEFS.get(depth, DEPTH_DEFS[3]),
        "- 时长 " + str(p.length) + " 秒，目标总词数约 " + str(target_words) + " 词（约 " + str(turns) + " 轮对话，宁精勿灌水）",
        "- 特殊要求：" + (advanced.get("injections") or "无"),
        "",
        "## 内容看点",
        "请根据主题自行确定一个最有价值的讨论焦点（如某参数/方案的权衡、一次故障排查、一场评审分歧），"
        "让内容围绕该焦点自然展开、有张力；不要平铺直叙地罗列知识点。",
    ]
    if action == "regenerate":
        lines.insert(1, "（本次为重新生成：请更换切入角度或结构，内容与上一版不雷同，质量更优。）")
    return "\n".join(lines)


# --- structured output validation ---
from pydantic import BaseModel as _BM, Field as _F  # noqa: E402


class LLMSpeaker(_BM):
    id: str
    role: str
    voiceTag: str = "neutral"


class LLMDialogue(_BM):
    # v2: speakerId is the stable foreign key; legacy speaker/role are accepted
    # so a model that falls back to the old shape is still salvageable.
    speakerId: str = ""
    speaker: str = ""
    role: str = ""
    text_en: str
    text_zh: str


class LLMBackground(_BM):
    technical_background: str
    technical_principle: str
    engineering_scenario: str


class LLMVocab(_BM):
    en: str
    zh: str
    symbol: str = ""
    def_: str = _F(default="", alias="def")


class LLMQuestion(_BM):
    q: str
    options: list[str]
    answer: str
    explain: str


class LLMPattern(_BM):
    title: str
    pattern: str
    example: str


class LLMArtifact(_BM):
    background: LLMBackground
    speakers: list[LLMSpeaker] = []
    dialogue: list[LLMDialogue]
    vocabulary: list[LLMVocab]
    listening_questions: list[LLMQuestion]
    core_sentence_patterns: list[LLMPattern]


def _norm_role(s: str) -> str:
    """Normalize a role name for loose matching (LLMs may rephrase slightly)."""
    return re.sub(r"\s+", "", (s or "").strip().lower())


def _ensure_speakers(art: LLMArtifact) -> None:
    """Derive speakers from dialogue lines when the model did not emit them
    (legacy output shape). Mutates art.speakers in place."""
    if art.speakers:
        return
    seen: list[LLMSpeaker] = []
    idx: dict = {}
    for d in art.dialogue:
        key = (d.speakerId or d.speaker or "speaker_1").strip() or "speaker_1"
        if key not in idx:
            idx[key] = "speaker_%d" % (len(seen) + 1)
            seen.append(LLMSpeaker(id=idx[key], role=d.role or key, voiceTag="neutral"))
    art.speakers = seen


def validate_artifact(art: LLMArtifact, p: GenerateIn) -> None:
    errs = []
    fmt = (p.format or "discussion").strip().lower()
    spec = FORMATS.get(fmt, FORMATS["discussion"])
    _ensure_speakers(art)
    # 1. headcount vs format
    n = len(art.speakers)
    mode = spec["speakerMode"]
    if mode[0] == "fixed" and n != mode[1]:
        errs.append("出场人数应为 %d，实际 %d" % (mode[1], n))
    elif mode[0] == "range" and not (mode[1] <= n <= mode[2]):
        errs.append("出场人数应在 [%d, %d]，实际 %d" % (mode[1], mode[2], n))
    # 2. role provenance
    if spec["roleSelectionMode"] == "exact-fill":
        wanted = [_norm_role(r) for r in request_roles(p)]
        for sp in art.speakers:
            if _norm_role(sp.role) not in wanted:
                errs.append("出场角色「%s」不在指定填槽中" % sp.role)
    else:
        cands = {_norm_role(c) for c in ((p.roleSelection or {}).get("candidates") or [])}
        for sp in art.speakers:
            if sp.role and _norm_role(sp.role) not in cands:
                errs.append("出场角色「%s」不在候选池中" % sp.role)
    # 3. speakerId consistency
    ids = {sp.id for sp in art.speakers}
    if len(ids) != len(art.speakers):
        errs.append("speakers 存在重复 id")
    for i, d in enumerate(art.dialogue):
        sid = d.speakerId or d.speaker
        if not sid:
            errs.append("dialogue[%d] 缺少 speakerId" % i)
        elif sid not in ids:
            errs.append("dialogue[%d] 引用了未声明的 speakerId: %s" % (i, sid))
    # 4. asymmetric dialogue: lead opens and holds a fair share of turns
    if fmt == "dialogue" and p.asymmetric:
        lead_id = next((sp.id for sp in art.speakers if sp.voiceTag == "lead"), None)
        valid_lines = [d for d in art.dialogue if (d.speakerId or d.speaker) in ids]
        if lead_id:
            lead_lines = sum(1 for d in valid_lines if (d.speakerId or d.speaker) == lead_id)
            if valid_lines and (valid_lines[0].speakerId or valid_lines[0].speaker) != lead_id:
                errs.append("不对称对话未由 lead 角色开场")
            if lead_lines < len(valid_lines) * 0.3:
                errs.append("lead 角色话轮占比过低（%d/%d）" % (lead_lines, len(valid_lines)))
    # --- quality guards (unchanged) ---
    target_words = LENGTH_WORDS.get(parse_sec(p.length) or 120, 290)
    total_words = sum(len(re.findall(r"[a-zA-Z']+", s.text_en)) for s in art.dialogue)
    if total_words > target_words * 3:
        errs.append("dialogue 总词数 %d 超过目标 %d 的 3 倍，请压缩篇幅" % (total_words, target_words))
    if len(art.dialogue) < 3:
        errs.append("dialogue 至少 3 句")
    for i, s in enumerate(art.dialogue):
        if not s.text_en or not s.text_en.strip():
            errs.append("dialogue[%d].text_en 为空" % i)
        if re.search(r"[\u4e00-\u9fff]", s.text_en):
            errs.append("dialogue[%d].text_en 含中文" % i)
    if len(art.vocabulary) < 4:
        errs.append("vocabulary 至少 4 条")
    if len(art.listening_questions) < 2:
        errs.append("listening_questions 至少 2 题")
    for i, q in enumerate(art.listening_questions):
        if len(q.options) < 2:
            errs.append("question[%d] 选项少于 2" % i)
    if len(art.core_sentence_patterns) < 2:
        errs.append("core_sentence_patterns 至少 2 条")
    if errs:
        raise ValueError("; ".join(errs))


class LLMGenerationError(RuntimeError):
    pass


# Neutral defaults: any OpenAI-compatible endpoint can be used. TELG_LLM_* env
# vars take precedence; DEEPSEEK_API_KEY is kept as a backward-compatible alias.
DEFAULT_LLM_BASE = "https://api.deepseek.com/v1"
DEFAULT_LLM_MODEL = "deepseek-chat"


def _llm_endpoint(cfg: dict) -> tuple[str, str, str]:
    base = (cfg.get("base_url") or os.environ.get("TELG_LLM_BASE") or DEFAULT_LLM_BASE).strip().rstrip("/")
    key = (cfg.get("api_key") or os.environ.get("TELG_LLM_API_KEY")
           or os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    model = (cfg.get("model") or os.environ.get("TELG_LLM_MODEL") or DEFAULT_LLM_MODEL).strip()
    return base, key, model


def call_llm_with_retry(p: GenerateIn, action: str = "generate") -> dict:
    cfg = p.llm_config or {}
    base, key, model = _llm_endpoint(cfg)
    temp = float(cfg.get("temperature") or 0.7)
    if not key:
        raise LLMGenerationError("LLM API key not configured — set it in Settings (Apply) or export TELG_LLM_API_KEY")
    try:
        key.encode("ascii")
    except UnicodeEncodeError:
        raise LLMGenerationError("api_key contains non-ASCII characters (placeholder?) — enter a real key")  # noqa: B904
    target_words = LENGTH_WORDS.get(parse_sec(p.length) or 120, 290)
    # System prompt is fully static (no per-request substitution) so the
    # stable prefix hits provider context caching; all dynamic params live
    # in the user prompt (需求简报).
    system = LLM_SYSTEM_PROMPT
    # Bound output so long dialogues are never silently truncated by the model.
    max_tokens = int(target_words * 9) + 800
    client = OpenAI(base_url=base, api_key=key, timeout=60)
    errors = []
    last_usage = None
    json_fmt = True   # some OpenAI-compatible endpoints reject response_format
    for attempt in range(3):
        user = build_user_prompt(p, action)
        if errors:
            user += ("\n\n## 校验失败反馈\n你上次输出未通过校验：\n" + "\n".join(errors)
                     + "\n请只修正上述问题、保留其余内容，重新输出完整 JSON（不得输出任何 JSON 之外的内容）。")
        try:
            kwargs = dict(model=model, temperature=temp, max_tokens=max_tokens, messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ])
            if json_fmt:
                kwargs["response_format"] = {"type": "json_object"}
            resp = client.chat.completions.create(**kwargs)
            last_usage = getattr(resp, "usage", None)
            raw = (resp.choices[0].message.content or "").strip()
            data = json.loads(raw)
            art = LLMArtifact.model_validate(data)
            validate_artifact(art, p)
            _record_usage(cfg, action, last_usage)
            return art.model_dump(by_alias=True)
        except Exception as e:  # noqa: BLE001
            errors.append("%s" % e)
            if json_fmt and re.search(r"response_format|json_object|json mode|not supported|unsupported", "%s" % e, re.I):
                json_fmt = False   # retry without the structured-output flag
    raise LLMGenerationError("LLM generation failed after 3 attempts: " + " | ".join(errors[-2:]))


def _record_usage(cfg: dict, action: str, usage) -> None:
    """Persist LLM token usage (successful calls only). Never breaks generation."""
    try:
        total = int(getattr(usage, "total_tokens", 0) or 0)
        if not total:
            return
        con = db()
        con.execute(
            "INSERT INTO llm_usage(provider, model, action, prompt_tokens, completion_tokens, total_tokens)"
            " VALUES(?,?,?,?,?,?)",
            ((cfg.get("provider") or "openai-compatible"), (cfg.get("model") or ""), action,
             int(getattr(usage, "prompt_tokens", 0) or 0),
             int(getattr(usage, "completion_tokens", 0) or 0),
             total),
        )
        con.commit()
    except Exception:  # noqa: BLE001 — usage logging must never break generation
        pass




# ----------------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------------
@app.get("/api/v1/health")
def health():
    try:
        db().execute("SELECT 1").fetchone()
        return {"status": "ok"}
    except sqlite3.Error:
        raise HTTPException(503, "database unavailable")


def build_artifact(p: GenerateIn, action: str = "generate") -> dict:
    # Pre-flight structure validation — pure code, no LLM involved.
    pre_errs = validate_request(p)
    if pre_errs:
        raise HTTPException(422, detail="; ".join(pre_errs))
    # Build a Generation Artifact from the real LLM (no DB writes).
    if p.test_mode or os.environ.get("TELG_MOCK_LLM") == "1":
        return mock_generate(p)
    try:
        payload = call_llm_with_retry(p, action)
    except LLMGenerationError as e:
        raise HTTPException(502, detail=str(e))  # noqa: B904
    sec = parse_sec(p.length) or 120
    total_ms = sec * 1000
    fmt = (p.format or "discussion").strip().lower()
    speakers = payload.get("speakers") or []
    # No estimated timestamps here: start_ms/end_ms are written only by the
    # TTS pass (real durations + gap). The timeline stays authoritative.
    meta = {
        "title": p.topic or "Untitled", "topic": p.topic or "Untitled",
        "domain": p.domainLabel or p.domain or "Engineering",
        "format": fmt, "asymmetric": bool(p.asymmetric),
        "speakerCount": len(speakers), "speakers": speakers,
        "context": p.context or "",
        "scenario": (p.context or "")[:120],
        "dialogue_type": fmt,
        "difficulty": "Level " + str(p.difficulty), "length": p.length,
        "llm_provider": "DeepSeek" if not (p.llm_config or {}).get("provider") else (p.llm_config or {}).get("provider"),
        "tts_provider": "edge-tts", "voice": "en-US-GuyNeural + en-US-JennyNeural",
        "total_duration_ms": total_ms, "tag": p.domainLabel or p.domain or "Engineering",
        "filter": p.domainLabel or p.domain or "Engineering",
        "depth": (p.advanced or {}).get("depth", 3), "breadth": (p.advanced or {}).get("breadth", 2),
        "tone": (p.advanced or {}).get("tone", "neutral"),
        "ttsStyle": (p.advanced or {}).get("style"), "speechRate": (p.advanced or {}).get("vocabDensity"),
        "audio_url": "/api/v1/audio/gen-none.mp3", "generated": True, "saved": False, "audioReady": False,
    }
    return {
        "id": "gen-" + str(int(time.time() * 1000)),
        "meta": meta,
        "background": payload["background"],
        "speakers": speakers,
        "dialogue": payload["dialogue"],
        "vocabulary": payload["vocabulary"],
        "listening_questions": payload["listening_questions"],
        "core_sentence_patterns": payload["core_sentence_patterns"],
    }


class ImportIn(BaseModel):
    artifact: dict


@app.post("/api/v1/materials/import")
def import_material(body: ImportIn):
    """Import a fully-formed Generation Artifact (used by Test Data mode: the
    corpus comes from the frontend template, but it must live in the DB so the
    real TTS/playback pipeline can synthesize and play it)."""
    art = body.artifact or {}
    mid = str(art.get("id") or ("gen-" + str(int(time.time() * 1000))))
    conn = db()
    for t in ("dialogue_segments", "vocabulary", "listening_questions",
              "core_sentence_patterns"):
        conn.execute("DELETE FROM %s WHERE material_id = ?" % t, (mid,))
    conn.execute("DELETE FROM materials WHERE id = ?", (mid,))
    insert_artifact(conn, art, status="draft")
    conn.commit()
    conn.close()
    return artifact_of(db(), mid)


@app.post("/api/v1/generate")
def generate(p: GenerateIn):
    art = build_artifact(p)
    conn = db()
    insert_artifact(conn, art, status="draft")
    conn.close()
    return artifact_of(db(), art["id"])


@app.get("/api/v1/materials")
def list_materials():
    conn = db()
    rows = conn.execute("SELECT id FROM materials ORDER BY created_at").fetchall()
    out = [artifact_of(conn, r["id"]) for r in rows]
    conn.close()
    return out


@app.get("/api/v1/materials/{mid}")
def get_material(mid: str):
    art = artifact_of(db(), mid)
    if not art:
        raise HTTPException(404, "material not found")
    return art


@app.patch("/api/v1/materials/{mid}")
def patch_material(mid: str, p: PatchMaterialIn):
    conn = db()
    update_meta_json(conn, mid, p.model_dump(exclude_none=True))
    conn.close()
    return artifact_of(db(), mid)


@app.delete("/api/v1/materials/{mid}")
def delete_material(mid: str):
    conn = db()
    conn.execute("DELETE FROM playlist_materials WHERE material_id = ?", (mid,))
    conn.execute("DELETE FROM materials WHERE id = ?", (mid,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/v1/materials/{mid}/regenerate")
def regenerate(mid: str, p: GenerateIn):
    conn = db()
    if not conn.execute("SELECT id FROM materials WHERE id = ?", (mid,)).fetchone():
        conn.close()
        raise HTTPException(404, "material not found")
    conn.close()
    art = build_artifact(p, "regenerate")
    art["id"] = mid
    conn = db()
    for t in ("dialogue_segments", "vocabulary", "listening_questions", "core_sentence_patterns"):
        conn.execute("DELETE FROM %s WHERE material_id = ?" % t, (mid,))
    conn.execute("DELETE FROM materials WHERE id = ?", (mid,))
    conn.commit()
    insert_artifact(conn, art, status="draft")
    conn.close()
    return artifact_of(db(), mid)


def voices_of(meta: dict) -> list[str]:
    """Parse 'VoiceA + VoiceB' (or a single voice) from meta.voice into a list."""
    vs = [v.strip() for v in re.split(r"[+]", meta.get("voice") or "") if v.strip()]
    return vs or ["en-US-GuyNeural"]


# Voices verified against the real edge-tts endpoint (en-*).
TTS_VERIFIED = [
    "en-US-GuyNeural", "en-US-JennyNeural", "en-US-ChristopherNeural",
    "en-US-EricNeural", "en-US-AriaNeural", "en-US-MichelleNeural",
    "en-US-RogerNeural", "en-US-SteffanNeural", "en-US-AnaNeural",
    "en-US-BrianNeural", "en-GB-SoniaNeural", "en-GB-RyanNeural",
    "en-AU-NatashaNeural", "en-AU-WilliamNeural",
]
_SHORT_PREFIX = {"GuyNeural": "en-US", "JennyNeural": "en-US", "ChristopherNeural": "en-US",
                 "EricNeural": "en-US", "AriaNeural": "en-US", "MichelleNeural": "en-US",
                 "RogerNeural": "en-US", "SteffanNeural": "en-US", "AnaNeural": "en-US",
                 "BrianNeural": "en-US", "SoniaNeural": "en-GB", "RyanNeural": "en-GB",
                 "NatashaNeural": "en-AU", "WilliamNeural": "en-AU"}


class TTSModelMissing(RuntimeError):
    """Kokoro model files or dependency not available (not an edge-tts network error)."""


def tts_error_class(e: Exception) -> str:
    """Classify a TTS failure so the frontend can show a friendly reason
    instead of a raw exception dump. Returns one of: timeout / unreachable /
    auth / model_missing / other."""
    s = str(e).lower()
    if isinstance(e, TTSModelMissing) or ("model" in s and "not found" in s) or "not downloaded" in s:
        return "model_missing"
    if any(k in s for k in ("connection timeout", "timed out", "timeout")):
        return "timeout"
    if any(k in s for k in ("failed to connect", "cannot connect", "connect call failed",
                            "getaddrinfo", "name or service not known", "clientconnectorerror",
                            "network is unreachable", "unreachable", "connection refused")):
        return "unreachable"
    if any(k in s for k in ("unauthorized", "forbidden", "token", "401", "403", "access denied")):
        return "auth"
    return "other"


def normalize_voice(v: str) -> str:
    """Map legacy short names / unverified voices to a working edge-tts voice."""
    v = (v or "").strip()
    if not v:
        return "en-US-GuyNeural"
    if v in TTS_VERIFIED:
        return v
    if v in _SHORT_PREFIX:
        return _SHORT_PREFIX[v] + "-" + v
    return "en-US-GuyNeural"  # unknown voice → safe default


def probe_ms(path: Path) -> int:
    """Exact duration of a WAV (sample-accurate). Only WAV is probed now —
    each sentence is normalized to WAV before measuring, so no mp3 estimation
    drift can reach the timeline."""
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    try:
        return int(round(float(p.stdout.strip()) * 1000))
    except ValueError:
        raise RuntimeError("ffprobe failed on %s" % path.name)  # noqa: TRY003


def ensure_gap(out_dir: Path, gap_ms: int = 300) -> Path:
    """Reusable silence WAV. mp3 would round 300ms up to a whole frame (~336ms),
    silently lengthening the physical file; WAV is sample-exact."""
    gp = out_dir / ("_gap_%dms.wav" % gap_ms)
    if not gp.exists():
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi",
             "-i", "anullsrc=r=24000:cl=mono",
             "-t", "%.3f" % (gap_ms / 1000.0), "-c:a", "pcm_s16le",
             str(gp)],
            capture_output=True, text=True, timeout=30, check=True,
        )
    return gp


def merge_mp3(out_dir: Path, mid: str, n: int, out: Path, gap: Path | None = None) -> None:
    """Concatenate per-sentence mp3s (with optional inter-sentence silence) by
    decoding and re-encoding in one pass. Stream-copy concatenation would preserve
    each segment's mp3 encoder padding, making the physical duration drift from the
    probe-based timeline; re-encoding eliminates that drift."""
    files = []
    for i in range(n):
        seg = out_dir / ("%s-seg-%d.wav" % (mid, i))
        if not seg.exists():
            raise RuntimeError("missing segment %s" % seg.name)
        files.append(seg)
        if gap is not None and i < n - 1:
            files.append(gap)
    cmd = ["ffmpeg", "-y"]
    for f in files:
        cmd += ["-i", str(f)]
    fc = "".join("[%d:a]" % i for i in range(len(files))) +          "concat=n=%d:v=0:a=1[a]" % len(files)
    cmd += ["-filter_complex", fc, "-map", "[a]",
            "-ar", "24000", "-ac", "1", "-c:a", "libmp3lame", "-q:a", "4", str(out)]
    subprocess.run(cmd, capture_output=True, text=True, timeout=300, check=True)


# ----------------------------------------------------------------------------
# Pluggable TTS engines
# ----------------------------------------------------------------------------
class TTSEngine:
    name = "edge-tts"
    is_online = True
    requires_gpu = False

    def ensure_loaded(self) -> None:
        """No-op for online engines; Kokoro loads its ONNX model lazily."""

    async def synthesize_seg(self, text: str, voice: str, rate: float,
                             wav_path: Path, mid: str, i: int) -> None:
        """Synthesize one sentence to a 24k mono PCM16 WAV at wav_path."""
        raise NotImplementedError  # pragma: no cover

    def available_voices(self) -> list[dict]:
        return [{"id": v, "label": v, "lang": "en"} for v in TTS_VERIFIED]


class EdgeTTSEngine(TTSEngine):
    name = "edge-tts"
    is_online = True

    async def synthesize_seg(self, text: str, voice: str, rate: float,
                             wav_path: Path, mid: str, i: int) -> None:
        import edge_tts
        mp3_path = wav_path.with_suffix(".mp3")
        com = edge_tts.Communicate(text, voice=voice,
                                   rate="%+d%%" % int((rate - 1.0) * 100))
        await asyncio.wait_for(com.save(str(mp3_path)), timeout=45)
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(mp3_path), "-ar", "24000", "-ac", "1",
             "-c:a", "pcm_s16le", str(wav_path)],
            capture_output=True, text=True, timeout=60, check=True,
        )
        mp3_path.unlink(missing_ok=True)


_KOKORO_LANGS = {"af": "en-us", "am": "en-us", "bf": "en-gb", "bm": "en-gb",
                 "zf": "zh", "zm": "zh", "jf": "ja", "jm": "ja", "hf": "hi",
                 "ef": "es", "ff": "fr", "if": "it", "pf": "pt", "kf": "ko"}


def _voice_lang(v: str) -> str:
    return _KOKORO_LANGS.get((v or "")[:2], "en-us")


def _voice_label(v: str) -> str:
    # af_bella -> Bella
    name = v.split("_", 1)[-1]
    return name[:1].upper() + name[1:] if name else v


class KokoroEngine(TTSEngine):
    name = "kokoro"
    is_online = False
    # Candidate model directories, in priority order:
    #   1) TELG_KOKORO_CACHE env var   2) project-local backend/models/kokoro
    #   3) user home ~/.cache/telg/kokoro
    FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")

    def __init__(self) -> None:
        self.cache_dir = self._resolve_cache_dir()
        self.model_path = self.cache_dir / self.FILES[0]
        self.voices_path = self.cache_dir / self.FILES[1]
        self._kokoro = None
        self._load_lock = threading.Lock()

    def _resolve_cache_dir(self) -> Path:
        env = os.environ.get("TELG_KOKORO_CACHE")
        candidates = []
        if env:
            candidates.append(Path(env))
        candidates.append(Path(__file__).resolve().parent / "models" / "kokoro")
        candidates.append(Path.home() / ".cache" / "telg" / "kokoro")
        for c in candidates:
            if all((c / f).exists() for f in self.FILES):
                return c
        # None complete yet: point the hint at the first candidate (env override,
        # else the project-local dir) — both are index 0 of the candidate list.
        return candidates[0]

    def ensure_loaded(self) -> None:
        if self._kokoro is not None:
            return
        with self._load_lock:  # double-checked: warm-up thread may race a request
            if self._kokoro is not None:
                return
            miss = [str(p) for p in (self.model_path, self.voices_path) if not p.exists()]
            if miss:
                raise TTSModelMissing(
                    "Kokoro model not downloaded — put kokoro-v1.0.onnx and voices-v1.0.bin "
                    "under %s (see requirements-tts-kokoro.txt / download script)" % self.cache_dir)
            try:
                from kokoro_onnx import Kokoro
            except ImportError:
                raise TTSModelMissing(
                    "kokoro-onnx not installed — run: pip install -r requirements-tts-kokoro.txt")
            try:
                self._kokoro = Kokoro(str(self.model_path), str(self.voices_path))
            except Exception as e:  # noqa: BLE001  (InvalidProtobuf etc. → model files corrupt/incomplete)
                raise TTSModelMissing(
                    "Kokoro model files are incomplete or corrupt under %s — re-download them "
                    "(see requirements-tts-kokoro.txt): %s" % (self.cache_dir, str(e)[:160]))

    async def synthesize_seg(self, text: str, voice: str, rate: float,
                             wav_path: Path, mid: str, i: int) -> None:
        self.ensure_loaded()
        import soundfile as sf
        # CPU inference is blocking (~1-3s/sentence) — run off the event loop
        # so other requests (audition pre-warm, UI polls) are not stalled.
        samples, sr = await asyncio.to_thread(self._kokoro.create, text, voice=voice, speed=rate)
        sf.write(str(wav_path), samples, sr, subtype="PCM_16")

    def available_voices(self) -> list[dict]:
        self.ensure_loaded()
        return [{"id": v, "label": _voice_label(v), "lang": _voice_lang(v)}
                for v in self._kokoro.get_voices()]


ENGINES = {"edge-tts": EdgeTTSEngine(), "kokoro": KokoroEngine()}


def get_engine(provider: str | None) -> TTSEngine:
    return ENGINES.get((provider or "").strip().lower(), ENGINES["edge-tts"])


@app.post("/api/v1/materials/{mid}/synthesize")
async def synthesize(mid: str, body: SynthIn | None = None):
    body = body or SynthIn()
    conn = db()
    row = conn.execute(
        "SELECT meta_json, status FROM materials WHERE id = ?", (mid,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "material not found")
    meta = json.loads(row["meta_json"])
    segs = conn.execute(
        "SELECT seq, speaker, text_en FROM dialogue_segments "
        "WHERE material_id = ? ORDER BY seq",
        (mid,),
    ).fetchall()
    if not segs:
        conn.close()
        raise HTTPException(400, "no dialogue segments to synthesize")
    raw_voices = body.voices
    if isinstance(raw_voices, list):
        raw_voices = " + ".join(str(x.get("voice") if isinstance(x, dict) else x) for x in raw_voices)
    vs = [v.strip() for v in re.split(r"[+]", raw_voices or "") if v.strip()] or voices_of(meta)
    engine = get_engine(body.provider or meta.get("tts_provider") or "edge-tts")
    if engine.name == "edge-tts":
        vs = [normalize_voice(v) for v in vs] or ["en-US-GuyNeural"]
    else:
        vs = [v for v in vs] or ["af_bella"]
    rate = body.rate if (body.rate is not None and 0.5 <= body.rate <= 2.0) else 1.0
    gap_ms = 400
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        engine.ensure_loaded()
    except TTSModelMissing as e:
        conn.close()
        raise HTTPException(502, "TTS synthesis failed [model_missing]: %s" % e)
    try:
        # Speaker -> voice assignment: one voice per speaker so every line of
        # the same person sounds identical. lead -> first voice, respond ->
        # second (when available), remaining speakers cycle through the list.
        spk_voices: dict = {}
        speakers = meta.get("speakers") or []
        if speakers:
            for idx, sp in enumerate(speakers):
                sid = str(sp.get("id") or "")
                if not sid:
                    continue
                vt = sp.get("voiceTag") or "neutral"
                vi = 1 if (vt == "respond" and len(vs) > 1) else (0 if vt == "lead" else idx)
                spk_voices[sid] = vs[vi % len(vs)]
        else:  # legacy materials: assign by first-appearance order of speaker names
            order: list = []
            for s in segs:
                if s["speaker"] and s["speaker"] not in order:
                    order.append(s["speaker"])
            for i, name in enumerate(order):
                spk_voices[name] = vs[i % len(vs)]
        times = []
        start = 0
        for i, seg in enumerate(segs):
            text = (seg["text_en"] or "").strip() or "…"
            voice = spk_voices.get(seg["speaker"]) or vs[i % len(vs)]
            # each sentence is normalized to 24k mono WAV so duration is
            # sample-exact and the merge pass sees one consistent format
            wav_path = STORAGE_DIR / ("%s-seg-%d.wav" % (mid, i))
            await engine.synthesize_seg(text, voice, rate, wav_path, mid, i)
            # The TTS output is kept untouched (no silence trimming). The gap
            # below absorbs the ~30-130ms lead/trail padding TTS models add, so
            # start_ms/end_ms land on segment boundaries and the voice follows
            # within a human-imperceptible window.
            dur = probe_ms(wav_path)
            times.append((seg["seq"], start, start + dur))
            start += dur + gap_ms
        gap = ensure_gap(STORAGE_DIR, gap_ms)
        out_path = STORAGE_DIR / (mid + ".mp3")
        merge_mp3(STORAGE_DIR, mid, len(segs), out_path, gap)
        for i in range(len(segs)):
            (STORAGE_DIR / ("%s-seg-%d.wav" % (mid, i))).unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        conn.close()
        raise HTTPException(502, "TTS synthesis failed [%s]: %s" % (tts_error_class(e), e))
    for seq, st, en in times:
        conn.execute(
            "UPDATE dialogue_segments SET start_ms=?, end_ms=? "
            "WHERE material_id = ? AND seq = ?",
            (st, en, mid, seq),
        )
    meta["audio_url"] = "/api/v1/audio/" + mid + ".mp3"
    meta["total_duration_ms"] = times[-1][2]
    meta["audioReady"] = True
    meta["saved"] = False
    status = "published" if row["status"] == "published" else "audio_ready"
    conn.execute(
        "UPDATE materials SET meta_json=?, status=?, audio_url=?, "
        "total_duration_ms=?, updated_at=? WHERE id=?",
        (json.dumps(meta, ensure_ascii=False), status, meta["audio_url"],
         meta["total_duration_ms"], int(time.time()), mid),
    )
    conn.commit()
    conn.close()
    return {
        "audio_url": meta["audio_url"],
        "total_duration_ms": meta["total_duration_ms"],
    }


# --- Playlists (backend ready; frontend wiring later) ---
@app.get("/api/v1/playlists")
def list_playlists():
    conn = db()
    rows = conn.execute("SELECT * FROM playlists ORDER BY created_at").fetchall()
    out = []
    for r in rows:
        mids = [
            m["material_id"]
            for m in conn.execute(
                "SELECT pm.material_id FROM playlist_materials pm "
                "JOIN materials m ON m.id = pm.material_id "
                "WHERE pm.playlist_id = ? ORDER BY pm.position",
                (r["id"],),
            )
        ]
        out.append({"id": r["id"], "name": r["name"], "materialIds": mids})
    conn.close()
    return out


@app.post("/api/v1/playlists")
def create_playlist(p: PlaylistIn):
    pid = "pl-" + uuid.uuid4().hex[:8]
    conn = db()
    conn.execute("INSERT INTO playlists (id, name, created_at) VALUES (?,?,?)", (pid, p.name, int(time.time())))
    conn.commit()
    conn.close()
    return {"id": pid, "name": p.name, "materialIds": []}


@app.patch("/api/v1/playlists/{pid}")
def rename_playlist(pid: str, p: PlaylistIn):
    conn = db()
    conn.execute("UPDATE playlists SET name = ? WHERE id = ?", (p.name, pid))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/v1/playlists/{pid}")
def delete_playlist(pid: str):
    conn = db()
    conn.execute("DELETE FROM playlists WHERE id = ?", (pid,))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/v1/playlists/{pid}/materials")
def add_to_playlist(pid: str, p: PlaylistMaterialIn):
    conn = db()
    conn.execute("INSERT OR IGNORE INTO playlist_materials (playlist_id, material_id, position) VALUES (?,?,?)",
                 (pid, p.material_id, int(time.time())))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.delete("/api/v1/playlists/{pid}/materials/{mid}")
def remove_from_playlist(pid: str, mid: str):
    conn = db()
    conn.execute("DELETE FROM playlist_materials WHERE playlist_id = ? AND material_id = ?", (pid, mid))
    conn.commit()
    conn.close()
    return {"ok": True}


# --- Learning profile generation (LLM-assisted; config travels in the request) ---
class ProfileGenIn(_BM):
    role: str = ""
    domain: str = ""
    language: str = "en-zh"
    scenarios: list[str] = []
    focus: str = ""
    llm_config: dict = {}


class LLMProfileOut(_BM):
    role_portrait: str
    domain_profile: str
    focus_tone: str


PROFILE_SYSTEM_PROMPT = """你是 TELG 学习档案生成器，根据用户提供的画像信息，生成一份结构化学习档案。

## 输出契约（硬约束）
- 只输出合法 JSON 对象：{"role_portrait": "…", "domain_profile": "…", "focus_tone": "…"}，禁止任何其他内容。
- role_portrait：基于用户职位/角色，扩写为 2-3 句的专业画像（该角色的工作语境、常用沟通对象、典型英文表达需求），英文。
- domain_profile：基于用户练习领域，扩写为 3-4 句领域档案（该领域技术术语惯例、典型工作场景、角色画像；领域术语准确、宁浅勿错），英文。
- focus_tone：基于用户的专注方向与练习场景，给出 1-2 句训练建议与语气偏好（如 interview 场景偏问答层层深入、meeting 偏汇报陈述），英文。
- 未提供的字段（如无 focus）对应输出保持简洁，不编造。

请直接输出 JSON。"""


@app.post("/api/v1/config/profile/generate")
def profile_generate(c: ProfileGenIn):
    if not (c.role.strip() or c.domain.strip()):
        raise HTTPException(400, "role or domain is required")
    cfg = c.llm_config or {}
    base, key, model = _llm_endpoint(cfg)
    lang_label = {"en-zh": "English + Chinese", "ja-zh": "Japanese + Chinese", "other": "other"}.get(c.language, c.language)
    sc_label = {"interview": "technical interview", "meeting": "meeting presentation", "collab": "team collaboration",
                "supplier": "supplier communication", "class": "classroom teaching"}.get((c.scenarios or [""])[0], ", ".join(c.scenarios or []))
    user = (
        "## 用户画像\n"
        "- 职位/角色：" + (c.role or "—") + "\n"
        "- 主要练习领域：" + (c.domain or "—") + "\n"
        "- 语言方向：" + lang_label + "\n"
        "- 练习场景：" + sc_label + ("\n" if c.scenarios else "") + "\n"
        "- 专注方向：" + (c.focus or "—")
    )
    if not key:
        raise HTTPException(400, "LLM API key not configured — configure it in Settings (Apply) first")
    try:
        key.encode("ascii")
    except UnicodeEncodeError:
        raise HTTPException(400, "api_key contains non-ASCII characters (placeholder?) — enter a real key")
    try:
        client = OpenAI(base_url=base, api_key=key, timeout=60)
        errors = []
        for attempt in range(3):
            u = user
            if errors:
                u += "\n\n## 校验失败反馈\n你上次输出未通过校验：\n" + "\n".join(errors) + "\n请只修正问题并重新输出完整 JSON。"
            try:
                resp = client.chat.completions.create(
                    model=model, temperature=0.4, max_tokens=700,
                    response_format={"type": "json_object"},
                    messages=[{"role": "system", "content": PROFILE_SYSTEM_PROMPT}, {"role": "user", "content": u}],
                )
                raw = (resp.choices[0].message.content or "").strip()
                data = json.loads(raw)
                out = LLMProfileOut.model_validate(data)
                try:
                    us = getattr(resp, "usage", None)
                    if us:
                        con = db()
                        con.execute(
                            "INSERT INTO llm_usage(provider, model, action, prompt_tokens, completion_tokens, total_tokens)"
                            " VALUES(?,?,?,?,?,?)",
                            ((cfg.get("provider") or "openai-compatible"), model, "profile-generate",
                             int(getattr(us, "prompt_tokens", 0) or 0), int(getattr(us, "completion_tokens", 0) or 0),
                             int(getattr(us, "total_tokens", 0) or 0)),
                        )
                        con.commit()
                        con.close()
                except Exception:  # noqa: BLE001
                    pass
                return out.model_dump()
            except Exception as e:  # noqa: BLE001
                errors.append("%s" % e)
        raise HTTPException(502, "Profile generation failed after 3 attempts: " + " | ".join(errors[-2:]))
    except LLMGenerationError as e:
        raise HTTPException(502, str(e)) from e


# --- Provider connectivity tests (config stays in the request; never persisted) ---
@app.post("/api/v1/config/test-llm")
def test_llm(c: TestLLMIn):
    base = (c.base_url or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "error": "base_url is empty"}
    if not re.match(r"^https?://", base, re.I):
        return {"ok": False, "error": "base_url must start with http:// or https://"}
    api_key = (c.api_key or "").strip()
    if not api_key:
        return {"ok": False, "error": "api_key is empty"}
    try:
        api_key.encode("ascii")
    except UnicodeEncodeError:
        return {"ok": False, "error": "api_key contains non-ASCII characters (placeholder?) — enter a real key"}
    url = base + "/chat/completions"
    payload = {
        "model": c.model or DEFAULT_LLM_MODEL,
        "messages": [{"role": "user", "content": "Reply with exactly: ok"}],
        "max_tokens": 8,
        "temperature": c.temperature or 0.2,
    }
    t0 = time.time()
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode("utf-8"))
        # Record usage from the connectivity probe (max_tokens=8, negligible).
        try:
            u = body.get("usage") or {}
            total = int(u.get("total_tokens") or 0)
            if total:
                con = db()
                con.execute(
                    "INSERT INTO llm_usage(provider, model, action, prompt_tokens, completion_tokens, total_tokens)"
                    " VALUES(?,?,?,?,?,?)",
                    ((c.provider or "openai-compatible"), (c.model or DEFAULT_LLM_MODEL), "test-llm",
                     int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0), total),
                )
                con.commit()
        except Exception:  # noqa: BLE001
            pass
        return {
            "ok": True,
            "latency_ms": int((time.time() - t0) * 1000),
            "model": body.get("model") or c.model,
        }
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:200]
        except Exception:
            pass
        code = e.code
        if code in (401, 403):
            msg = "Invalid API key (HTTP %d) — check the key" % code
        elif code == 404:
            msg = "Endpoint not found (HTTP 404) — check base_url" + (" · " + detail if detail else "")
        elif code == 400:
            msg = "Bad request (HTTP 400) — model not found? " + (detail if detail else "")
        else:
            msg = "HTTP %d: %s" % (code, detail)
        return {"ok": False, "latency_ms": int((time.time() - t0) * 1000), "error": msg}
    except (urllib.error.URLError, TimeoutError, socket.timeout) as e:
        return {"ok": False, "latency_ms": int((time.time() - t0) * 1000), "error": "Cannot reach %s — check base_url / network (%s)" % (base, str(e)[:120])}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "latency_ms": int((time.time() - t0) * 1000), "error": str(e)[:300]}


@app.post("/api/v1/config/test-generate")
def test_generate(c: TestLLMIn):
    # Real full generation pipeline (prompt + LLM + validation + retry + timeline),
    # fixed reproducible parameters, NOT persisted. Used to debug the LLM itself.
    p = GenerateIn(
        topic="Tire Burst Stability Control",
        domain="automotive", domainLabel="Automotive Engineering",
        format="dialogue", asymmetric=True,
        roles={"lead": "Vehicle Dynamics Lead", "respond": "Controls Engineer"},
        context="Design review trade-off on burst-tire stability compensation: response time vs calibration conservatism",
        difficulty=3, length="120",
        advanced={"depth": 3, "breadth": 2, "tone": "neutral", "injections": "Stress lateral acceleration and yaw moment feedback"},
        llm_config={"base_url": c.base_url, "api_key": c.api_key, "model": c.model, "temperature": c.temperature},
    )
    t0 = time.time()
    try:
        art = build_artifact(p)
    except HTTPException as e:
        return {"ok": False, "error": str(e.detail)}
    except LLMGenerationError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "unexpected: %s" % e}
    segs = art.get("dialogue", [])
    words = sum(len(re.findall(r"[a-zA-Z']+", s.get("text_en", ""))) for s in segs)
    return {
        "ok": True,
        "latency_ms": int((time.time() - t0) * 1000),
        "segs": len(segs),
        "words": words,
        "total_ms": art.get("meta", {}).get("total_duration_ms", 0),
        "difficulty": art.get("meta", {}).get("difficulty"),
        "title": art.get("meta", {}).get("title"),
        "background": bool(art.get("background")),
        "vocab": len(art.get("vocabulary", [])),
        "questions": len(art.get("listening_questions", [])),
        "patterns": len(art.get("core_sentence_patterns", [])),
    }


@app.post("/api/v1/config/prompt-preview")
def prompt_preview(c: GenerateIn):
    """Preview the exact system + user prompt that WOULD be sent to the LLM
    for the given generation parameters. Pure prompt assembly — no LLM call,
    no DB writes. Used by the LLM Mock debug panel to inspect the pipeline."""
    try:
        user = build_user_prompt(c, "generate")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}
    return {"ok": True, "system": LLM_SYSTEM_PROMPT, "user": user, "action": "generate"}


@app.post("/api/v1/config/unlock-dev")
def unlock_dev(c: dict):
    # Dev-only debug tools (Generation Debug + Test Mode) are hidden in release
    # builds; entering the unlock key reveals them.
    provided = str((c or {}).get("key") or "").strip()
    expected = os.environ.get("TELG_DEV_KEY", "telg-dev")
    if not expected:
        return {"ok": False, "error": "dev unlock disabled on this instance"}
    if provided != expected:
        return {"ok": False, "error": "invalid key"}
    return {"ok": True}


@app.get("/api/v1/usage")
def usage_stats(granularity: str = "week", offset_days: int = 0):
    """LLM token usage aggregation: total / today / per-bucket / per-action.

    granularity: day (natural day by hour) | week (Mon–Sun) | month (calendar month) | year (calendar year).
    offset_days: 0 = current window; N>0 = window N days earlier (day-granular pan).
    """
    conn = db()
    def row_sum(where: str, params: tuple = ()):
        r = conn.execute(
            "SELECT COUNT(*) AS calls,"
            " COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0), COALESCE(SUM(total_tokens),0)"
            " FROM llm_usage WHERE " + where, params).fetchone()
        return {"calls": r[0], "prompt_tokens": r[1], "completion_tokens": r[2], "total_tokens": r[3]}

    total = row_sum("1=1")
    today = row_sum("date(created_at) = date('now','localtime')")

    g = granularity if granularity in ("day", "week", "month", "year") else "week"
    od = max(0, int(offset_days))
    anchor = f"date('now','localtime','-{od} days')"
    if g == "day":
        start = end = anchor
        sql = (f"SELECT strftime('%H', created_at) AS k, COALESCE(SUM(total_tokens),0), COUNT(*)"
               f" FROM llm_usage WHERE date(created_at) = {start} GROUP BY k")
        label = lambda k: "%02d:00" % int(k)
        win_label = lambda s, e: s
    elif g == "week":
        start = f"date({anchor},'weekday 1')"
        end = f"date({start},'+6 days')"
        sql = (f"SELECT date(created_at) AS k, COALESCE(SUM(total_tokens),0), COUNT(*)"
               f" FROM llm_usage WHERE date(created_at) BETWEEN {start} AND {end} GROUP BY k")
        label = lambda k: k
        win_label = lambda s, e: "%s – %s" % (s[5:], e[5:])
    elif g == "month":
        start = f"date({anchor},'start of month')"
        end = f"date({start},'+1 month','-1 day')"
        sql = (f"SELECT date(created_at) AS k, COALESCE(SUM(total_tokens),0), COUNT(*)"
               f" FROM llm_usage WHERE date(created_at) BETWEEN {start} AND {end} GROUP BY k")
        label = lambda k: k
        win_label = lambda s, e: s[:7]
    else:  # year
        start = f"date({anchor},'start of year')"
        end = f"date({start},'+1 year','-1 day')"
        sql = (f"SELECT strftime('%Y-%m', created_at) AS k, COALESCE(SUM(total_tokens),0), COUNT(*)"
               f" FROM llm_usage WHERE date(created_at) BETWEEN {start} AND {end} GROUP BY k")
        label = lambda k: k
        win_label = lambda s, e: s[:4]
    s0 = conn.execute("SELECT " + start).fetchone()[0]
    e0 = conn.execute("SELECT " + end).fetchone()[0]
    buckets = [
        {"key": r[0], "label": label(r[0]), "total_tokens": r[1], "calls": r[2]}
        for r in conn.execute(sql).fetchall()
    ]
    buckets.sort(key=lambda b: b["key"])
    breakdown = {r[0]: r[1] for r in conn.execute(
        "SELECT action, COUNT(*) FROM llm_usage GROUP BY action").fetchall()}
    conn.close()
    return {"ok": True, "granularity": g, "offset_days": od,
            "window": {"start": s0, "end": e0, "label": win_label(s0, e0)},
            "total": total, "today": today, "buckets": buckets,
            "breakdown": breakdown, "mock": False}


@app.get("/api/v1/tts/voices")
def tts_voices(provider: str = "edge-tts"):
    """Available voices for a TTS provider, so the frontend can render the
    role list dynamically (edge-tts hardcoded list; Kokoro read from model)."""
    try:
        return {"ok": True, "provider": provider,
                "voices": get_engine(provider).available_voices()}
    except TTSModelMissing as e:
        return {"ok": False, "error_class": "model_missing", "error": str(e)[:300]}


# TTS audition result cache: key -> (timestamp, result). Bounded LRU so it
# cannot grow forever; 24h TTL only protects against re-synthesising the exact
# same input, it does NOT make first synthesis fast (see test_tts).
# Note: audition latency is dominated by synthesis itself — edge-tts pays a
# ~1-3s WebSocket handshake per synthesis, Kokoro pays CPU inference time
# (~1-3s for a sentence on typical hardware). The cache only skips repeats.
from collections import OrderedDict
_TTS_TEST_CACHE: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_TTS_TEST_TTL = 24 * 3600.0
_TTS_TEST_MAX = 100


def _tts_cache_get(key: str):
    hit = _TTS_TEST_CACHE.get(key)
    if not hit or time.time() - hit[0] >= _TTS_TEST_TTL:
        return None
    _TTS_TEST_CACHE.move_to_end(key)
    return hit[1]


def _tts_cache_put(key: str, result: dict) -> None:
    _TTS_TEST_CACHE[key] = (time.time(), result)
    _TTS_TEST_CACHE.move_to_end(key)
    while len(_TTS_TEST_CACHE) > _TTS_TEST_MAX:
        _TTS_TEST_CACHE.popitem(last=False)


def _cleanup_test_audio(older_than: float = 24 * 3600.0) -> None:
    """Remove stale audition clips so storage/audio cannot grow unbounded."""
    try:
        now = time.time()
        for p in STORAGE_DIR.glob("test_*.*") if STORAGE_DIR.exists() else []:
            try:
                if now - p.stat().st_mtime > older_than:
                    p.unlink()
            except OSError:
                pass
    except OSError:
        pass


@app.post("/api/v1/config/test-tts")
async def test_tts(c: TestTTSIn):
    engine = get_engine(c.provider)
    # Repeated auditions of the same (provider, voice, rate, text) hit the cache,
    # since edge-tts pays a ~1-3s WebSocket handshake on every first synthesis.
    key = "%s|%s|%s|%s" % (c.provider, c.voice or "", c.speech_rate or 1.0, c.text or "")
    key = hashlib.md5(key.encode()).hexdigest()
    cached = _tts_cache_get(key)
    if cached is not None:
        return cached
    try:
        engine.ensure_loaded()
    except TTSModelMissing as e:
        return {"ok": False, "error_class": "model_missing", "error": str(e)[:300]}
    if engine.name == "edge-tts":
        voice = normalize_voice((c.voice or "").split("+")[0])
    else:
        voice = (c.voice or "").strip() or "af_bella"
    rate = max(0.5, min(2.0, c.speech_rate or 1.0))
    text = (c.text or "").strip() or "Technical English, grounded in real engineering. 以真实技术知识为背景，以英语为训练载体。"
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    suffix = ".mp3" if engine.name == "edge-tts" else ".wav"
    out = STORAGE_DIR / ("test_%d%s" % (int(time.time() * 1000), suffix))
    try:
        if engine.name == "edge-tts":
            import edge_tts
            com = edge_tts.Communicate(text, voice=voice, rate="%+d%%" % int((rate - 1.0) * 100))
            await com.save(str(out))
        else:
            import soundfile as sf
            samples, sr = await asyncio.to_thread(engine._kokoro.create, text, voice=voice, speed=rate)
            sf.write(str(out), samples, sr, subtype="PCM_16")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error_class": tts_error_class(e), "error": str(e)[:300]}
    result = {"ok": True, "audio_url": "/api/v1/audio/" + out.name, "voice": voice}
    _tts_cache_put(key, result)
    return result


# ---------- Onboarding (profile + recommendations in one LLM call) ----------

class OnboardGenIn(_BM):
    role: str = ""
    domain: str = ""
    language: str = "en-zh"
    focus: str = ""
    minutes: int = 0
    llm_config: dict = {}


class OnboardGenOut(_BM):
    role_portrait: str
    domain_profile: str
    focus_tone: str
    domains: list[RecDomainOut]
    roles: list[str]
    scenarios: list[str]


ONBOARD_SYSTEM_PROMPT = """你是 TELG 听力素材生成器的一次性初始化引擎，根据用户问卷回答，同时生成「学习档案」与「推荐配置」。

## 输出契约（硬约束）
- 只输出合法 JSON 对象：
  {"role_portrait": "…", "domain_profile": "…", "focus_tone": "…",
   "domains": [{"id": "…", "name": "…", "desc": "…"}], "roles": ["…"], "scenarios": ["…"]}
- role_portrait：基于用户职位/角色，扩写为 2-3 句专业画像（工作语境、沟通对象、典型英文表达需求），英文。
- domain_profile：基于用户练习领域，扩写为 3-4 句领域档案（术语惯例、典型工作场景、角色画像；术语准确宁浅勿错），英文。
- focus_tone：基于专注方向与练习场景，给出 1-2 句训练建议与语气偏好，英文。
- domains：4-6 个与该用户紧密相关的技术领域，第一个必须是主练习领域；id 用 kebab-case 小写英文标识（若与内置领域 automotive/semiconductor/energy/ai-software/medical/fintech/aerospace/general 匹配则沿用），name 为英文领域名，desc 为不超过 20 字的中文描述。
- roles：3-6 个该领域研发一线真实岗位（英文岗位名，如 Process Engineer）。
- scenarios：3-6 个贴合该用户工作场景的英文练习场景短语（如 Process Review Meeting）。
- 严格贴合问卷中的角色、领域、语言方向与专注方向，禁止输出无关通用内容。

请直接输出 JSON。"""


@app.post("/api/v1/config/onboarding/generate")
def onboarding_generate(c: OnboardGenIn):
    if not (c.role.strip() or c.domain.strip()):
        raise HTTPException(400, "role or domain is required")
    cfg = c.llm_config or {}
    base, key, model = _llm_endpoint(cfg)
    lang_label = {"en-zh": "English + Chinese", "ja-zh": "Japanese + Chinese", "other": "other"}.get(c.language, c.language)
    user = (
        "## 用户问卷\n"
        "- 职位/角色：" + (c.role or "—") + "\n"
        "- 主要练习领域：" + (c.domain or "—") + "\n"
        "- 语言方向：" + lang_label + "\n"
        "- 每日练习时长目标：" + (str(c.minutes) + " 分钟" if c.minutes else "—") + "\n"
        "- 专注方向：" + (c.focus or "—")
    )
    if not key:
        raise HTTPException(400, "LLM API key not configured — configure it in Settings (Apply) first")
    try:
        key.encode("ascii")
    except UnicodeEncodeError:
        raise HTTPException(400, "api_key contains non-ASCII characters (placeholder?) — enter a real key")
    try:
        client = OpenAI(base_url=base, api_key=key, timeout=60)
        errors = []
        for attempt in range(3):
            u = user
            if errors:
                u += "\n\n## 校验失败反馈\n你上次输出未通过校验：\n" + "\n".join(errors) + "\n请只修正问题并重新输出完整 JSON。"
            try:
                resp = client.chat.completions.create(
                    model=model, temperature=0.4, max_tokens=1400,
                    response_format={"type": "json_object"},
                    messages=[{"role": "system", "content": ONBOARD_SYSTEM_PROMPT}, {"role": "user", "content": u}],
                )
                raw = (resp.choices[0].message.content or "").strip()
                data = json.loads(raw)
                out = OnboardGenOut.model_validate(data)
                if not out.roles or not out.scenarios or not out.domains:
                    raise ValueError("empty roles/scenarios/domains")
                for d in out.domains:
                    if not d.id.strip() or not d.name.strip():
                        raise ValueError("empty domain id/name")
                try:
                    us = getattr(resp, "usage", None)
                    if us:
                        con = db()
                        con.execute(
                            "INSERT INTO llm_usage(provider, model, action, prompt_tokens, completion_tokens, total_tokens)"
                            " VALUES(?,?,?,?,?,?)",
                            ((cfg.get("provider") or "openai-compatible"), model, "onboarding-generate",
                             int(getattr(us, "prompt_tokens", 0) or 0), int(getattr(us, "completion_tokens", 0) or 0),
                             int(getattr(us, "total_tokens", 0) or 0)),
                        )
                        con.commit()
                        con.close()
                except Exception:  # noqa: BLE001
                    pass
                return out.model_dump()
            except Exception as e:  # noqa: BLE001
                errors.append("%s" % e)
        raise HTTPException(502, "Onboarding generation failed after 3 attempts: " + " | ".join(errors[-2:]))
    except LLMGenerationError as e:
        raise HTTPException(502, str(e)) from e



# ---------- Recommendations (LLM-initialized domain/role/scenario presets) ----------

class RecsGenIn(_BM):
    role: str = ""
    domain: str = ""
    language: str = "en-zh"
    focus: str = ""
    role_portrait: str = ""
    domain_profile: str = ""
    focus_tone: str = ""
    llm_config: dict = {}


class RecDomainOut(_BM):
    id: str
    name: str
    desc: str = ""


class LLMRecsOut(_BM):
    domains: list[RecDomainOut]
    roles: list[str]
    scenarios: list[str]


RECOMMEND_SYSTEM_PROMPT = """你是 TELG 听力素材生成器的推荐配置引擎，根据用户的学习档案，为其推荐「领域 / 角色 / 场景」三组选项，作为新建素材弹窗的默认下拉选项。

## 输出契约（硬约束）
- 只输出合法 JSON 对象：{"domains": [...], "roles": [...], "scenarios": [...]}，禁止任何其他内容。
- domains：4-6 个与该用户紧密相关的技术领域，第一个必须是用户的主练习领域；每项 {"id": "kebab-case小写英文标识", "name": "英文领域名（如 Semiconductor）", "desc": "一句中文描述"}；id 若与已知内置领域（automotive/semiconductor/energy/ai-software/medical/fintech/aerospace/general）匹配则沿用内置 id，否则用 kebab-case 新 id；desc 不超过 20 字。
- roles：3-6 个该领域研发一线常见真实岗位（英文岗位名，如 Process Engineer、Yield Engineer），要求真实、专业、可对话。
- scenarios：3-6 个贴合该用户工作场景的英文练习场景短语（如 Process Review Meeting、Yield Failure RCA），真实可演。
- 严格贴合用户档案中的角色、领域、专注方向与画像，禁止输出与档案无关的通用内容。

请直接输出 JSON。"""


@app.post("/api/v1/config/recommendations/generate")
def recs_generate(c: RecsGenIn):
    if not (c.role.strip() or c.domain.strip()):
        raise HTTPException(400, "role or domain is required")
    cfg = c.llm_config or {}
    base, key, model = _llm_endpoint(cfg)
    lang_label = {"en-zh": "English + Chinese", "ja-zh": "Japanese + Chinese", "other": "other"}.get(c.language, c.language)
    user = (
        "## 学习档案\n"
        "- 职位/角色：" + (c.role or "—") + "\n"
        "- 主要练习领域：" + (c.domain or "—") + "\n"
        "- 语言方向：" + lang_label + "\n"
        "- 专注方向：" + (c.focus or "—") + "\n"
        "- 角色画像：" + (c.role_portrait or "—") + "\n"
        "- 领域档案：" + (c.domain_profile or "—") + "\n"
        "- 语气建议：" + (c.focus_tone or "—")
    )
    if not key:
        raise HTTPException(400, "LLM API key not configured — configure it in Settings (Apply) first")
    try:
        key.encode("ascii")
    except UnicodeEncodeError:
        raise HTTPException(400, "api_key contains non-ASCII characters (placeholder?) — enter a real key")
    try:
        client = OpenAI(base_url=base, api_key=key, timeout=60)
        errors = []
        for attempt in range(3):
            u = user
            if errors:
                u += "\n\n## 校验失败反馈\n你上次输出未通过校验：\n" + "\n".join(errors) + "\n请只修正问题并重新输出完整 JSON。"
            try:
                resp = client.chat.completions.create(
                    model=model, temperature=0.4, max_tokens=900,
                    response_format={"type": "json_object"},
                    messages=[{"role": "system", "content": RECOMMEND_SYSTEM_PROMPT}, {"role": "user", "content": u}],
                )
                raw = (resp.choices[0].message.content or "").strip()
                data = json.loads(raw)
                out = LLMRecsOut.model_validate(data)
                if not out.roles or not out.scenarios or not out.domains:
                    raise ValueError("empty roles/scenarios/domains")
                for d in out.domains:
                    if not d.id.strip() or not d.name.strip():
                        raise ValueError("empty domain id/name")
                try:
                    us = getattr(resp, "usage", None)
                    if us:
                        con = db()
                        con.execute(
                            "INSERT INTO llm_usage(provider, model, action, prompt_tokens, completion_tokens, total_tokens)"
                            " VALUES(?,?,?,?,?,?)",
                            ((cfg.get("provider") or "openai-compatible"), model, "recs-generate",
                             int(getattr(us, "prompt_tokens", 0) or 0), int(getattr(us, "completion_tokens", 0) or 0),
                             int(getattr(us, "total_tokens", 0) or 0)),
                        )
                        con.commit()
                        con.close()
                except Exception:  # noqa: BLE001
                    pass
                return out.model_dump()
            except Exception as e:  # noqa: BLE001
                errors.append("%s" % e)
        raise HTTPException(502, "Recommendation generation failed after 3 attempts: " + " | ".join(errors[-2:]))
    except LLMGenerationError as e:
        raise HTTPException(502, str(e)) from e

# --- Static frontend + audio (same origin → no CORS / no file:// fetch issue) ---
STORAGE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/v1/audio", StaticFiles(directory=str(STORAGE_DIR)), name="audio")


init_db()
_cleanup_test_audio()  # drop audition clips older than 24h on startup


def _warmup_kokoro() -> None:
    """Pre-load the Kokoro model in the background so the first audition /
    synthesis does not pay the ~1-3s model-load cost on top of inference."""
    try:
        eng = get_engine("kokoro")
        if all((eng.cache_dir / f).exists() for f in KokoroEngine.FILES):
            threading.Thread(target=eng.ensure_loaded, daemon=True).start()
    except Exception:  # noqa: BLE001 — warm-up must never block startup
        pass


_warmup_kokoro()
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import sys

    # --- Startup self-check: print actionable hints instead of a bare crash ---
    missing = []
    for mod, pip in (("fastapi", "fastapi"), ("uvicorn", "uvicorn"),
                     ("openai", "openai"), ("edge_tts", "edge-tts")):
        try:
            __import__(mod)
        except ImportError:
            missing.append(pip)
    if missing:
        print("=" * 60)
        print("[TELG] Missing dependencies: " + ", ".join(missing))
        print("       Install them first (inside the virtual env):")
        print("       pip install " + " ".join(missing))
        print("       If you already ran pip install, the virtual env is")
        print("       probably not activated — activate it, then retry.")
        print("=" * 60)
        sys.exit(1)
    import shutil
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("=" * 60)
        print("[TELG] WARNING: ffmpeg/ffprobe not found on PATH.")
        print("       TTS synthesis (audio merge & duration probe) will fail.")
        print("       Windows:  winget install Gyan.FFmpeg   (then reopen terminal)")
        print("       Linux:    sudo apt install ffmpeg")
        print("       macOS:    brew install ffmpeg")
        print("=" * 60)

    import uvicorn
    try:
        uvicorn.run(app, host="127.0.0.1", port=8000)
    except OSError as e:
        print("=" * 60)
        print("[TELG] Failed to bind port 8000: %s" % e)
        print("       Port may be in use. Check: netstat -ano | findstr :8000")
        print("       Kill the occupying PID, or change 'port=8000' above.")
        print("=" * 60)
        sys.exit(1)


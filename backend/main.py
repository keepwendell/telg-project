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

import json
import os
import re
import socket
import sqlite3
import subprocess
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
  options TEXT,                                -- JSON array
  answer TEXT, explain TEXT
);
CREATE TABLE IF NOT EXISTS core_sentence_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  title TEXT, pattern TEXT, example TEXT
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
    conn.commit()
    seed(conn)
    migrate_audio_status(conn)
    conn.close()


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
    mid = art["id"]
    now = int(time.time())
    conn.execute(
        """INSERT OR REPLACE INTO materials
           (id,title,topic,domain,role,scenario,dialogue_type,difficulty,length,
            llm_provider,tts_provider,voice,depth,breadth,tone,status,audio_url,
            total_duration_ms,tag,"filter",meta_json,technical_background,
            technical_principle,engineering_scenario,created_at,updated_at,version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
            now,
            now,
            1,
        ),
    )
    for i, s in enumerate(art.get("dialogue", [])):
        conn.execute(
            """INSERT INTO dialogue_segments
               (material_id,seq,speaker,role,voice,text_en,text_zh,start_ms,end_ms)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                mid, i, s.get("speaker"), s.get("role"), s.get("voice"),
                s.get("text_en"), s.get("text_zh"),
                int(s.get("start_ms", 0) or 0), int(s.get("end_ms", 0) or 0),
            ),
        )
    for v in art.get("vocabulary", []):
        conn.execute(
            "INSERT INTO vocabulary (material_id,en,zh,symbol,def) VALUES (?,?,?,?,?)",
            (mid, v.get("en"), v.get("zh"), v.get("symbol"), v.get("def")),
        )
    for q in art.get("listening_questions", []):
        conn.execute(
            "INSERT INTO listening_questions (material_id,q,options,answer,explain) VALUES (?,?,?,?,?)",
            (mid, q.get("q"), json.dumps(q.get("options", [])), q.get("answer"), q.get("explain")),
        )
    for p in art.get("core_sentence_patterns", []):
        conn.execute(
            "INSERT INTO core_sentence_patterns (material_id,title,pattern,example) VALUES (?,?,?,?)",
            (mid, p.get("title"), p.get("pattern"), p.get("example")),
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
            {"q": q["q"], "options": json.loads(q["options"] or "[]"), "answer": q["answer"], "explain": q["explain"]}
            for q in qs
        ],
        "core_sentence_patterns": [
            {"title": p["title"], "pattern": p["pattern"], "example": p["example"]} for p in pats
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


TEMPLATE_DIALOGUE = [
    {"speaker": "Engineer A", "role": "System Lead", "text_en": "Let's walk through the current {topic} baseline and see where the margin is.", "text_zh": "我们先过一遍当前 {topic} 的基线，看看裕度在哪里。"},
    {"speaker": "Engineer B", "role": "Controls", "text_en": "The key constraint is response time — we only have a narrow window before the condition escalates.", "text_zh": "关键约束是响应时间——在状况恶化之前，我们只有很窄的时间窗口。"},
    {"speaker": "Engineer A", "role": "System Lead", "text_en": "Right. So the compensation logic should trigger from the sensor estimate, not wait for the effect to show up.", "text_zh": "对。所以补偿逻辑应基于传感器估计触发，而不是等效应显现出来。"},
    {"speaker": "Engineer B", "role": "Controls", "text_en": "Agreed, but we still need to verify it under the worst-case load, including degraded sensor quality.", "text_zh": "同意，但我们仍要在最恶劣工况下验证，包括传感器质量退化的情况。"},
    {"speaker": "Engineer A", "role": "System Lead", "text_en": "Then we close the loop with a conservative calibration and validate it on the HIL bench this week.", "text_zh": "那我们就用保守标定闭环，本周在 HIL 台架上做验证。"},
    {"speaker": "Engineer B", "role": "Controls", "text_en": "Sounds good. Let's track the margin over time and review it again at the next design review.", "text_zh": "可以。我们持续跟踪裕度变化，下次设计评审再回顾一次。"},
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
    {"q": "What is the key constraint mentioned at the start of the discussion?", "options": ["Cost of the hardware", "Response time window", "Fuel efficiency", "Software license"], "answer": "Response time window", "explain": "Engineer B: 'The key constraint is response time — we only have a narrow window before the condition escalates.'"},
    {"q": "How should the compensation logic be triggered?", "options": ["By waiting for the effect to appear", "By a manual operator switch", "From the sensor estimate", "On a fixed timer"], "answer": "From the sensor estimate", "explain": "Engineer A: 'So the compensation logic should trigger from the sensor estimate, not wait for the effect to show up.'"},
    {"q": "Where will the final validation be performed this week?", "options": ["On the HIL bench", "On the public road", "In a thermal chamber", "In simulation only"], "answer": "On the HIL bench", "explain": "Engineer A: 'validate it on the HIL bench this week.'"},
]
TEMPLATE_PATTERNS = [
    {"title": "Constraint Statement", "pattern": "The key constraint is [X] — we only have [limit] before [condition].", "example": "The key constraint is power draw — we only have 2 seconds before the cell overheats."},
    {"title": "Trigger Decision", "pattern": "So the [logic] should trigger from the [signal], not wait for the [effect].", "example": "So the limiter should trigger from the torque estimate, not wait for the overspeed."},
    {"title": "Verification Plan", "pattern": "Then we close the loop with [approach] and validate it on [rig] this week.", "example": "Then we close the loop with a soft ramp and validate it on the dyno this week."},
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
    art["meta"]["role"] = p.role or base["meta"]["role"]
    art["meta"]["scenario"] = p.scenario or base["meta"]["scenario"]
    art["meta"]["dialogue_type"] = re.sub(r"[^a-z]+", "_", (p.scenario or "").lower())
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
    if art.get("dialogue") and not art["dialogue"][0].get("start_ms"):
        estimate_timeline(art["dialogue"], art["meta"]["total_duration_ms"] or 120000)
    return art


# ----------------------------------------------------------------------------
# LLM engine (Phase 2 — real generation via OpenAI-compatible API)
# ----------------------------------------------------------------------------
LENGTH_WORDS = {60: 140, 90: 215, 120: 290, 180: 435, 240: 580}

DIFFICULTY_DEFS = {
    1: "简单短句，技术词汇密度低，每句 8-15 词，含义直白无隐含。",
    2: "标准工程词汇，术语偶尔出现且伴随解释，每句 10-20 词。",
    3: "真实工程师讨论：术语密集但有上下文支撑，含权衡与因果推理，每句 12-25 词。",
    4: "高密度技术交流：术语不加解释、隐含推理、复杂从句，每句 15-30 词。",
    5: "主审级评审：快速轮转、隐含含义、跨域引用、常省略主语，每句 18-35 词。",
}

BREADTH_DEFS = {
    1: "单人讲解：一个工程师系统讲解（speaker 统一用 \"Engineer\"）。",
    2: "双人技术讨论：两位工程师一问一答推进（Engineer A / Engineer B）。",
    3: "三人小组讨论：加入测试/仿真第三视角，围绕同一问题多轮交锋（Engineer A/B/C）。",
    4: "跨团队评审：动力、控制、安全等不同岗位协作决策（用具体岗位名作 speaker）。",
    5: "全链路多方：从开发、整车集成到量产/供应商多视角，体现端到端权衡（多岗位轮转）。",
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

LLM_SYSTEM_PROMPT = """你是资深技术英语听力素材生成器，面向汽车、智能驾驶、底盘控制、控制算法与嵌入式软件等研发工程师。根据用户给定的技术主题与参数，生成一套真实、自然、可直接用于听力训练的双语技术对话。

## 输出格式（必须严格输出 JSON 对象，禁止任何多余文字、Markdown 代码块或注释）
{
  "background": {
    "technical_background": "...",   // 英文：该主题工程背景，2-3 句
    "technical_principle": "...",    // 英文：核心技术原理，2-3 句，可含公式符号如 C_α
    "engineering_scenario": "..."    // 英文：这段对话发生在什么工作场景，1-2 句
  },
  "dialogue": [
    {"speaker": "...", "role": "...", "text_en": "...", "text_zh": "..."}
  ],
  "vocabulary": [
    {"en": "...", "zh": "...", "symbol": "...", "def": "..."}
  ],
  "listening_questions": [
    {"q": "...", "options": ["...", "...", "..."], "answer": "正确选项的完整原文", "explain": "答案出自哪句台词"}
  ],
  "core_sentence_patterns": [
    {"title": "...", "pattern": "...", "example": "..."}
  ]
}

## 内容要求（Technical Grounding）
- 必须围绕主题使用真实工程概念与术语，严禁编造明显错误的工程原理。
- 对话要有具体信息量：数据、时序、参数、权衡、因果，不要空泛寒暄。
- text_en 必须是地道工程英语：自然口语、带真实工程师讨论的口吻与语气词。
- 严禁教科书腔与 "Today we are going to talk about..." 式生硬开头。
- text_zh 是 text_en 的准确中文翻译，工程术语用标准译法。
- dialogue 中不要出现 start_ms/end_ms/voice 等字段。

## 参数控制
- 英语难度 L{difficulty}：{difficulty_def}
- 对话广度 B{breadth}：{breadth_def}
- 技术深度：{depth_def}
- 语气：{tone_def}
- 目标总词数：约 {words} 词（按对话轮数合理分配，宁精勿灌水）
- 特殊要求：{injections}

## 对话结构（根据 Scenario 决定说话人数与角色，必须严格遵守）
- 单人技术讲解/汇报场景（Scenario 为 Single Technical Deep-Dive、Technical Presentation 等）：dialogue 只包含 1 个 speaker，role 为该场景角色（如 Vehicle Dynamics Engineer），全程一人连贯讲解，可带少量自问自答，但不要出现第二个人名或 Interviewer/Candidate 角色。
- 技术面试场景（Scenario 为 Staff Systems Technical Interview、Interview 等）：dialogue 恰好 2 个 speaker，role 分别为 Interviewer 与 Candidate，一问一答。
- 其余场景（讨论、评审、RCA 等）：dialogue 恰好 2 个 speaker，role 为对应工程师角色（如 Vehicle Dynamics Engineer、Controls Lead）。

请直接输出 JSON。"""


def build_user_prompt(p: GenerateIn) -> str:
    lines = [
        "请为以下主题生成一套技术英语听力素材。",
        "",
        "Topic: " + (p.topic or ""),
        "Domain: " + (p.domainLabel or p.domain or "Engineering"),
        "Role: " + (p.role or ""),
        "Scenario: " + (p.scenario or "Technical Discussion"),
        "Difficulty: Level " + str(p.difficulty),
        "Length: " + str(p.length) + " seconds",
    ]
    return "\n".join(lines)


# --- structured output validation ---
from pydantic import BaseModel as _BM, Field as _F  # noqa: E402


class LLMDialogue(_BM):
    speaker: str
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
    dialogue: list[LLMDialogue]
    vocabulary: list[LLMVocab]
    listening_questions: list[LLMQuestion]
    core_sentence_patterns: list[LLMPattern]


def validate_extra(art: LLMArtifact, p: GenerateIn) -> None:
    errs = []
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


def call_llm_with_retry(p: GenerateIn, action: str = "generate") -> dict:
    cfg = p.llm_config or {}
    base = (cfg.get("base_url") or os.environ.get("TELG_LLM_BASE") or "https://api.deepseek.com/v1").strip().rstrip("/")
    key = (cfg.get("api_key") or os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    model = (cfg.get("model") or os.environ.get("TELG_LLM_MODEL") or "deepseek-chat").strip()
    temp = float(cfg.get("temperature") or 0.7)
    if not key:
        raise LLMGenerationError("LLM API key not configured — set it in Settings (Apply) or export DEEPSEEK_API_KEY")
    try:
        key.encode("ascii")
    except UnicodeEncodeError:
        raise LLMGenerationError("api_key contains non-ASCII characters (placeholder?) — enter a real key")  # noqa: B904
    target_words = LENGTH_WORDS.get(parse_sec(p.length) or 120, 290)
    client = OpenAI(base_url=base, api_key=key, timeout=60)
    breadth = p.advanced.get("breadth", 2) if isinstance(p.advanced, dict) else 2
    system = (LLM_SYSTEM_PROMPT
              .replace("{difficulty}", str(p.difficulty))
              .replace("{difficulty_def}", DIFFICULTY_DEFS.get(p.difficulty, DIFFICULTY_DEFS[3]))
              .replace("{breadth}", str(breadth))
              .replace("{breadth_def}", BREADTH_DEFS.get(breadth, BREADTH_DEFS[2]))
              .replace("{depth_def}", DEPTH_DEFS.get(p.advanced.get("depth", 3), DEPTH_DEFS[3]) if isinstance(p.advanced, dict) else DEPTH_DEFS[3])
              .replace("{tone_def}", TONE_DEFS.get(p.advanced.get("tone", "neutral"), TONE_DEFS["neutral"]) if isinstance(p.advanced, dict) else TONE_DEFS["neutral"])
              .replace("{words}", str(target_words))
              .replace("{injections}", (p.advanced.get("injections") or "无") if isinstance(p.advanced, dict) else "无"))
    errors = []
    last_usage = None
    for attempt in range(3):
        user = build_user_prompt(p)
        if errors:
            user += "\n\n上一次输出校验失败：" + "\n".join(errors) + "\n请修正后重新输出完整 JSON。"
        try:
            resp = client.chat.completions.create(
                model=model,
                temperature=temp,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            )
            last_usage = getattr(resp, "usage", None)
            raw = (resp.choices[0].message.content or "").strip()
            data = json.loads(raw)
            art = LLMArtifact.model_validate(data)
            validate_extra(art, p)
            _record_usage(cfg, action, last_usage)
            return art.model_dump(by_alias=True)
        except Exception as e:  # noqa: BLE001
            errors.append("%s" % e)
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


def estimate_timeline(dialogue: list[dict], total_ms: int) -> None:
    words = [max(len(re.findall(r"[a-zA-Z']+", s.get("text_en", ""))), 3) for s in dialogue]
    total_words = max(sum(words), 1)
    gap = 300
    usable = max(total_ms - gap * (len(words) - 1), total_ms // 2)
    start = 0
    for i, w in enumerate(words):
        dur = int(round(usable * w / total_words))
        dialogue[i]["start_ms"] = start
        dialogue[i]["end_ms"] = start + dur
        start += dur + gap


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
    # Build a Generation Artifact from the real LLM (no DB writes).
    if p.test_mode or os.environ.get("TELG_MOCK_LLM") == "1":
        return mock_generate(p)
    try:
        payload = call_llm_with_retry(p, action)
    except LLMGenerationError as e:
        raise HTTPException(502, detail=str(e))  # noqa: B904
    sec = parse_sec(p.length) or 120
    total_ms = sec * 1000
    estimate_timeline(payload["dialogue"], total_ms)
    meta = {
        "title": p.topic or "Untitled", "topic": p.topic or "Untitled",
        "domain": p.domainLabel or p.domain or "Engineering", "role": p.role or "",
        "scenario": p.scenario or "Technical Discussion",
        "dialogue_type": re.sub(r"[^a-z]+", "_", (p.scenario or "").lower()),
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
        "dialogue": payload["dialogue"],
        "vocabulary": payload["vocabulary"],
        "listening_questions": payload["listening_questions"],
        "core_sentence_patterns": payload["core_sentence_patterns"],
    }


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
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    try:
        return int(round(float(p.stdout.strip()) * 1000))
    except ValueError:
        raise RuntimeError("ffprobe failed on %s" % path.name)  # noqa: TRY003


def probe_audio_fmt(path: Path) -> tuple[int, int]:
    """Return (sample_rate, channels) of an audio file for matching silence."""
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, timeout=30,
    )
    parts = p.stdout.strip().split(",")
    try:
        return int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return 24000, 1


def ensure_gap(out_dir: Path, sr: int, ch: int, gap_ms: int = 300) -> Path:
    """Reusable mp3 silence file matching the sentence audio format."""
    gp = out_dir / ("_gap_%d_%d_%d.mp3" % (sr, ch, gap_ms))
    if not gp.exists():
        subprocess.run(
            ["ffmpeg", "-y", "-f", "lavfi",
             "-i", "anullsrc=r=%d:cl=%s" % (sr, "stereo" if ch == 2 else "mono"),
             "-t", "%.3f" % (gap_ms / 1000.0), "-c:a", "libmp3lame", "-q:a", "9",
             str(gp)],
            capture_output=True, text=True, timeout=30, check=True,
        )
    return gp


def merge_mp3(out_dir: Path, mid: str, n: int, out: Path, gap: Path | None = None) -> None:
    """Concatenate per-sentence mp3s, inserting `gap` silence between sentences so the
    timeline (which accounts for the gap) matches the actual audio position."""
    lst = out_dir / (mid + "-concat.txt")
    with lst.open("w", encoding="utf-8") as fh:
        for i in range(n):
            seg = out_dir / ("%s-seg-%d.mp3" % (mid, i))
            if not seg.exists():
                raise RuntimeError("missing segment %s" % seg.name)
            fh.write("file '%s'\n" % seg.name.replace("'", "'\\''"))
            if gap is not None and i < n - 1:
                fh.write("file '%s'\n" % gap.name.replace("'", "'\\''"))
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
             "-c", "copy", str(out)],
            capture_output=True, text=True, timeout=120, check=True,
        )
    finally:
        lst.unlink(missing_ok=True)


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
    vs = [normalize_voice(v) for v in vs] or ["en-US-GuyNeural"]
    rate = body.rate if (body.rate is not None and 0.5 <= body.rate <= 2.0) else 1.0
    rate_arg = "%+d%%" % int((rate - 1.0) * 100)
    gap_ms = 300
    try:
        import edge_tts
    except ImportError:
        conn.close()
        raise HTTPException(500, "edge-tts not installed — run: pip install edge-tts")
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        times = []
        start = 0
        for i, seg in enumerate(segs):
            text = (seg["text_en"] or "").strip() or "…"
            voice = vs[i % len(vs)]
            seg_path = STORAGE_DIR / ("%s-seg-%d.mp3" % (mid, i))
            com = edge_tts.Communicate(text, voice=voice, rate=rate_arg)
            await com.save(str(seg_path))
            dur = probe_ms(seg_path)
            times.append((seg["seq"], start, start + dur))
            start += dur + gap_ms
        first_seg = STORAGE_DIR / ("%s-seg-0.mp3" % mid)
        sr, ch = probe_audio_fmt(first_seg) if first_seg.exists() else (24000, 1)
        gap = ensure_gap(STORAGE_DIR, sr, ch, gap_ms)
        out_path = STORAGE_DIR / (mid + ".mp3")
        merge_mp3(STORAGE_DIR, mid, len(segs), out_path, gap)
        for i in range(len(segs)):
            (STORAGE_DIR / ("%s-seg-%d.mp3" % (mid, i))).unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        conn.close()
        raise HTTPException(502, "TTS synthesis failed: %s" % e)
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
                "SELECT material_id FROM playlist_materials WHERE playlist_id = ? ORDER BY position",
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
        "model": c.model or "deepseek-chat",
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
        with urllib.request.urlopen(req, timeout=15) as r:
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
                    ((c.provider or "openai-compatible"), (c.model or "deepseek-chat"), "test-llm",
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
        role="Vehicle Dynamics Engineer",
        scenario="Technical Discussion & Trade-off",
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


@app.post("/api/v1/config/test-tts")
async def test_tts(c: TestTTSIn):
    try:
        import edge_tts
    except ImportError:
        return {"ok": False, "error": "edge-tts not installed — run: pip install edge-tts"}
    voice = normalize_voice((c.voice or "").split("+")[0])
    rate = max(0.5, min(2.0, c.speech_rate or 1.0))
    text = (c.text or "").strip() or "Technical English, grounded in real engineering. 以真实技术知识为背景，以英语为训练载体。"
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    out = STORAGE_DIR / ("test_%d.mp3" % int(time.time() * 1000))
    try:
        com = edge_tts.Communicate(text, voice=voice, rate="%+d%%" % int((rate - 1.0) * 100))
        await com.save(str(out))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:300]}
    return {"ok": True, "audio_url": "/api/v1/audio/" + out.name, "voice": voice}


# --- Static frontend + audio (same origin → no CORS / no file:// fetch issue) ---
STORAGE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/v1/audio", StaticFiles(directory=str(STORAGE_DIR)), name="audio")


init_db()
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

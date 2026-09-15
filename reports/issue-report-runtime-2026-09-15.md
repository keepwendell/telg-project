# TELG 运行时问题检查报告（Runtime Issue Report）

- 检查日期：2026-09-15
- 检查范围：后端可启动性、前后端契约、TTS 真实链路、种子数据一致性、文档/注释一致性
- 检查方式：静态审读 `backend/main.py` + 路径存在性验证（Python 实例化 StaticFiles）+ 前端三套 e2e 回归
- 基线：三套 e2e 全部通过（全链路 35/35、TTS 专项 10/10、边缘 11/11），前端 mock 链路健康

---

## 一、P1（阻断）：后端启动即崩溃 — 前端托管目录路径错误

**现象**：`python main.py` 无法启动，模块加载阶段即抛异常。

**复现**（Python 3.12）：
```
FRONTEND_DIR = BASE_DIR.parent / "telg"   # backend/../telg
>>> StaticFiles(directory='backend/../telg')
RuntimeError: Directory 'backend/../telg' does not exist
```

**根因**：`backend/main.py` 第 43 行 `FRONTEND_DIR = BASE_DIR.parent / "telg"`。
工程目录重组后前端位于 `frontend/`，`telg/` 目录已不存在；Starlette 的 `StaticFiles` 在
实例化时校验目录存在性（`backend/main.py` 第 1060 行 `app.mount("/", ...)` 在模块级执行），
因此 import/启动即失败。README 中「方式二：真实后端」步骤因此**当前不可执行**。

**影响**：真实 LLM/TTS 模式完全不可用；用户此前遇到的「HTML instead of JSON」也源于
`/api/v1` 未由 FastAPI 提供（后端根本没起来，被静态服务器兜底）。

**修复建议**：
```python
FRONTEND_DIR = BASE_DIR.parent / "frontend"
```
（同时确认 `STORAGE_DIR` 存在；`storage/audio/.gitkeep` 已保证目录存在。）

## 二、P2（功能缺口）：synthesize 为 stub，未接入真实 TTS

**现状**：`POST /api/v1/materials/{mid}/synthesize`（`main.py` 833-856 行）仅执行：
```python
meta["audio_url"] = "/api/v1/audio/" + mid + ".mp3"
meta["audioReady"] = True
status = "published" if ... else "audio_ready"
UPDATE materials SET meta_json=?, status=?
```
不调用 `edge_tts`、不生成任何 mp3、不回填真实 `start_ms/end_ms`。`requirements.txt` 已包含
`edge-tts`，但仅在 `test_tts` 诊断接口中使用。

**与产品目标的差距**：前端真实模式下点「合成」后得到的是一个指向不存在文件的 URL；
句级时间轴来自 LLM 阶段的 `estimate_timeline()`（按词数比例估算），并非 TTS 真实时长。
逐句 TTS → 拼接 → 回填时间轴的核心链路尚未落地（工程注释中描述为「Phase 3」遗留）。

**修复建议**（与 docs/architecture.md 的逐句方案一致）：
1. 逐句调用 `edge_tts.Communicate(text, voice, rate)`，每句产出独立音频文件；
2. 用 `ffprobe`/pydub 获取每段真实时长，句间插入可配置停顿（如 300ms）；
3. 按序拼接为 `storage/audio/{mid}.mp3`，回填 `dialogue_segments.start_ms/end_ms`；
4. `meta.total_duration_ms` 用真实总时长，`audioReady=True`。

## 三、P3（数据一致性）：种子素材标记已发布但无音频

**现状**：`seed()` 将 `seed_materials.json` 的 3 个素材以 `status="published"` 写入；
`artifact_of()` 中 `audioReady = status in ("audio_ready","published")` → 前端显示可播放；
但 `storage/audio/` 为空（仅有 .gitkeep），`/api/v1/audio/m1.mp3` 无文件 → 真实模式播放 404。

**修复建议**：方案 a（推荐）：种子素材入库时 `status="draft"` + `audioReady=False`，
用户首次打开按「未合成」状态展示，走合成后再生效；方案 b：种子初始化时同步生成真实音频。

## 四、P4（过时注释）：后端头部注释仍描述 mock 阶段

`backend/main.py` 头部注释：
> "Mock /generate and /synthesize so the full frontend loop can run with CONFIG.useMock = false before real LLM/TTS land in Phase 2/3"

现状：`CONFIG.useMock` 已删除（mock 由前端 Test Data 开关控制）、`/generate` 已接真实 LLM。
注释与实现不符，建议更新为当前架构描述。

## 五、P5（次要）：health 字段硬编码

`/api/v1/health` 返回 `{"status":"ok","mock":False,"phase":1}`——`mock`/`phase` 无实际依据。
建议返回真实状态（如 DB 可达、edge-tts 可用性）或精简为 `{"status":"ok"}`。

## 六、已验证正常的部分

- 前端三套 e2e 全通过（35/35、10/10、11/11），mock 链路：生成 → 语料 → 合成 → 发布 → 播放 → 管理 → 删除二次确认 → 音色角色试听 → 深浅主题 → 中英切换 均正常；
- 后端路由 16 个与前端 `apiFetch` 调用点一一对应（health/generate/materials CRUD+regenerate+synthesize/playlists CRUD+成员/config test-llm|test-tts|test-generate|unlock-dev）；
- `call_llm_with_retry`：pydantic 结构化校验 + 词数/中文/句数校验 + 3 次带错误反馈重试，实现完整；
- `test-llm` 真实化（不受前端 mock 门控）；`apiFetch` 对网络/非 JSON 响应有明确可操作提示。

## 七、修复优先级建议

1. **P1**（30 分钟内可修）：改一行路径 → 后端可启动 → 真实模式闭环可测；
2. **P3**（与 P1 同轮）：种子素材状态修正，避免真实模式播放 404；
3. **P2**（核心功能，工作量最大）：真实 edge-tts 逐句合成 + 拼接 + 时间轴回填；
4. **P4/P5**：文档与注释清理，随以上修复同轮完成。

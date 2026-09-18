# TELG API 契约（API Contract）

> ⚠️ 本文档为早期版本；LLM 链路相关字段已按 **v2.0 设计说明书**（`docs/设计/design-prompt链路设计说明书.md`）适配更新，冲突处以该说明书为准。
>
> 前端与后端通过 `/api/v1/*` 通信。同源部署（FastAPI 托管前端静态文件），无跨域问题。
> 前端默认走真实后端；仅当「开发者模式 → 测试数据」启用固定数据集时，LLM 用模板消息返回、TTS 走 mock，不触网。

## 1. 素材（Materials）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/materials` | 素材列表 |
| GET | `/api/v1/materials/{mid}` | 单个素材（含 dialogue/vocab/questions/patterns） |
| PATCH | `/api/v1/materials/{mid}` | 更新（改名 / saved 发布 / 任意 meta 字段） |
| DELETE | `/api/v1/materials/{mid}` | 删除素材 |
| POST | `/api/v1/generate` | 生成语料（body=GenerateIn；test_mode 或环境变量 TELG_MOCK_LLM=1 时走 mock_generate） |
| POST | `/api/v1/materials/{mid}/regenerate` | 基于原参数重新生成语料 |
| POST | `/api/v1/materials/{mid}/synthesize` | 合成音频（edge-tts / Kokoro 双引擎：逐句合成 + ffmpeg 拼接 + 时间戳回填） |

### GenerateIn（请求体）

```json
{
  "domain": "automotive", "domainLabel": "Automotive Engineering",
  "format": "dialogue",
  "roles": { "a": "Vehicle Dynamics Lead", "b": "Controls Engineer" },
  "context": "Design review on burst-tire compensation: response time vs calibration conservatism",
  "difficulty": 3, "length": "120",
  "advanced": {
    "depth": 3, "injections": "Focus on yaw moment feedback", "directions": []
  },
  "llm_config": { "base_url": "...", "api_key": "...", "model": "...", "temperature": 0.7 }
}

> v2 变更：`topic / role / scenario / asymmetric / advanced.breadth / advanced.tone / advanced.vocabDensity / advanced.style` 已删除（`topic` 由 `context` 取代）；
> `advanced.depth` = 句式复杂度（SYNTAX_COMPLEXITY_DEFS），`difficulty` = 词汇专业度（VOCAB_PROFICIENCY_DEFS）；
> `discussion` 形态用 `roleSelection.candidates`（不带 speakerCount，出场人数由模型决定）。
```

> 注：`llm_config` 仅随单次请求发送用于生成，**不持久化**；真实部署时由服务端 `.env` 管理。

### 响应（Generation Artifact）

`meta + background + dialogue[] + vocabulary[] + listening_questions[] + core_sentence_patterns[]`，结构与 [architecture-总体架构](./architecture-总体架构.md) §3 一致。mock 与真实模式均返回同一 schema。

## 2. 播放列表（Playlists）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/playlists` | 列表 |
| POST | `/api/v1/playlists` | 新建 |
| PATCH | `/api/v1/playlists/{pid}` | 改名 |
| DELETE | `/api/v1/playlists/{pid}` | 删除 |
| POST | `/api/v1/playlists/{pid}/materials` | 添加素材 |
| DELETE | `/api/v1/playlists/{pid}/materials/{mid}` | 移除素材 |

## 3. 配置测试（Provider 连通性）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/config/test-llm` | 用请求内凭证实测 LLM 连通（校验 base_url / api_key，返回 latency / model） |
| POST | `/api/v1/config/test-tts` | 用请求内音色实测 TTS 合成，返回可播放 audio_url |
| POST | `/api/v1/config/test-generate` | 完整生成管线（固定参数），返回 segs/words/total_ms 等诊断指标，用于调试 LLM 本身 |
| POST | `/api/v1/config/unlock-dev` | 开发者模式解锁（key 校验，环境变量 `TELG_DEV_KEY`，默认 `telg-dev`） |

### 设计要点

- **测试凭证不进服务端存储**：`test-llm` / `test-tts` / `test-generate` 的凭证仅随请求体使用一次；
- **错误语义**：HTTP 401/403 → Key 无效；404 → base_url 错误；400 → model 不存在；网络层错误单独归类；
- **test-tts 当前缺陷**：服务端写死试听文本，未使用请求体 `text` 字段（见 issue-report A1）。

## 4. 静态资源

- `GET /api/v1/audio/{filename}` — 合成音频（storage/ 目录静态挂载）；
- `/` — 前端 index.html（静态挂载，同源）。

## 5. Mock / 真实切换

| 开关 | 位置 | 效果 |
|---|---|---|
| `mockMode()` | 前端 index.html（读 `telg-test-data`） | 默认 false：走 `/api/v1/*` 真实链路；Test Data 启用时为 true：本地模板数据 |
| `TELG_MOCK_LLM` | 后端环境变量 | 设为 1 时 generate 返回模板语料（测试链路用） |
| `test_mode` 请求字段 | `/generate` body | 使用模板响应（不调 LLM、不需 Key），验证生成管线其余环节 |

## 5.1 LLM 生成实现细节（Phase 2 现状）

- **结构化 Prompt**：将 difficulty（词汇专业度 L1–5）/ depth（句式复杂度 L1–5）/ 目标词数 / 场景语境 / 领域适配 / 对话结构等约束组装为 system prompt（breadth / tone / vocabDensity / style 等僵尸参数已删除）；
- **强约束输出**：`response_format: json_object` + pydantic 校验，失败自动分区重试（最多 3 次，按 zone 局部修复并合并复验）；
- **时间戳**：LLM 不产时间戳；`start_ms / end_ms` 由 TTS 逐句合成真实时长累加回填（句间插入停顿），非估算；
- **凭证**：请求体 `llm_config`（与设置页同构，不持久化）或环境变量 `DEEPSEEK_API_KEY` / `TELG_LLM_BASE` / `TELG_LLM_MODEL`；
- **regenerate**：`POST /materials/{mid}/regenerate` 原地重跑（id 保留、子表重建、状态回 draft），供 Refine 使用。

## 5.2 种子素材

`backend/seed_materials.json` 提取自前端 MOCK_MATERIALS（m1/m2/m3 + 4 个默认播放列表），首次启动播种为 **published** 状态——与用户创建的素材同 schema、同生命周期。

## 5.3 开发者专用工具（正式发布版隐藏）

| 端点 | 用途 |
|---|---|
| `POST /api/v1/config/test-generate` | 完整真实生成管线（固定参数、不持久化），调试 LLM 本身：返回 segs/words/total_ms/vocab/questions 等指标 |
| `POST /api/v1/config/unlock-dev` | `{key}` 解锁隐藏的 Generation Debug / Test Mode UI；密钥 = 环境变量 `TELG_DEV_KEY`（默认 `telg-dev`） |
| `CONFIG.devMode` | 前端 `index.html` 中开关：true 显示设置页开发调试区；正式版置 false，仅 key 解锁 |

## 6. 约定与限制

- 所有时间戳单位为毫秒（ms）；
- `difficulty` 1–5 整数（词汇专业度）；`depth` 1–5 整数（句式复杂度）；`length` 秒字符串 "120" / "300" / "480" / "720" / "900"（对应 2 / 5 / 8 / 12 / 15 分钟）；
- 删除素材应级联清理播放列表关联行（当前后端未实现，见 issue-report A4）；
- 真实接入后：LLM/TTS 凭据由服务端管理，前端设置页仅展示状态。

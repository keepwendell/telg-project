# TELG 总体架构（Architecture）

## 1. 系统拓扑

```
                    Frontend (telg-project/frontend/index.html)
                    │ 原生 JS 单文件 · 状态对象 + 重渲染 · 默认真实链路（mockMode() 开关）
                    │
                    │ HTTP (JSON, 同源)
                    ▼
              FastAPI Backend (backend/main.py)
                    │
              ┌─────┴─────┐
              ▼           ▼
      LLM Provider    TTS Provider
      (OpenAI-compatible:  (edge-tts, 可插拔:
       DeepSeek/Qwen/       Piper / sherpa-onnx /
       Ollama/内部 Gateway)  CosyVoice 预留)
              │           │
              ▼           ▼
        Generation      Audio Segments
        Artifact            │
              │             ▼
              └─────►   Audio Merge → Timeline 回填
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
         Player (前端)           Handout (讲义)
```

## 2. 分层职责

| 层 | 职责 | 关键点 |
|---|---|---|
| 前端 | 参数收集、进度展示、播放器、讲义渲染、素材库管理 | 单文件原生 JS；默认真实链路，仅 Test Data 启用时走模板数据；所有 UI 状态存 `state` 对象 |
| API 层 | 契约边界 | `/api/v1/*`；同源部署（无 CORS 问题） |
| 后端 | 鉴权凭证管理（API Key 只存服务端）、LLM 调用、TTS 合成、音频拼接、时间轴回填、SQLite 持久化 | Key 不落地 localStorage |
| 存储 | SQLite（materials / dialogue_segments / vocabulary / playlists / generation_jobs）+ 文件系统 `backend/storage/` 音频 | 单机个人项目零运维 |

## 3. Generation Artifact（核心数据对象）

LLM、TTS、播放器、讲义之间的**共同数据源**，保证各模块内容一致：

```json
{
  "meta": {
    "title": "Tire Burst Stability Control", "topic": "...",
    "dialogue_type": "technical_discussion", "difficulty": "Level 3",
    "length": "medium", "llm_provider": "deepseek",
    "tts_provider": "edge-tts", "voice": "en-US-GuyNeural",
    "audio_url": "...", "total_duration_ms": 95000
  },
  "background": { "technical_background": "...", "technical_principle": "...", "engineering_scenario": "..." },
  "dialogue": [
    { "id": 1, "speaker": "Engineer A", "text_en": "...", "text_zh": "...",
      "start_ms": 0, "end_ms": 2300, "words": [] }
  ],
  "vocabulary": [ { "en": "yaw moment", "zh": "横摆力矩", "context_meaning": "..." } ],
  "listening_questions": [],
  "core_sentence_patterns": []
}
```

设计要点：
- LLM 阶段**不产出时间戳**；`start_ms / end_ms` 完全来自 TTS 逐句合成的真实时长累加；
- 中英双语一次调用同时产出（上下文一致、成本低于两次调用）。

## 4. Provider 可插拔设计

```python
LLMProvider: generate() / health_check() / model_info()
TTSProvider: synthesize(text, voice, speed, lang) → audio + duration
```

- LLM：OpenAI-compatible 通用契约（base_url + api_key + model 可配置，另支持环境变量 `TELG_LLM_BASE` / `TELG_LLM_API_KEY` / `TELG_LLM_MODEL`），兼容 DeepSeek / Qwen / Ollama / 豆包 Ark / Kimi / OpenAI / 企业内部 Gateway；前端提供预设厂商下拉与 **Custom** 手动接入，任意兼容端点开箱即用。
  - 生成请求默认携带 `response_format: json_object`；部分兼容端点不支持时后端自动降级为普通 JSON 输出并重试（系统提示词仍要求纯 JSON，模型校验层兜底）。
  - 鉴权：API Key 由前端随请求临时携带、不持久化存储；服务端环境变量作为部署级兜底。
- TTS：首期 edge-tts（接入简单、英语效果好、无 Key）；Piper / sherpa-onnx / CosyVoice 后续按同一接口接入。

## 5. 逐句 TTS 与时间轴（工程要点）

```
Sentence 1 → TTS → audio_1 (duration d1)
Sentence 2 → TTS → audio_2 (duration d2)
...
Audio 拼接（句间可插停顿，如 300ms）
→ start_ms/end_ms 逐句回填
→ 播放器按时间轴做句级高亮/Replay，无需 Web Speech API onboundary
```

## 6. 异步任务与进度（规划）

- 生成/合成为秒级～十几秒级真实等待，且可能失败（超时、JSON 解析失败、TTS 限流）；
- 计划：FastAPI BackgroundTasks + `generation_jobs` 表 + 前端轮询（或 SSE）；
- 当前前端进度为 mock（sleep 动画），接入真实后端时替换数据源，UI 结构已预留。

## 7. 数据库 Schema（规划/现状）

- `materials`：id, title, topic, domain, role, scenario, difficulty(1-5), depth/breadth(1-5), tone, status(draft/audio_ready/published), llm_provider/model, tts_voice_a/b, tts_style, tts_rate, total_duration_ms, audio_path, version
- `dialogue_segments`：id, material_id, seq, speaker, role, voice, text_en, text_zh, start_ms, end_ms
- `vocabulary` / `listening_questions` / `core_sentence_patterns`
- `playlists` / `playlist_materials`（多对多）
- `generation_jobs`：id, material_id, phase(corpus/tts/publish), status, progress_pct, error_message

## 8. 当前实现状态

| 模块 | 状态 |
|---|---|
| 前端交互全链路 | ✅ 完成（mock 数据可完整跑通：生成→TTS→发布→播放→管理） |
| 后端 CRUD / Provider 测试 / mock 生成 | ✅ 完成（FastAPI + SQLite） |
| 真实 LLM 接入 | ✅ 完成（OpenAI 兼容通用契约 + pydantic 校验 + 失败重试 + json_object 自动降级；端到端验证通过） |
| 真实 TTS 合成 | ❌ 占位（synthesize 仅置 audioReady，不产真实音频与时间戳） |
| 异步任务/进度 | ❌ 前端 sleep 模拟，待 job 轮询 |
| 安全 | ⚠️ Key 由后端管理（前端不持久化），部署需收紧 CORS/鉴权 |

# TELG 待办事项（Roadmap / Backlog）

> 版本：2026-09-16 · 状态：current · 关联文档：[架构/architecture-总体架构](./../架构/architecture-总体架构.md)、[设计/design-tts引擎选型](./../设计/design-tts引擎选型.md)
>
> 记录"未来要做但尚未排期"的事项。事项落地后移入对应分类文档并在本文标记状态；仅记录有明确动机与方案的条目，避免堆积空想。

## 约定

- 状态机：`backlog`（待办）→ `planned`（已排期）→ `done`（已完成，移出本表并注明去向）。
- 优先级：P0 阻断核心体验 / P1 明显收益 / P2 锦上添花。

## 待办清单

| # | 事项 | 动机 | 候选方案 | 优先级 | 状态 |
|---|---|---|---|---|---|
| 1 | 词级时间戳与词级同步 | 当前时间轴为句子级（逐句 probe 时长 + 400ms gap 累加），已闭环但无法做听读跟读、单词定位、词级高亮 | 见下方"事项 1 详情" | P1 | backlog |
| 2 | （预留） | — | — | — | — |

---

## 事项 1：词级时间戳与词级同步（Word-level Timestamps）

### 背景

当前时间戳链路（已实施）：

```
逐句 TTS 合成 → probe 整句时长 → start += dur + 400ms gap → 句级 start_ms/end_ms
```

句子级已满足：点击跳句、句高亮、单句循环、倍速。**短板**：无法做"词级高亮"（语音读到哪个词、听读跟读、单词精准定位重听），这类体验需要词级时间戳。

### TTS 原生时间戳能力核查（2026-09-16）

| 方案 | 原生时间戳 | 级别 | 备注 |
|---|---|---|---|
| edge-tts | ✅ | 词级 | WordBoundary 事件流（offset/duration per word），当前工程未采集 |
| Kokoro（kokoro-onnx） | ❌ | 无 | 仅返回 PCM 音频，无任何时间信息 |
| 硅基流动 TTS | ❌ | 无 | API 仅返回 `{audio_url, duration_ms}` |
| 阿里云百炼 CosyVoice3.5 / Qwen-Audio TTS | ✅ | 字级 | `enableWordTimestamp=true`，仅流式输出模式 |
| Azure Speech（edge-tts 正式版） | ✅ | 词级+句级 | WordBoundary + SentenceBoundary |
| Qwen3-ForcedAligner-0.6B | 对齐工具 | 词级 | "音频+已知文本 → 词级时间戳"，精度 ±20ms，离线，0.6B |

### 三条实现路径

1. **edge-tts 原生采集**：合成时收集 WordBoundary 事件 → 每句存 `words[{w, start_ms, end_ms}]` → 前端词级渲染。零新增依赖，但仅对 edge-tts 生效。
2. **阿里云百炼 `enableWordTimestamp`**：原生字级时间戳、质量最好；但属云 API（需 Key、流式调用），与"离线优先"路线冲突。
3. **对齐器后处理（推荐）**：对任意 TTS 合成的整篇音频跑一次 Qwen3-ForcedAligner-0.6B（离线、±20ms），输出词级时间戳存 DB。与现有"可插拔 Provider"架构天然兼容，一次实现全引擎通用；代价是多一个 0.6B 模型依赖与一次对齐耗时。

### 影响面（若实施）

- 后端：`dialogue_segments` 增加词级存储（words JSON 列或独立表）；合成/对齐后写入。
- 前端：transcript 行内词级高亮渲染；播放时按 `words[i].start_ms` 驱动当前词定位（复用现有 100ms tick）。
- 播放器：`seekSentence` 不变（句级跳转仍以句时间戳为准），词级仅用于高亮与跟读。

### 建议

采用**路径 3（对齐器后处理）**，作为独立待办（P1）。句子级时间戳继续作为句跳转/循环的权威依据，词级作为叠加增强层；不阻塞当前任何功能。

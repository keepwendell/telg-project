# TELG 设计思路：Refine 面板重构 + LLM Token 用量统计

> 版本：2026-09-16 · 状态：draft（待评审）· 关联文档：[总体架构](../架构/architecture-总体架构.md) / [接口契约](../架构/api-contract-接口契约.md) / [需求规格](../产品/requirements-需求规格.md)

---

## Part A：Refine 面板重构

### A1. 目标与原则

| 原则 | 含义 |
|------|------|
| **语义一致** | 参数「取值语义」与首次生成完全一致：同一套 `GenerateIn` 契约、同一 prompt 构造、同一 LLM 配置与 test_mode。只裁剪可见性与交互范围，不做参数含义裁剪 |
| **交互聚焦** | 再生成 = 在已有素材上微调，只暴露与「微调」相关的控件；身份参数（Topic/Domain/Role/Scenario）只读展示 |
| **最小变更** | 后端无感知（复用 `/generate` 与 `/regenerate`），改动全部在前端 UI 与参数装配层 |

### A2. 现状对照

| 参数 | 首次生成（Generator） | 当前 Refine | 重构后 Refine |
|------|----------------------|-------------|---------------|
| Topic | 可输入 | 只读展示 | 只读展示（改 = 新建，不提供） |
| Domain / Role / Scenario | Select | 不展示 | 只读信息行 |
| Difficulty (1-5) | Segmented | 可调（refine-diff） | 可调（核心微调组） |
| Length | Segmented | 可调（refine-len） | 可调（核心微调组） |
| Depth（技术深度 1-5） | Advanced 内 | 固定 3 | 可调（深度方向组） |
| Breadth（话题广度 1-5） | Advanced 内 | 读素材 m.breadth | 可调（深度方向组） |
| Tone（语气） | Advanced 内 | 可调（refine-tone） | 可调（深度方向组） |
| Injections（自定义指令） | Advanced 内 | 丢失 | 可调（深度方向组） |
| Directions（生成方向） | 预留字段（空） | 无 | **新增**（Expand/Narrow/Rephrase） |

### A3. 面板结构（Refine Modal 重构为两区）

```
┌─ Refine Material ──────────────────────────────────────────┐
│ 上下文（只读，信息行）                                        │
│   Tire Burst Stability Control                              │
│   Automotive · Vehicle Dynamics Engineer · Technical        │
│   Discussion                                               │
├─────────────────────────────────────────────────────────────┤
│ 核心微调                                                    │
│   Difficulty  1  2  3  4  5        Length  Short  Medium  │
│                                                       Long  │
│ 深度方向                                                     │
│   Depth       1  2  3  4  5        Breadth  1  2  3  4  5 │
│   Tone        [Technical Discussion ▾]                      │
│   Custom      [输入希望强调/加入的内容……]                    │
│ 生成方向                                                     │
│   [重写] [扩写] [聚焦] [发散]                                │
├─────────────────────────────────────────────────────────────┤
│  [Cancel]                          [Regenerate]  ⌘⏎         │
└─────────────────────────────────────────────────────────────┘
```

**布局要点**：
- 上下文区为**纯信息展示**（label + 值），无交互控件，视觉弱化（faint 文字）；
- 核心微调 = 首次生成同一控件（Segmented），回填自 `paramsFromArt()` 现有逻辑；
- 深度方向 = 首次生成 Advanced 内控件直接上移，**取值默认回填素材**（depth/breadth 从 `m.depth/m.breadth` 读，不再固定 3）；injections 保留在素材上（`m.injections` 若存在）；
- 生成方向 = 分段滑组（与句式复杂度同款），对应 `advanced.directions` 数组，值为 `rephrase|expand|narrow|re-angle`；后端 prompt 已实现消费（`DIRECTION_DEFS` 映射为中文生成指令）。

### A4. 参数装配（paramsFromArt 增强）

```js
function paramsFromArt(art) {
  const m = art.meta;
  const dirEl = document.querySelector('#refine-dir .seg-item.active');
  const fmt = m.format || 'discussion';
  let structure = {};
  if (fmt === 'solo') {
    structure.roles = { speaker: m.roles?.speaker || m.speakers?.[0]?.role || '' };
  } else if (fmt === 'dialogue') {
    /* asymmetric: lead/respond 槽位；对称：a/b */
    structure.roles = m.asymmetric ? { lead: m.roles?.lead, respond: m.roles?.respond }
                                   : { a: m.roles?.a || m.speakers?.[0]?.role, b: m.roles?.b || m.speakers?.[1]?.role };
  } else {
    structure.roleSelection = { candidates: m.roles?.candidates || m.speakers.map(x => x.role),
                                speakerCount: m.roles?.speakerCount || m.speakerCount || 3 };
  }
  return {
    topic: m.topic,
    domain: m.domain, domainLabel: m.domain,
    format: fmt, asymmetric: !!m.asymmetric, context: m.context || m.scenario || '',
    ...structure,
    difficulty: /* 从 refine-diff 读，回填 m.difficulty */,
    length:     /* 从 refine-len 读，回填 m.length(秒) */,
    llm: llmDisplayLabel(),
    tts: normalizeTTSProvider((readStoredCfg().tts || {}).provider) || 'edge-tts',
    voice: m.voice,
    llm_config: buildLLMConfig(), test_mode: buildTestMode(),
    advanced: {
      depth:        /* refine-depth 读，回填 m.depth ?? 3 */,
      vocabDensity: m.speechRate ?? m.vocabDensity ?? 28,   /* 后端存 meta.speechRate */
      style:        m.style ?? 'technical',
      injections:   /* refine-inject 输入，回填 m.injections */,
      tone:         m.tone || 'neutral',
      breadth:      m.breadth ?? 3,
      directions:   /* seg active → ['expand'] | ['narrow'] | ['re-angle'] | []（rephrase 不上送） */
    }
  };
}
```

**关键点**：
- Refine 打开时**一次性回填**当前素材参数 → 用户看到的是"当前值"，微调后提交；
- 与首次生成共用 `GenerateIn` schema；后端配套改动：生成时把 `format / asymmetric / roles / roleSelection` 持久化进 `meta`（refine 恢复结构用），prompt 消费 `advanced.directions`。
- refine 提交 = `API.regenerateMaterial(art.id, params)`，成功后**原素材原位替换**（保留 id），TTS 状态回到"未合成"（需重新 Set Voice & Synthesize）——与现有「语料调整后步骤回溯」行为一致。

### A5. 交互与边界

| 场景 | 行为 |
|------|------|
| 从素材列表进入 Refine | 面板打开即回填该素材全部可调参数 |
| 已发布素材 | 点 Refine 即"解锁编辑"：发布态 → draft，进度条重新出现（沿用现有解锁语义） |
| 只改 Length 不动其它 | 参数保持原值提交，LLM 按新长度重写语料 |
| 生成方向（seg） | 提交后 Prompt 追加方向指令；再次打开 Refine 时方向**重置为空**（避免方向叠加） |
| 取消 | 不回写任何内容，素材保持原样 |

---

## Part B：LLM Token 用量统计

### B1. 目标

在设置页提供 LLM 真实消耗的可视化：总计 / 今日 / 按日聚合，prompt 与 completion 拆分，覆盖 generate / regenerate / test-llm 三个动作。仅统计真实调用（mock 模式不产生记录）。

### B2. 数据来源

后端已用 OpenAI 兼容 SDK 调用，`resp.usage` 标准字段（DeepSeek / Qwen / Kimi / OpenAI 均返回）：

```json
"usage": { "prompt_tokens": 842, "completion_tokens": 1203, "total_tokens": 2045 }
```

### B3. 后端设计

**表结构**（SQLite，`init_db()` 中新增）：

```sql
CREATE TABLE IF NOT EXISTS llm_usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT NOT NULL,            -- deepseek / openai / ...
  model              TEXT NOT NULL,            -- deepseek-chat / ...
  action             TEXT NOT NULL,            -- generate | regenerate | test-llm
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
```

**记录点**（`call_llm_with_retry` 内，成功路径）：

```python
# resp 解析成功、art 校验通过后：
usage = getattr(resp, "usage", None)
if usage is not None and getattr(usage, "total_tokens", 0):
    db.execute(
        "INSERT INTO llm_usage(provider, model, action, prompt_tokens, completion_tokens, total_tokens)"
        " VALUES(?,?,?,?,?,?)",
        (cfg.get("provider") or "openai-compatible", cfg.get("model") or "",
         action, usage.prompt_tokens or 0, usage.completion_tokens or 0, usage.total_tokens or 0),
    )
    db.commit()
```

- `action` 由调用方传入（`call_llm_with_retry` 增加一个 `action` 参数，默认 `generate`；regenerate 与 test-llm 分别传值）；
- **失败不计**：仅成功且拿到 usage 才落库；
- **不阻塞主流程**：记录失败仅打日志，不影响生成结果返回。

**聚合接口** `GET /api/v1/usage`：

```json
{
  "ok": true,
  "total":   { "prompt_tokens": 12345, "completion_tokens": 23456, "total_tokens": 35801, "calls": 42 },
  "today":   { "prompt_tokens": 842,   "completion_tokens": 1203,   "total_tokens": 2045,  "calls": 3 },
  "by_day":  [
    { "date": "2026-09-15", "prompt_tokens": 12000, "completion_tokens": 22000, "total_tokens": 34000, "calls": 38 },
    { "date": "2026-09-16", "prompt_tokens": 842,   "completion_tokens": 1203,   "total_tokens": 2045,  "calls": 3 }
  ],
  "breakdown": { "generate": 30, "regenerate": 10, "test-llm": 2 },
  "mock": false
}
```

实现：`by_day` 用 `GROUP BY date(created_at)`；`total/today` 用 `SUM`；`breakdown` 用 `GROUP BY action`。

### B4. 前端设计（设置页）

**位置**：设置弹窗左侧弱 Tab 导航新增「Usage」Tab（图标 + 文字），与 LLM / TTS / 快捷键 / 开发者 / 关于平级。

**内容布局**（单栏，自上而下）：

```
Usage（LLM Token 用量）
┌───────────────────────────────────────────────┐
│ 统计范围说明（一行 faint 文字）                   │
│ Mock 模式无统计  /  总计 35,801 · 今日 2,045     │
├───────────────────────────────────────────────┤
│ 总计        Prompt 12,345  Completion 23,456   │
│ 今日        Prompt 842    Completion 1,203     │
│ 调用分布    语料生成 30 · 再生成 10 · 连接测试 2  │
├───────────────────────────────────────────────┤
│ 按日明细（最近 14 天，倒序列表）                  │
│  2026-09-16  3 次调用  2,045 tokens  [4.2 KB]  │
│  2026-09-15  38 次调用 34,000 tokens [70 KB]   │
└───────────────────────────────────────────────┘
```

**交互要点**：
- 打开设置 → Usage Tab 时拉取 `GET /api/v1/usage`；加载失败显示「无法获取（后端未连接）」；
- mock 模式（`telg-test-data` 非 off）时显示「测试数据模式不产生用量记录」，不调接口；
- token→KB 换算展示（约 1 token ≈ 0.75 字 ≈ 3 字节，展示用）为可选增强，第一版可不做；
- 设置弹窗关闭后再次打开需重新拉取（每次打开刷新）。

### B5. 边界与约定

| 边界 | 处理 |
|------|------|
| 供应商不返回 usage（个别网关） | `getattr` 判空，无记录，前端显示 0 |
| 失败调用 | 不落库（不可靠数据不入统计） |
| mock / 测试数据模式 | 不产生记录，前端明确提示 |
| 时间基准 | SQLite `localtime`，与用户本地时区一致 |
| 数据量 | 单机个人项目，按日聚合即可，无需清理策略（可后续加 90 天保留） |

---

## Part C：实施顺序

1. **Refine 面板重构**（纯前端）：
   - `paramsFromArt` 增强（回填 depth/breadth/injections/directions）
   - Refine Modal DOM 重构（上下文区 + 核心微调 + 深度方向 + 生成方向）
   - e2e 补充 refine 回填用例
2. **Token 统计**（后端 → 前端）：
   - `llm_usage` 表 + 记录点 + `GET /api/v1/usage`
   - 设置页 Usage Tab
   - 验证：真实 key 生成一条素材 → usage 记录出现 → 设置页展示
3. 回归三套 e2e + 手工冒烟（真实链路一次）

> 两者互不依赖，可并行或先后实施；建议先做 Refine（影响主流程体验），Token 统计随后。

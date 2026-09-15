# TELG 工程组织与命名规范（Engineering Organization）

> 版本：2026-09-16 · 状态：current（已实施 docs 类调整）· 关联：[作者规则](../rules/author-rules-作者规则.md) / [总体架构](./架构/architecture-总体架构.md)

本文记录 2026-09-16 关于工程目录组织、文档命名与提交策略的讨论结论，作为后续迭代的组织基线。

---

## 1. 背景与动因

- commit 频率过高会稀释信息密度：对话逐轮提交 → 提交内容碎片化。
- 需要「对话要点日志」与「代码快照」解耦：日志持续记录，提交只在用户点名时统一执行。
- 目录随业务演进会膨胀：需要按生命周期分类、统一命名规则、预留知识累积路径。

## 2. 最终决策（2026-09-16）

1. **先执行 docs 类目录调整**（本文档落地即为实施）：`docs/` 分子目录并中文命名、新建 `changelog/`、`reports/` 按问题建文件夹、`rules/` 文档中文命名。
2. **code 类目录暂不调整**：`frontend/`（单文件 index.html）与 `backend/`（main.py 单模块）维持现状。
3. **代码目录的演进方案已评估但推迟**：见 §5，等业务迭代或调试流程稳定后再动。

## 3. 目录结构（docs 类）

```
telg-project/
├── README.md                        # 总览 + 目录导航
├── docs/                            # 知识库（中文文档，状态放头部）
│   ├── README.md                    # 索引 + 中英文件名对照
│   ├── engineering-org-工程组织规范.md
│   ├── 产品/   (product-brief-产品定义 / requirements-需求规格)
│   ├── 架构/   (architecture-总体架构 / api-contract-接口契约)
│   ├── 设计/   (design-system-视觉设计规范 / design-<主题> 专题)
│   └── 运维/   (running-guide-运行指南)
├── changelog/                       # 对话要点日志（YYMMDD-会话主题.md）
├── reports/                         # 按问题/报告名建文件夹
│   ├── 交互体验问题评估/
│   └── 运行时问题检查/
├── rules/                           # 协作规则（author-rules-作者规则.md）
├── frontend/  backend/  scripts/  tests/   # code 类（暂不调整）
```

## 4. 命名规则

| 位置 | 命名 | 示例 |
|---|---|---|
| 代码目录 / 脚本 / 测试 | 英文 kebab / snake | `test_flow_e2e.py` |
| `docs/` 文档 | `英文-中文.md` | `architecture-总体架构.md` |
| 专题设计 | `design-主题.md` | `design-精调面板与用量统计.md` |
| `changelog/` | `YYMMDD-会话主题.md` | `260916-文件组织方式讨论与决策.md` |
| `reports/` 文件夹 | 报告名（必要时 `YYMMDD-报告名`） | `交互体验问题评估/` |
| `reports/` 内文档 | 纯中文内容名 | `问题分析.md` / `解决对策.md` / `修复验证.md` |

**细则**：
- 中文命名禁空格、禁标点；短语间用 `-` 连接。
- 涉及时间一律 `YYMMDD`（两位年），仅时间敏感的文件/文件夹使用。
- 版本与状态只放文档头（`版本 / 状态 / 关联文档`），不进文件名；状态机 `draft → current → superseded`。

## 5. 代码目录演进评估（已讨论，推迟执行）

结论：`services/routers` 拆分方向正确，能支撑约 85% 预期拓展；两个必补设计已确认但**暂不实施**：

1. **TTS Provider 契约层**：`services/tts.py` 抽出 `synthesize(text, voice, rate, style, provider) -> (path, dur_ms)`，解决当前 edge-tts 在路由层直连、无法切换 Piper/CosyVoice 的问题。
2. **数据库迁移机制**：`db.py` 引入 `SCHEMA_VERSION + MIGRATIONS[]` 顺序迁移，解决 `CREATE TABLE IF NOT EXISTS` 无法改旧表的问题（未来 user_id、mastery 等字段）。

启动门槛：`backend/main.py` 超 1500 行 或 首次需要加列时，先抽 `services/` 三件套（llm / tts / timeline）并补 unit 测试。

## 6. 知识累积路径

```
对话要点 → changelog/（流水账，只记不提交）
    ↓ 有长期价值
专题设计 → docs/设计/design-主题.md（draft）
    ↓ 实施落地
状态改 current，回写 架构/接口契约
    ↓ 形成稳定约定
沉淀 → rules/author-rules-作者规则.md
```

- commit 时机由用户点名；提交时合并多段 changelog 要点为一个双语 commit。
- changelog 满 30 个文件时归档到 `YYYY/` 子目录。

## 7. 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-09-16 | 本文档创建：目录组织、命名规则、决策（docs 先行 / code 缓行） | 用户：「先执行docs类目录的调整，code类的暂时先不调整」 |

# TELG 文档索引（Docs Index）

> 版本：2026-09-16 · 用途：docs 知识库导航，含中英文文件名对照。

命名规则见 [engineering-org-工程组织规范](./engineering-org-工程组织规范.md)。

## 产品 — 为什么做 / 做什么

| 文件 | 英文原名 | 内容 |
|---|---|---|
| [product-brief-产品定义](./产品/product-brief-产品定义.md) | product-brief.md | 产品定位与差异化（Technical Grounding） |
| [requirements-需求规格](./产品/requirements-需求规格.md) | requirements.md | 需求规格与难度体系 L1-5 |

## 架构 — 系统怎么搭

| 文件 | 英文原名 | 内容 |
|---|---|---|
| [architecture-总体架构](./架构/architecture-总体架构.md) | architecture.md | 系统拓扑 / Generation Artifact / 时间轴方案 |
| [api-contract-接口契约](./架构/api-contract-接口契约.md) | api-contract.md | API 契约与 mock/真实切换 |

## 设计 — 怎么设计

| 文件 | 英文原名 | 内容 |
|---|---|---|
| [design-system-视觉设计规范](./设计/design-system-视觉设计规范.md) | design-system.md | 视觉与交互规范（参考 OpenCode/Linear） |
| [design-精调面板与用量统计](./设计/design-精调面板与用量统计.md) | design-refine-and-usage.md | 专题设计（状态：draft） |

## 规划 — 往哪走

| 文件 | 英文原名 | 内容 |
|---|---|---|
| [roadmap-待办事项](./规划/roadmap-待办事项.md) | roadmap.md | 待办事项与状态机（backlog/planned/done） |
| [plan-学习档案与首启引导](./规划/plan-学习档案与首启引导.md) | plan-learning-profile-onboarding.md | 产品方向拓展：领域档案 / 首启引导 / 学习档案 / 持久化演进 |

## 运维 — 怎么跑

| 文件 | 英文原名 | 内容 |
|---|---|---|
| [running-guide-运行指南](./运维/running-guide-运行指南.md) | running-guide.md | Windows 运行指南（环境/命令/FAQ） |

## 规划 — 下一步做什么

| 文件 | 英文原名 | 内容 |
|---|---|---|
| [roadmap-待办事项](./规划/roadmap-待办事项.md) | roadmap.md | 待办/Backlog：词级时间戳与词级同步等 |

## 状态约定

- 每份文档头部标注 `版本 / 状态 / 关联文档`。
- 状态机：`draft`（设计待评审）→ `current`（已实施）→ `superseded`（废弃归档，不删）。
- 新文档落位规则：产品类→`产品/`，接口/架构类→`架构/`，专题设计→`设计/design-主题.md`，操作类→`运维/`。

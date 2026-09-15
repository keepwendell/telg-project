# TELG — Technical English Listening Generator

面向技术研发人员的**参数化技术英语听力素材生成器**：输入一个技术主题，几十秒内获得一套可直接用于训练的技术英语听力素材（音频 + 逐句同步字幕 + 技术讲义）。

> 核心价值一句话：**用真实技术知识作为内容背景，用英语作为训练载体**（Technical Grounding）。

## 快速开始

> 📖 **完整运行指南（Windows 适配：环境要求 / 分步命令 / 验证清单 / 常见问题）见 [`docs/运维/running-guide-运行指南.md`](docs/运维/running-guide-运行指南.md)**。以下为速览。

### Windows 本地调试（真实后端，推荐）

```powershell
# 前置：Python 3.10+（安装时勾选 Add to PATH）+ ffmpeg（winget install Gyan.FFmpeg）
cd D:\dev\telg-project\backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py                # 保持终端开启
# 浏览器打开 http://127.0.0.1:8000
```

### 方式一：纯前端（Mock 模式，无需后端）

```bash
open frontend/index.html     # macOS
xdg-open frontend/index.html # Linux
start frontend\index.html    # Windows
```

前端默认连接真实后端（LLM/TTS 真实调用）；仅在「设置 → 开发者模式 → 测试数据」手动启用固定数据集时，才走本地模板数据，可离线走通 生成 → 语料 → 合成 → 发布 → 播放 → 管理 全流程。

> ⚠️ **必须通过后端访问前端**：`python main.py` 后打开 `http://127.0.0.1:8000`（后端同源托管前端 + `/api/v1`）。
> 不要用 `file://` 双击 index.html，也不要用 `python -m http.server` 等静态服务器单独托管前端——否则 `/api/v1/*` 会打到静态服务器并返回 HTML 404，连接测试会报 “Backend returned HTML instead of JSON”。

### 方式二：真实后端（FastAPI + SQLite）

```bash
cd backend
pip install -r requirements.txt
python main.py               # http://127.0.0.1:8000（后端同源托管前端）
```

前端通过 `/api/v1/*` 契约与后端通信（生成、素材 CRUD、Provider 测试、TTS 合成）。

## 目录结构

```
telg-project/
├── README.md                 # 本文档
├── docs/                     # 知识库（中文文档，索引见 docs/README.md）
│   ├── engineering-org-工程组织规范.md   # 目录组织与命名规则
│   ├── 产品/                 # 产品定义 / 需求规格
│   ├── 架构/                 # 总体架构 / 接口契约
│   ├── 设计/                 # 视觉设计规范 / 专题设计
│   └── 运维/                 # 运行指南（Windows 适配）
├── changelog/                # 对话要点日志（YYMMDD-会话主题，只记不提交）
├── reports/                  # 问题/报告（按问题名建文件夹，分析-对策-修复验证）
├── rules/
│   └── author-rules-作者规则.md      # 代码作者持久工作规则
├── frontend/
│   └── index.html            # 前端单文件（原生 JS，无构建）
├── backend/
│   ├── main.py               # FastAPI 后端（单模块）
│   ├── requirements.txt
│   ├── seed_materials.json   # 种子素材（首次启动播种）
│   └── storage/              # 音频产物（运行期生成，已 gitignore）
├── tests/
│   ├── e2e/                  # Playwright 端到端回归（mock 模式）
│   │   ├── test_flow_e2e.py  # 35 项全链路回归
│   │   ├── test_tts_roles_e2e.py  # 10 项 TTS 角色专项
│   │   └── test_edge_e2e.py  # 11 项边缘场景
│   └── unit/                 # 后端单测（规划中，见 README）
└── scripts/
    └── package.sh            # 打包发布 zip
```

> 命名规则与目录演进决策见 [docs/engineering-org-工程组织规范.md](docs/engineering-org-工程组织规范.md)。

## 运行测试

```bash
pip install playwright
python tests/e2e/test_flow_e2e.py   # 35 项全链路回归
python tests/e2e/test_edge_e2e.py   # 11 项边缘场景
```

## 当前状态

| 模块 | 状态 |
|---|---|
| 前端交互全链路（mock） | ✅ 完成 |
| 后端 CRUD / Provider 测试 / mock 生成 | ✅ 完成 |
| 真实 LLM 接入 | ⚠️ 接口就绪（OpenAI-compatible + pydantic 校验 + 重试），未端到端验证 |
| 真实 TTS 合成 | ❌ 占位（synthesize 仅置 audioReady，不产音频与时间轴） |
| 异步进度 | ❌ 前端 sleep 模拟，待 job 轮询 |

详细状态与已知问题见 [docs/架构/architecture-总体架构.md](docs/架构/architecture-总体架构.md) 与 [reports/交互体验问题评估/评估与改善建议.md](reports/交互体验问题评估/评估与改善建议.md)。

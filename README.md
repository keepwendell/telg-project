# TELG — Technical English Listening Generator

面向技术研发人员的**参数化技术英语听力素材生成器**：输入一个技术主题，几十秒内获得一套可直接用于训练的技术英语听力素材（音频 + 逐句同步字幕 + 技术讲义）。

> 核心价值一句话：**用真实技术知识作为内容背景，用英语作为训练载体**（Technical Grounding）。

## 快速开始

> 📖 **完整运行指南（Windows 适配：环境要求 / 分步命令 / 验证清单 / 常见问题）见 [`docs/运维/running-guide-运行指南.md`](docs/运维/running-guide-运行指南.md)**。以下为速览。

### 首次打开：首启引导（Onboarding）

新用户首次访问会进入独立引导页 `onboarding.html`（与主页面同源、共享 localStorage，可单独打开调试）：

```
注册本地账号 → 配置真实 LLM（不可跳过，须「测试连接」通过）→ 个性化问卷
→ LLM 生成学习档案与领域/角色/场景初始推荐 → 确认后进入主页面
```

- LLM 为**强制项**：未配置或测试不通无法进入问卷与主页面（引导页无跳过入口）。
- 档案（角色画像 / 领域档案 / 练习目标）可在主页「设置 → 通用」中查看、修改或重置，并驱动新建素材弹窗的领域/角色/场景默认选项。
- 已登录且完成引导后，主页面 `index.html` 可直接打开；未登录或未完成引导会自动跳回引导页。

### Windows 本地调试（真实后端，推荐）

```powershell
# 前置：Python 3.10+（安装时勾选 Add to PATH）+ ffmpeg（winget install Gyan.FFmpeg）
cd <工程目录>\backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt        # 真实 TTS 选 Kokoro 时另见 requirements-tts-kokoro.txt
python main.py                          # 保持终端开启
# 浏览器打开 http://127.0.0.1:8000
```

### Mock 模式（固定测试数据，无需真实 LLM/TTS）

前端默认连接真实后端（LLM/TTS 真实调用）。仅当需要在**无网络 / 无 Key** 环境下走通「生成 → 语料 → 合成 → 发布 → 播放 → 管理」全流程时：

1. 打开主页面 → 「设置 → 开发者模式」→ 打开「开发者模式」开关；
2. 打开「LLM Mock」→ 语料由固定数据集提供（并展示 LLM 中间过程详情）；「TTS Mock」可接管选择指定语料数据集；
3. 注意：**开发者模式开关只影响对应链路，不影响其他功能的正常逻辑**。

> ⚠️ **必须通过后端访问前端**：`python main.py` 后打开 `http://127.0.0.1:8000`（后端同源托管前端 + `/api/v1`）。
> 不要用 `file://` 双击 index.html / onboarding.html，也不要用 `python -m http.server` 等静态服务器单独托管前端——否则 `/api/v1/*` 会打到静态服务器并返回 HTML 404，连接测试会报 "Backend returned HTML instead of JSON"。

## 目录结构

```
telg-project/
├── README.md                   # 本文档
├── docs/                       # 知识库（中文文档，索引见 docs/README.md）
│   ├── engineering-org-工程组织规范.md    # 目录组织与命名规则
│   ├── 产品/                   # 产品定义 / 需求规格
│   ├── 架构/                   # 总体架构 / 接口契约
│   ├── 设计/                   # 视觉规范 / TTS 选型 / Kokoro 适配 / 精调面板
│   ├── 规划/                   # roadmap / 学习档案与首启引导规划
│   └── 运维/                   # 运行指南（Windows 适配）
├── changelog/                  # 对话要点日志（YYMMDD-会话主题，只记不提交，提交时统一合并）
├── reports/                    # 问题/报告（按问题名建文件夹：分析 → 对策 → 修复验证）
├── rules/
│   └── author-rules-作者规则.md        # 代码作者持久工作规则
├── frontend/
│   ├── index.html              # 主页面（生成/播放/管理，单文件原生 JS）
│   └── onboarding.html         # 首启引导页（欢迎/本地账号/LLM 配置/档案问卷）
├── backend/
│   ├── main.py                 # FastAPI 后端（单模块：LLM/TTS/CRUD/统计）
│   ├── requirements.txt
│   ├── requirements-tts-kokoro.txt    # Kokoro 离线引擎依赖与模型下载说明
│   ├── seed_materials.json     # 种子素材（首次启动播种为 draft）
│   ├── telg.db                 # SQLite 数据库（运行期生成，已 gitignore）
│   └── storage/                # 音频产物（运行期生成，已 gitignore）
├── tests/
│   ├── e2e/                    # Playwright 回归（mock 模式）
│   │   ├── test_flow_e2e.py        # 36 项全链路回归
│   │   ├── test_tts_roles_e2e.py   # 11 项 TTS 角色专项
│   │   └── test_edge_e2e.py        # 12 项边缘场景
│   └── unit/                   # 后端单测（规划中）
└── scripts/
    └── package.sh              # 打包发布 zip
```

> 命名规则与目录演进决策见 [docs/engineering-org-工程组织规范.md](docs/engineering-org-工程组织规范.md)。

## 运行测试

```bash
pip install playwright
python tests/e2e/test_flow_e2e.py       # 36 项全链路回归（mock 模式）
python tests/e2e/test_edge_e2e.py       # 12 项边缘场景
python tests/e2e/test_tts_roles_e2e.py  # 11 项 TTS 角色专项
```

> 注：e2e 以 `file://` 直开 index.html 并预置 mock 数据。引入首启引导跳转后，直开未登录页面会被重定向到 onboarding.html——跑回归前需在测试脚本中预置 `telg-onboarding` 与本地账号数据（见 initGate 逻辑）。

## 当前状态

| 模块 | 状态 |
|---|---|
| 首启引导（欢迎/本地账号/LLM 强制配置/档案问卷/初始推荐） | ✅ 完成 |
| 前端交互全链路（生成 → 语料 → 合成 → 发布 → 播放 → 管理） | ✅ 完成 |
| 后端 CRUD / Provider 测试 / 档案生成 / 学习统计 | ✅ 完成 |
| 真实 LLM 接入 | ✅ 完成（OpenAI 兼容 + pydantic 校验 + 失败重试；DeepSeek/豆包/Kimi 等同一契约） |
| 真实 TTS 合成 | ✅ 完成（edge-tts 在线 / Kokoro 本地离线双引擎；逐句合成 + ffmpeg 拼接 + 真实时间戳回填） |
| 播放器（逐句同步 / 单句循环 / 倍速 / 收藏 / 前后跳转） | ✅ 完成 |
| 开发者模式（LLM Mock 过程详情 / TTS Mock 语料接管 / 诊断） | ✅ 完成 |
| 异步进度（job 轮询） | ⚠️ 待办：`generation_jobs` 表已预留，当前进度由前端阶段驱动 |

详细状态、待办与已知问题见 [docs/架构/architecture-总体架构.md](docs/架构/architecture-总体架构.md)、[docs/规划/roadmap-待办事项.md](docs/规划/roadmap-待办事项.md) 与 [reports](reports/)。

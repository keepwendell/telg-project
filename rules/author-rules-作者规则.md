# TELG — 代码作者持久工作规则（Author Rules）

本文件记录代码作者（AI 协作方）在为本工程生成代码、修改工程、交付产物时必须遵守的持久性规则。与 `docs/`（产品与架构知识）不同，本文件是**可执行的工作约定**，每次开发迭代前应参照。

> 维护约定：新增规则必须来自与用户的明确确认（用户原话、用户验收反馈），不得凭推测添加；规则冲突时以最新确认为准，并在此标注变更记录。

---

## 1. 交付规则（Delivery）

- **默认交付形态**：仅交付 `frontend/index.html` 单文件，经 `present_files` 提供。
- **按需交付**：仅当用户明确要求「打包」或「推送到 GitHub」时，才执行 `scripts/package.sh` 打包 zip 与 `git push origin main`。未要求时不得主动打包/推送。
- **双件交付**：当用户要求打包时，交付 = `telg-project.zip`（工程根）+ `frontend/index.html` 单文件，一次 `present_files` 调用同时给出两个 artifact。
- **交付说明**：简短（几行），说明改了什么、验证结果；不罗列过程。
- 历史交付短链会被新版本覆盖，交付时以最新为准。

## 2. 工程结构（Layout）

```
telg-project/
├── README.md            # 总览 + 启动/部署警告
├── docs/                # 知识库（中文文档，按 产品/架构/设计/运维 分子目录）
├── rules/               # 本目录：代码作者持久工作规则（author-rules-作者规则.md）
├── frontend/
│   └── index.html       # 前端单文件（原生 JS，无构建），唯一的 UI 交付物
├── backend/
│   ├── main.py          # FastAPI 后端单模块
│   ├── requirements.txt
│   ├── seed_materials.json
│   └── storage/         # 音频产物（gitignore，留 .gitkeep）
├── tests/
│   └── e2e/             # test_flow_e2e.py / test_tts_roles_e2e.py / test_edge_e2e.py
├── reports/             # 问题报告等
└── scripts/
    └── package.sh       # 打包脚本（绝对路径输出，勿改回相对路径）
```

## 3. 前端代码约定（Frontend）

- **单文件自包含**：CSS 内联 `<style>`、JS 内联 `<script>`，不拆分 js/css，不用构建工具。
- **原生 JS**：状态用普通对象（`state`）+ 重渲染函数；不用框架、不用 `type="module"`。
- **i18n 三处同步**：任何界面文案改动必须同时改三处——HTML 默认文本（`data-i18n="key"` 的 textContent）、en 字典、zh 字典；删文案时三处一起删，不得残留引用。
- **API 层**：所有 `/api/v1/*` 调用走 `apiFetch`（统一超时、非 JSON 响应容错），网络错误给出「Cannot reach backend … open http://localhost:8000」类可操作提示；软调用用 `apiFetchSoft` 返回 `{ok:false,error}`。
- **真实链路默认**：`mockMode()` = `localStorage['telg-test-data']` 非空且非 `'off'` 时才走本地模板；否则 LLM/TTS 全部真实调用。Header 徽标（`#eng-mode`/`#eng-dot`）显示 live / test-data。
- **Test Connection 永远真实**：`API.testLLM` 不受 mock 门控，永远打 `/api/v1/config/test-llm`。
- **持久化键（向后兼容）**：`telg-settings`、`telg-theme`、`telg-lang`、`telg-test-data`、`telg-ui`、`telg-dev-mode`、`telg-stored-audio`。新增字段时读取端必须对旧 JSON 容错（缺省回退默认值），写入端保持结构不变。
- **设置项持久化**：所有设置保存在 `telg-settings` 单 JSON（lang/theme/defSpeed/seekStep/zhDefault/llm/tts 等）；「应用」后生效，写入后立即应用到 `state` 并调用对应 render/update 函数。
- **僵尸按钮红线**：任何可点击元素必须有真实 handler；`<a>` 不得无意义 `href="#"`。

## 4. 视觉与交互红线（用户历次反馈沉淀）

- 风格：简洁、克制、内容优先；中性背景、弱边框、少阴影、单一 accent；参考 OpenCode / Linear / Vercel / Spotify。
- 禁止：AI Dashboard 风格、大量 Card、彩色 Badge、Gradient/Glow、粒子效果、巨大 Waveform、Chat Bubble Transcript、无意义动画。
- 图标：功能图标用内联 SVG symbol（`<use href="#i-*">`），必须清晰不模糊——**禁止用 SVG `<text>` 元素画数字/文字**（小尺寸渲染模糊），数字信息用 HTML 元素叠加。
- 设置页：弱 Tab 左导航；Tab 图标 + 文字；每个设置项独立一行；说明文字精简专业、不冗余、不含 emoji；标题层级要清晰；窄窗口下不挤压变形。
- 深浅主题切换用醒目 toggle；中文字幕开关也是 toggle（只显示开/关）。
- 二次确认弹窗（删除等）必须美观、结构清晰。
- 删除/调整等破坏性操作必须先确认；生成步骤提示可回溯；素材状态（语料 → TTS → 发布）与进度条语义一致。

## 5. 测试规则（Testing）

- 三套 e2e：`tests/e2e/test_flow_e2e.py`（全链路）、`test_tts_roles_e2e.py`（TTS 音色角色专项）、`test_edge_e2e.py`（边缘）——跑法：
  ```bash
  cd /home/user/Doubao/chats/38441710896760066
  python3 telg-project/tests/e2e/test_*.py
  ```
- 浏览器：`executable_path='/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome'`、`args=['--no-sandbox']`。
- mock 链路注入：`pg.add_init_script("try{localStorage.setItem('telg-test-data','tire')}catch(e){}")`。
- **验收硬性条件**：console errors / JS errors 必须为空；页面无横向溢出。
- 改动涉及新持久化字段时，测试需兼容旧 `telg-settings`（不带新字段的 JSON）。

## 6. 打包脚本（Packaging）

- `scripts/package.sh`：输出绝对路径 `$PARENT/telg-project.zip`（勿改回相对路径，否则会打进包内层）；打包前清理 `frontend/_shots/`；完成后校验前缀 `telg-project/` 与文件数。
- 打包时机：仅用户明确要求。

## 7. Git 规则（Git）

- 远程：`https://github.com/keepwendell/telg-project.git`，branch `main`。
- 凭据：已持久化于 `~/.git-credentials`（chmod 600）+ `credential.helper store`，push 自动认证。
- **推送时机**：仅用户明确要求「推送到 GitHub / 同步远程」时才执行 `git push origin main`；本地 commit 可按需执行。
- **本地 commit 也需用户确认**：任何 commit（含本地）执行前必须先向用户说明本次要提交的改动范围与拟定 commit message，经用户确认后才 `git commit`；未确认不得主动提交。
- **推送必须写清楚 commit**：每次推送远程时，向用户说明本次推送包含的 commit（hash + message 概要 + 具体改动内容），不得含糊带过。
- commit message：`<type>: <summary>`（feat/fix/ui/docs/refactor），英文简洁。
- **commit 中英双语 + 重点化标题 + 具体变更点（中文在前，英文在后）**：
  - 标题（subject）体现变更的关键重点，格式 `<type>: 中文重点 / EN key point`（如 `feat: 播放器图标清晰化与步长可配置 / clearer seek icons & configurable step`），不写泛泛的 "update/refactor" 式标题。
  - 正文（body）逐条列明本次的具体变更点（what changed），中英双语，**每条中文在前、英文在后**。
  - 推送汇报时同样以双语列出标题与变更点（中文在前）。

## 8. 变更记录（Changelog of rules）

| 日期 | 规则变更 | 来源 |
|------|----------|------|
| 2026-09-15 | 新增第 1 节：默认只交付 index.html，打包/推送按需 | 用户：「后续只有当我要求提供打包和远程推送时你再提供即可，平时只需提供index」 |
| 2026-09-15 | 第 7 节补充：推送远程时必须写清楚 commit（hash + 概要 + 改动内容） | 用户：「后续推送远程仓库时应该写清楚commit」 |
| 2026-09-15 | 第 7 节补充：commit 标题与正文均需中英双语 | 用户：「commit要提供中英双语的标题和内容」 |
| 2026-09-15 | 第 7 节细化：标题体现变更关键重点（类型-标题），正文逐条列具体变更点 | 用户：「标题应体现变更的关键重点（变更类型-标题），commit正文写清楚本次的具体变更点」 |
| 2026-09-15 | 第 7 节明确语序：中英双语一律中文在前、英文在后 | 用户：「好的 中文在前，英文在后」 |
| 2026-09-15 | 本文件创建，沉淀此前已确认的全部约定 | 用户：「将工程目录新建一个目录，存放持久性的记忆规则」 |
| 2026-09-16 | 第 7 节补充：本地 commit 也需用户确认后执行 | 用户：「本地commit太频繁了 也需要我确认后再提交」 |

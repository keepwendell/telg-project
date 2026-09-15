# TELG 项目运行指南（Running Guide）

> 版本：2026-09-15 · 适用工程：telg-project（单文件前端 + FastAPI 后端）
>
> ⚠️ **重要**：本指南基于「现状」编写。当前后端存在 1 个阻断性 bug（P1，见文末「已知问题」），
> 真实后端模式需先按 P1 的修复建议处理后方可启动；纯前端体验不受影响。

---

## 1. 工程形态速览

| 组件 | 位置 | 说明 |
|------|------|------|
| 前端 | `frontend/index.html` | 单文件、原生 JS、无构建；唯一的 UI 交付物 |
| 后端 | `backend/main.py` | FastAPI + SQLite（`backend/telg.db`），含 LLM/配置/素材/播放列表/诊断接口 |
| 种子数据 | `backend/seed_materials.json` | 首次启动播种 3 个素材（m1/m2/m3）与 4 个播放列表 |
| 音频目录 | `backend/storage/audio/` | 合成产物（当前 synthesize 为 stub，未实际生成） |
| 测试 | `tests/e2e/*.py` | 3 套 Playwright e2e（全链路 35 / TTS 专项 10 / 边缘 11） |
| 规则 | `rules/author-rules.md` | 代码作者持久工作规则 |
| 文档 | `docs/` | 产品/架构/契约/设计系统/运行指南 |

## 2. 两种运行方式

### 方式 A：纯前端体验（无需后端，推荐先试）

打开 `frontend/index.html`（浏览器直接双击即可），走「设置 → 开发者模式 → 测试数据」链路：

- 测试数据开关选择固定数据集（tire / canbus / tv）后，**生成 → 语料 → 合成 → 发布 → 播放 → 管理**全流程
  使用本地模板数据，离线可跑通；
- 测试数据选择 **Off · live LLM/TTS** 时，前端会真实请求 `http://127.0.0.1:8000/api/v1/*`（需后端运行）。

> 注意：方式 A 仅用 `file://` 打开时，Off 模式下所有 API 调用会报
> 「Cannot reach backend」——这是预期的（无后端），切回测试数据即可离线使用。

### 方式 B：真实后端（FastAPI + SQLite）

```bash
cd backend
python -m venv .venv && source .venv/bin/activate   # 建议虚拟环境
pip install -r requirements.txt
python main.py               # http://127.0.0.1:8000
```

- 后端同源托管前端与 `/api/v1/*`，浏览器访问 **`http://127.0.0.1:8000`**；
- ⚠️ 不要用 `file://` 双击，也不要用 `python -m http.server` 单独托管前端——`/api/v1` 会打到静态服务器返回 HTML，
  连接测试报「Backend returned HTML instead of JSON」；
- **当前阻断**：见下方「已知问题 P1」——`backend/main.py` 中前端目录路径错误会导致启动即抛异常，
  需按修复建议修改后才可启动。

## 3. 配置（Settings）

所有设置位于「设置」弹窗（Header 齿轮），「Apply」后生效并持久化到浏览器 `localStorage['telg-settings']`：

| Tab | 关键项 | 说明 |
|-----|--------|------|
| General | 语言 / 主题 / 默认倍速 / 快进退步长（5/10/15/30s）/ 中文字幕开关 | 播放与显示默认值 |
| LLM | Provider / Model / Base URL / API Key / Temperature | 真实调用时必填；Key 只随请求发送，**不持久化到本地存储**（重启后需重填）；可「Test Connection」 |
| TTS | Voice Roles（每角色独立行 + 自定义试听文本 + 试听按钮）/ 语速 | 试听走 `/api/v1/config/test-tts`（edge-tts） |
| Shortcuts | 快捷键列表 | 展示与说明 |
| Developer | 开发者模式开关（解锁 key：`telg-dev`）→ LLM/TTS 诊断与测试数据 | 诊断请求/响应展示；测试数据切模板 |
| About | 契约说明 / 版本 | 只读 |

**LLM 配置示例（DeepSeek）**：Base URL `https://api.deepseek.com/v1`、Model `deepseek-chat`。
兼容 OpenAI-compatible 服务（OpenAI / Qwen / 豆包 / Kimi 等，按各自 base_url + model）。

## 4. 测试（Tests）

```bash
cd /home/user/Doubao/chats/38441710896760066
python3 telg-project/tests/e2e/test_flow_e2e.py       # 全链路 35 项
python3 telg-project/tests/e2e/test_tts_roles_e2e.py  # TTS 音色角色专项 10 项
python3 telg-project/tests/e2e/test_edge_e2e.py       # 边缘 11 项
```

- 浏览器：Playwright chromium（`/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome`，`--no-sandbox`）；
- e2e 通过 `add_init_script` 预置 `localStorage['telg-test-data']='tire'` 走 mock 链路，**不依赖后端**；
- 验收硬性条件：console errors / JS errors 为空、页面无横向溢出。

## 5. 打包（Packaging）

```bash
./scripts/package.sh     # 输出 工程根/../telg-project.zip（绝对路径），打包前清理 frontend/_shots/
```

仅当用户明确要求「打包」时执行；交付 = zip + `frontend/index.html` 双件。

## 6. Git

- 远程 `https://github.com/keepwendell/telg-project.git`（branch `main`），凭据已持久化（`~/.git-credentials`，600）；
- 仅用户明确要求「推送」时执行 `git push origin main`；commit 中英双语、标题体现关键重点、正文列具体变更点（中文在前）。

## 7. 已知问题（2026-09-15 检查）

| 编号 | 级别 | 问题 | 影响 | 修复建议 |
|------|------|------|------|----------|
| P1 | 🔴 阻断 | `backend/main.py` 的 `FRONTEND_DIR = BASE_DIR.parent / "telg"`，但前端实际在 `frontend/`，目录不存在 → `StaticFiles` 挂载即抛 `RuntimeError`，`python main.py` 无法启动 | 真实后端模式完全不可用 | 改为 `BASE_DIR.parent / "frontend"`（并确认 storage 目录存在） |
| P2 | 🟠 功能缺口 | `POST /materials/{mid}/synthesize` 为 stub：仅改写 meta（`audioReady=True`），不调用 edge-tts、不生成 mp3、不回填真实时间轴 | 真实模式「合成」不产出可播放音频，句级时间轴为估算值 | 按逐句 edge-tts 合成 → 拼接 → 回填 `start_ms/end_ms` 实现 |
| P3 | 🟠 数据一致性 | 种子素材（m1/m2/m3）`status=published`、`audioReady=True`，但 `storage/audio/` 无对应 mp3 | 真实模式点击种子素材播放 → `/api/v1/audio/m1.mp3` 404 | 方案 a：种子改为 `draft` 并标记未合成；方案 b：首次启动为种子生成占位音频 |
| P4 | 🟡 过时注释 | `backend/main.py` 头部注释仍描述「Phase 2/3 mock 阶段」，与真实 LLM 已接入的现状不符 | 误导维护者 | 更新注释 |
| P5 | 🟡 次要 | `health` 返回硬编码 `mock: False, phase: 1`，字段无实际依据 | 诊断信息失真 | 返回真实服务状态或精简字段 |

> 修复优先级建议：P1（启动）→ P3（数据一致性）→ P2（真实 TTS）→ P4/P5（清理）。
> 完整检查过程与复现见 `reports/issue-report-runtime-2026-09-15.md`。

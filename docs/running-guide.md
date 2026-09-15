# TELG 项目运行指南（Running Guide）

> 版本：2026-09-15（含运行时修复）· 适用工程：telg-project（单文件前端 + FastAPI 后端）
>
> 2026-09-15 运行时检查发现的问题（P1–P6）已全部修复并验证，见文末「修复记录」。

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

## 7. 运行时修复记录（2026-09-15）

2026-09-15 运行时检查发现 6 项问题，已全部修复并验证：

| 编号 | 级别 | 问题 | 修复 | 验证结果 |
|------|------|------|------|----------|
| P1 | 🔴 阻断 | `FRONTEND_DIR` 指向不存在的 `telg/`，前端页面未托管 | 改为 `BASE_DIR.parent / "frontend"` | `http://127.0.0.1:8000/` 返回 index.html |
| P2 | 🟠 功能缺口 | synthesize 为 stub，无真实 TTS | 实现逐句 edge-tts 合成 → ffmpeg 拼接 → `start_ms/end_ms` 回填；支持前端音色/语速透传（`SynthIn`） | m1/m2 真实合成成功（68.1s / 35.6s），时间轴逐句回填，音频可下载播放 |
| P3 | 🟠 数据一致性 | 种子素材标记 published 但无音频 | 种子改 `draft`；旧库启动时 `migrate_audio_status()` 自动降级无音频的 published/audio_ready 素材 | 种子素材 audioReady=False，合成后转 audio_ready |
| P4 | 🟡 过时注释 | 头部注释描述旧 mock 阶段 | 更新为真实 LLM/TTS 现状 | 审读通过 |
| P5 | 🟡 次要 | `health` 硬编码字段 | 改为真实 DB 可达检查 | `{"status":"ok"}`；DB 异常时 503 |
| P6 | 🟡 运行方式 | `python main.py` 直接退出（无启动入口） | 补充 `if __name__ == "__main__": uvicorn.run(...)` | `python main.py` 正常启动服务 |

> 验证方式：`python main.py` 启动 → health/前端托管/素材列表 → 真实 synthesize（HTTP 层 + UI 全链）→ 前端真实模式播放 → 三套 e2e 回归（35/35、10/10、11/11）全部通过。
> 完整检查过程见 `reports/issue-report-runtime-2026-09-15.md`。

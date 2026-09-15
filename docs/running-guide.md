# TELG 项目运行指南（Running Guide · Windows 适配版）

> 版本：2026-09-15 · 适用工程：telg-project（单文件前端 + FastAPI 后端）
> 本指南以 **Windows 本地调试** 为主场景（也兼容 Linux / macOS，差异见第 6 节）。

---

## 0. 工程形态速览

| 组件 | 位置 | 说明 |
|------|------|------|
| 前端 | `frontend/index.html` | 单文件、原生 JS、无构建；唯一的 UI 交付物 |
| 后端 | `backend/main.py` | FastAPI + SQLite；真实 LLM（OpenAI 兼容）生成 + 真实 edge-tts 逐句合成 |
| 种子数据 | `backend/seed_materials.json` | 首次启动播种 3 个素材（m1/m2/m3，未合成状态）+ 4 个播放列表 |
| 音频产物 | `backend/storage/audio/` | 合成后生成 `{id}.mp3`（运行期产物，不入 git） |
| 测试 | `tests/e2e/*.py` | 3 套 Playwright e2e（全链路 35 / TTS 专项 10 / 边缘 11） |
| 文档 | `docs/` · `rules/` | 产品/架构/契约/设计系统/运行指南 · 代码作者工作规则 |

---

## 1. 环境要求（Windows）

| 依赖 | 版本/方式 | 必装原因 |
|------|-----------|----------|
| Windows 10/11 64 位 | — | 运行环境 |
| Python | **3.10+**（推荐 3.11/3.12），安装时**勾选 "Add python.exe to PATH"** | 后端 + 测试 |
| ffmpeg / ffprobe | 见下方安装命令 | **后端合成必需**（逐句音频拼接与时长探测） |
| 网络 | 可访问 `speech.platform.bing.com`（edge-tts）与你的 LLM API 域名 | 真实合成/生成 |

**Python 安装**（若没有）：
```
https://www.python.org/downloads/  → 下载 Windows installer → 安装时勾选 Add python.exe to PATH
```

**ffmpeg 安装**（二选一，PowerShell）：
```powershell
# 方式 1：winget（Windows 10/11 自带）
winget install Gyan.FFmpeg

# 方式 2：choco（需先装 Chocolatey）
choco install ffmpeg -y
```
装完**新开一个终端**（刷新 PATH），验证：
```powershell
ffmpeg -version   # 有输出即 OK
ffprobe -version
```

**工程目录**：把 `telg-project` 解压到**无中文、无空格**的路径，例如 `D:\dev\telg-project`。
（避免部分工具在含中文/空格的路径上出问题。）

---

## 2. 快速开始

### 路径 A：纯前端体验（不需要后端 / ffmpeg，最快）

1. 打开 `frontend/index.html`（资源管理器双击，默认浏览器打开）；
2. 右上角「设置」→「开发者模式」→「测试数据」选择任一固定数据集（tire / canbus / tv）；
3. 此时 生成 → 语料 → 合成 → 发布 → 播放 → 管理 全流程**离线可用**（走本地模板，不请求后端）。

> 注意：纯前端方式下若把测试数据切为 **Off · live LLM/TTS**，会请求 `http://127.0.0.1:8000/api/v1/*`，
> 没有后端时提示「Cannot reach backend」是预期行为——切回测试数据即可离线使用。

### 路径 B：真实后端全功能（Windows 本地调试，推荐）

**第 1 步：打开 PowerShell，进入 backend 目录**
```powershell
cd D:\dev\telg-project\backend
```

**第 2 步：创建并激活虚拟环境**
```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1        # 若提示“禁止运行脚本”，见常见问题 ③
```
> 命令行前出现 `(.venv)` 即激活成功。

**第 3 步：安装依赖**
```powershell
pip install -r requirements.txt
```

**第 4 步：启动后端**
```powershell
python main.py
```
看到 `Uvicorn running on http://127.0.0.1:8000` 即成功。**保持此终端不要关闭**。

**第 5 步：浏览器访问**
```
http://127.0.0.1:8000
```
> ⚠️ **必须通过 8000 端口访问前端**（后端同源托管前端 + `/api/v1`）。
> 不要用 `file://` 双击 index.html 走真实模式，也不要用 `python -m http.server` 单独托管——`/api/v1` 会打到静态服务器返回 HTML 404。

**第 6 步：配置并验证 LLM（生成语料用）**
1. 右上角「设置」→「LLM」Tab；
2. 填 Base URL / Model / API Key（例如 DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`）；
3. 点 **Test Connection** → 应显示模型名 + 延迟（毫秒）；
4. 点 **Apply** 保存（Key 只随请求发送，不持久化，重启后需重填）。

**第 7 步：生成并合成一份真实素材**
1. 首页输入 Topic（如 `Tire Burst Stability Control`），选 Domain / Role / Scenario / Difficulty / Length；
2. 点 **Generate** → 等待 LLM 返回（几秒～几十秒）；
3. 语料生成后点 **Set Voice & Synthesize** → 选择音色/语速 → 确认；
4. 等待 edge-tts 逐句合成 + 拼接（几十秒），完成后自动起播；
5. 素材进入左侧列表，可 重命名 / 调整（语料与音色）/ 删除（二次确认）/ 发布。

---

## 3. 验证清单（按顺序自检）

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | `ffmpeg -version` | 显示版本信息 |
| 2 | `.venv\Scripts\Activate.ps1` | 提示符出现 `(.venv)` |
| 3 | `python main.py` | `Uvicorn running on http://127.0.0.1:8000` |
| 4 | 浏览器打开 `http://127.0.0.1:8000` | 显示 TELG 主界面（深色） |
| 5 | 设置 → LLM → Test Connection | 显示模型名 + 延迟，非红色报错 |
| 6 | Generate 一个 Topic | 主区出现 Preview（背景/原理/对话/词汇/题目） |
| 7 | Set Voice & Synthesize | 进度走完，自动播放真实音频；Transcript 随播放逐句高亮 |
| 8 | 左侧列表 | 新素材出现；刷新浏览器后仍在（SQLite 持久化） |

---

## 4. 常见问题（Windows 专属）

| # | 现象 | 原因与解决 |
|---|------|------------|
| ① | `'python' 不是内部或外部命令` | Python 未加入 PATH：重装并勾选 "Add python.exe to PATH"，或手动把 Python 安装目录加入系统环境变量 PATH，然后**重开终端** |
| ② | `ffmpeg: 未找到命令` / 合成报 `ffprobe failed` | ffmpeg 未装或 PATH 未刷新：执行第 1 节 ffmpeg 安装命令后**新开终端** |
| ③ | `.venv\Scripts\Activate.ps1 无法加载，因为在此系统上禁止运行脚本` | PowerShell 执行策略限制。二选一：<br>a) `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`（输入 Y 确认）；<br>b) 改用 cmd：`cd D:\dev\telg-project\backend` → `.venv\Scripts\activate.bat` |
| ④ | 8000 端口被占用 | `netstat -ano \| findstr :8000` 看占用 PID，`taskkill /PID <PID> /F` 或换端口（改 `backend/main.py` 末尾 `port=8000` 为其他值） |
| ⑤ | 首次启动 Windows 防火墙弹窗 | 点「允许访问」。若弹窗未出现但仍连接被拒（`127.0.0.1 拒绝连接` 且 `netstat -ano \| findstr :8000` 有监听），可能是防火墙/安全软件拦截了本机回环：<br>**临时关闭防火墙（管理员 CMD）**：`netsh advfirewall set allprofiles state off`<br>**调试完务必恢复**：`netsh advfirewall set allprofiles state on`<br>（关闭期间本机入站连接无防护，仅建议在可信网络下短暂调试使用） |
| ⑥ | 点 Test Connection 报 `Backend returned HTML instead of JSON` | 前端不是通过 `http://127.0.0.1:8000` 打开（如 file:// 或其它静态端口）。改为通过 8000 访问 |
| ⑦ | 合成报 `TTS synthesis failed` | edge-tts 需联网访问微软语音服务：检查网络/代理；临时可用「开发者模式 → 测试数据」验证其余功能 |
| ⑧ | `pip install` 慢/失败 | 换国内镜像：`pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple` |
| ⑨ | Generate 报 `LLM API key not configured` | 设置里填 Key 并 **Apply**；或设置环境变量 `DEEPSEEK_API_KEY`（PowerShell：`$env:DEEPSEEK_API_KEY="sk-..."`） |

---

## 5. 运行测试（Windows，可选）

```powershell
# 1. 安装 Playwright 与浏览器（一次性）
pip install playwright
playwright install chromium

# 2. 运行三套 e2e（脚本自动检测系统浏览器：本机用 Playwright 自带 chromium）
cd D:\dev\telg-project
python tests\e2e\test_flow_e2e.py
python tests\e2e\test_tts_roles_e2e.py
python tests\e2e\test_edge_e2e.py
```
预期：三套全部通过（35 / 10 / 11），`console errors: []`。
> e2e 通过注入 `localStorage['telg-test-data']` 走模板数据，**不依赖后端与网络**。

---

## 6. Linux / macOS 差异

| 事项 | Windows | Linux / macOS |
|------|---------|---------------|
| Python 命令 | `python` | `python3` |
| 激活虚拟环境 | `.venv\Scripts\Activate.ps1` | `source .venv/bin/activate` |
| ffmpeg | winget/choco | `sudo apt install ffmpeg` / `brew install ffmpeg` |
| 路径分隔 | `\` | `/` |
| 打包脚本 | 需 Git Bash / WSL（见下） | 直接 `./scripts/package.sh` |

---

## 7. 打包与 Git（Windows）

**打包 zip**（`scripts/package.sh` 是 bash 脚本）：
- 方式 1：安装 Git for Windows（自带 Git Bash）→ 右键工程根目录 → "Git Bash Here" → `./scripts/package.sh`；
- 方式 2：直接手动复制工程目录（排除 `.git/`、`backend/.venv/`、`backend/storage/audio/*.mp3`、`backend/telg.db`、`frontend/_shots/`、`__pycache__/`）。

**Git 推送**（如有需要）：
```powershell
cd D:\dev\telg-project
git add -A
git commit -m "提交说明（中英双语）"
git push origin main
```
> 推送凭据若提示输入，在 GitHub 生成 PAT 后：
> `git remote set-url origin https://<USERNAME>:<PAT>@github.com/keepwendell/telg-project.git`
> 或配置 `git config --global credential.helper manager`（Windows 凭据管理器）。

---

## 8. 运行期数据与重置

| 数据 | 位置 | 重置方式 |
|------|------|----------|
| SQLite 数据库 | `backend/telg.db` | 删除后重启 `python main.py`（自动重建并播种） |
| 合成音频 | `backend/storage/audio/*.mp3` | 可手动清理；素材状态会经启动迁移自动降为未合成 |
| 前端设置 | 浏览器 `localStorage` | 开发者工具 → Application → Local Storage → 清除 |

---

## 9. 运行时修复记录（2026-09-15）

| 编号 | 问题 | 修复 | 验证 |
|------|------|------|------|
| P1 | 前端托管路径错误 | `FRONTEND_DIR = backend/../frontend` | 8000 正常返回页面 |
| P2 | synthesize 为 stub | 真实逐句 edge-tts + ffmpeg 拼接 + 时间轴回填，支持音色/语速透传 | m1 68.1s / m2 35.6s 真实合成，可播放 |
| P3 | 种子无音频却标记已发布 | 种子 draft + 旧库启动自动降级 | 未合成素材正确显示不可播 |
| P4 | 过时注释 | 更新 | 审读通过 |
| P5 | health 硬编码 | DB 可达检查 | `{"status":"ok"}` |
| P6 | `python main.py` 无入口 | 补 `__main__` uvicorn | 正常启动 |

> 完整检查报告见 `reports/issue-report-runtime-2026-09-15.md`。

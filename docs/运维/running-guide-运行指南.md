# TELG 运行指南（Windows 版）

> 版本：2026-09-16 · 适用工程：telg-project（单文件前端 + FastAPI 后端）
> 这篇指南带你在 Windows 电脑上把 TELG 跑起来：装环境 → 启动 → 生成素材 → 播放管理 → 跑测试。
> Linux / macOS 的差异见 [第 6 节](#6-linux--macos-差异)。

---

## 0. 开始之前：先了解你要跑的是什么

TELG 是一个纯 PC 的**技术英语听力工具**：你输入一个技术主题，它生成一段真实场景的技术英语对话，并合成可逐句跟读的音频。

它由两部分组成：

| 组件 | 位置 | 作用 |
|------|------|------|
| 后端 | `backend/main.py` | FastAPI 服务：调 LLM 生成语料、合成音频（edge-tts 在线 / Kokoro 本地离线，可切换）、存储素材到 SQLite |
| 前端-主页面 | `frontend/index.html` | 单文件页面：生成/播放/管理界面（后端启动后会自动托管它） |
| 前端-首启引导 | `frontend/onboarding.html` | 欢迎页 + 本地账号 + LLM 配置 + 个性化档案问卷（与主页面同源，共享 localStorage，可单独打开调试） |

所以**只要启动后端**，打开浏览器访问 `http://127.0.0.1:8000`，整个产品就都在了。

**首次打开**会进入首启引导（`onboarding.html`）：注册本地账号 → 配置 LLM（可跳过，稍后在设置里补）→ 填写个性化问卷 → 生成/确认学习档案 → 进入主页面。引导完成后主页面可直接打开；引导数据（账号、档案、学习目标）与主页面完全互通。调试时也可以单独打开 `http://127.0.0.1:8000/onboarding.html` 走一遍引导，或用 `http://127.0.0.1:8000/index.html` 直进主页面。

你有两种使用方式，按需选择：

- **路线 A（最快，离线）**：纯前端 + 内置测试数据，不需要后端、不需要装任何东西，5 分钟体验完整流程；
- **路线 B（完整功能，推荐）**：真实后端，接入你的 LLM API + TTS 合成（默认 edge-tts；网络不通时可选 Kokoro 本地离线引擎），生成真正可听的素材。

下面从准备工作开始，两条路线都会带你们走到。

---

## 1. 准备工作：装好三样东西

这三样**只需要安装一次**。装好后，以后每次调试都不需要重复。

### 1.1 安装 Python（3.10 或更高，推荐 3.11/3.12）

1. 打开 <https://www.python.org/downloads/>，下载 Windows 安装包；
2. 运行安装器，**务必勾选 "Add python.exe to PATH"**（这步漏了会导致命令找不到）；
3. 装完后**新开一个终端**，验证：

```powershell
python --version   # 应显示 Python 3.10.x 或更高
```

### 1.2 安装 ffmpeg（音频合成必需）

TELG 合成音频时要用 ffmpeg 拼接逐句音频、探测时长。二选一：

```powershell
# 方式 1：winget（Windows 10/11 自带）
winget install Gyan.FFmpeg

# 方式 2：choco（需先装 Chocolatey）
choco install ffmpeg -y
```

装完**新开一个终端**（刷新 PATH），验证：

```powershell
ffmpeg -version    # 有版本信息即 OK
ffprobe -version
```

### 1.3 确认网络

真实模式需要访问外部服务（测试数据模式不需要）：

- `speech.platform.bing.com` —— **edge-tts** 语音合成（若改用 Kokoro 离线引擎则**不需要**此域名）
- 你的 LLM API 域名（如 DeepSeek 的 `api.deepseek.com`）

> 如果你的网络访问 `speech.platform.bing.com` 超时（常见于公司网络/部分地区），在设置页把 **Synthesis Engine 切换为 `Kokoro (Local offline)`** 即可离线合成，不依赖任何外网 TTS 服务。

### 1.4 放好工程目录

把 `telg-project` 文件夹放到**无中文、无空格**的路径，例如 `D:\dev\telg-project`。
（避免部分工具在中文/空格路径上出问题。）

---

## 2. 路线 A：纯前端体验（最快，5 分钟，离线）

不需要后端、不需要 ffmpeg、不需要 API Key，用内置测试数据走一遍完整流程：

1. 双击打开 `frontend/index.html`（资源管理器 → 默认浏览器打开）；
2. 右上角 **设置 → 开发者模式 → 测试数据**，选择任一固定数据集（`tire` / `canbus` / `tv`）；
3. 回到首页，输入 Topic，点 **Generate** → 语料生成后 **Set Voice & Synthesize** → 发布 → 播放。

> 这条路线走的是本地模板数据。如果页面提示「Cannot reach backend」，说明测试数据被切到了 Off——回到设置里选一个数据集即可。

---

## 3. 路线 B：真实后端全功能（推荐，Windows 本地调试）

一共 6 步，跟着走完就能生成一份真实的、可听的素材。

### 第 1 步：启动后端

打开 PowerShell，进入 backend 目录：

```powershell
cd D:\dev\telg-project\backend
```

**第一次**需要建虚拟环境并装依赖（只需一次）：

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1        # 若提示“禁止运行脚本”，见 FAQ ③
pip install -r requirements.txt
```

> **以后每次调试都不需要重复上面的步骤**。venv 建一次就一直能用，直接启动即可：
>
> ```powershell
> cd D:\dev\telg-project\backend
> .venv\Scripts\python.exe main.py
> ```

#### 3.1 可选：安装 Kokoro 离线 TTS 引擎

Kokoro 是本地离线的语音合成引擎（英文音色自然、无需联网、免 Key）。**只有你想用它时才需要装**：

```powershell
.venv\Scripts\Activate.ps1
pip install -r requirements-tts-kokoro.txt
```

然后下载模型（约 340MB，两个文件）。**推荐放到工程目录内**（随工程一起复制，换环境/团队共用无需重复下载）：

```powershell
# 工程内目录（推荐，随工程复制共享）
$dir = "backend\models\kokoro"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
curl.exe -L -o "$dir\kokoro-v1.0.onnx" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx
curl.exe -L -o "$dir\voices-v1.0.bin"  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin
```

> **模型查找顺序**：`TELG_KOKORO_CACHE` 环境变量 → 工程内 `backend\models\kokoro\` → `%USERPROFILE%\.cache\telg\kokoro\`，按第一个文件齐全的目录使用。
>
> **注意**：`backend\models\` 已在 `.gitignore` 中排除——模型约 340MB，超过 GitHub 单文件 100MB 限制，**不能提交进仓库**。换环境/给同事时把 `backend\models\kokoro\` 整个目录一起复制即可。
>
> 文件校验大小：`kokoro-v1.0.onnx` = 325,505,369 字节；`voices-v1.0.bin` = 28,214,398 字节（防止下载中断导致合成报“文件损坏”）。
>
> **试听/合成偏慢？可试 INT8 量化模型（体积 325MB → 约 114MB）**。引擎会自动检测并优先使用它：
>
> ```powershell
> curl.exe -L -o "$dir\kokoro-v1.0.int8.onnx" https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.int8.onnx
> ```
>
> 下载后**重启后端**即生效。**注意**：INT8 提速效果取决于机器——多核新 CPU 上通常更快；低核（如 2 核）CPU 实测反而更慢。若下载后试听变慢，删除该文件并重启即可回到 fp32 模型。若链接 404，到 thewh1teagle/kokoro-onnx 的 Releases 页面找 `model-files` 系列资产里带 `int8` 的文件。

然后在设置页把 **Synthesis Engine 切换为 `Kokoro (Local offline)`**，音色列表会自动切换为 Kokoro 音色（如 Bella / Heart / Michael / Xiaobei…），试听与合成均在本机完成。

> Windows 若安装 `kokoro-onnx` 报编译错误，先装 Visual Studio Build Tools（"使用 C++ 的桌面开发"工作负载）后重试；若仍失败，可继续使用 edge-tts。
>
> 如果又把工程重新 clone 到了新目录（如 `telg-projectV2`），也**不必重建 venv**——直接复用旧目录的：
> `D:\dev\telg-project\backend\.venv\Scripts\python.exe main.py`。
> 只有换机器或换 Python 大版本时才需要重新建 venv。

启动成功后会看到：

```
Uvicorn running on http://127.0.0.1:8000
```

**保持这个终端不要关闭**。

### 第 2 步：浏览器打开

访问 <http://127.0.0.1:8000>，看到 TELG 主界面（深色）即成功。

> ⚠️ **请务必通过这个地址访问**。TELG 的前端由后端托管，`/api/v1` 接口同源可用。
> 不要直接双击 `index.html` 或单独开静态服务器——那样接口会打错地方，连接测试会报「Backend returned HTML instead of JSON」。

### 第 3 步：配置并验证 LLM（生成语料用）

1. 点右上角 **设置 → LLM**；
2. 填写三个字段（以 DeepSeek 为例）：
   - Base URL：`https://api.deepseek.com/v1`
   - Model：`deepseek-chat`
   - API Key：你的密钥
3. 点 **Test Connection** → 应显示模型名 + 延迟（毫秒），而不是红色报错；
4. 点 **Apply** 保存。

> Key 只随每次请求发送、不持久化存储——重启浏览器后需要重新填（这是刻意设计，见「设置」页说明）。

### 第 4 步：生成你的第一份素材

1. 首页输入一个技术主题，例如 `Tire Burst Stability Control`；
2. 选择 Domain / Role / Scenario / Difficulty / Length（默认值即可）；
3. 点 **Generate**，等待 LLM 返回（几秒到几十秒）；
4. 生成后页面出现 Preview：技术背景、控制原理、对话文本、词汇、听力题。

### 第 5 步：合成音频并播放

1. 点 **Set Voice & Synthesize**（或语料区下方的合成按钮）；
2. 在音频设置里确认音色、语速、情感（默认即可），点确认；
3. 等待 edge-tts 逐句合成 + 拼接（几十秒），进度走完后**自动开始播放**；
4. 播放时 Transcript 会逐句高亮，点击任意句子可跳转。

### 第 6 步：素材管理与发布

合成完成后素材会进入左侧列表。你可以：

- **重命名**：列表内直接改；
- **调整**：改语料（重新生成）或改音色（重新合成）；
- **删除**：需要二次确认；
- **发布**：弹出对话框允许改文件名，发布后才算正式归档。

---

## 4. 跑起来之后：验证清单

按顺序自查一遍，全过即环境健康：

| 步骤 | 操作 | 预期结果 |
|------|------|----------|
| 1 | `ffmpeg -version` | 显示版本信息 |
| 2 | `.venv\Scripts\python.exe main.py` | `Uvicorn running on http://127.0.0.1:8000` |
| 3 | 浏览器打开 `http://127.0.0.1:8000` | 显示 TELG 主界面（深色） |
| 4 | 设置 → LLM → Test Connection | 显示模型名 + 延迟，非红色报错 |
| 5 | Generate 一个 Topic | 主区出现 Preview（背景/原理/对话/词汇/题目） |
| 6 | Set Voice & Synthesize | 进度走完，自动播放真实音频；Transcript 逐句高亮 |
| 7 | 刷新浏览器 | 素材仍在左侧列表（SQLite 持久化） |

---

## 5. 遇到问题？常见问题（FAQ）

| # | 现象 | 原因与解决 |
|---|------|------------|
| ① | `'python' 不是内部或外部命令` | Python 未加入 PATH：重装并勾选 "Add python.exe to PATH"，然后**重开终端** |
| ② | `ffmpeg: 未找到命令` / 合成报 `ffprobe failed` | ffmpeg 未装或 PATH 未刷新：见 1.2，装完**新开终端** |
| ③ | `.venv\Scripts\Activate.ps1 无法加载，因为在此系统上禁止运行脚本` | PowerShell 执行策略限制。二选一：<br>a) `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`（输入 Y 确认）；<br>b) 改用 cmd：`.venv\Scripts\activate.bat` |
| ④ | 8000 端口被占用 | `netstat -ano \| findstr :8000` 看占用 PID，`taskkill /PID <PID> /F`；或改 `backend/main.py` 末尾 `port=8000` 为其他值 |
| ⑤ | `127.0.0.1 拒绝连接`，但 `netstat` 显示有监听 | 防火墙/安全软件拦截本机回环。临时关闭防火墙（管理员 CMD）：`netsh advfirewall set allprofiles state off`；**调试完务必恢复**：`netsh advfirewall set allprofiles state on`（仅建议在可信网络下短暂使用） |
| ⑥ | Test Connection 报 `Backend returned HTML instead of JSON` | 前端不是通过 `http://127.0.0.1:8000` 打开（如 file:// 或其它静态端口）。改为通过 8000 访问 |
| ⑦ | 合成报 `TTS synthesis failed` | edge-tts 需联网访问微软语音服务：检查网络/代理；临时可用「测试数据」验证其余功能 |
| ⑦b | 合成/试听报 `TTS model not downloaded`（Kokoro） | Kokoro 引擎的模型文件缺失：按 3.1 下载 `kokoro-v1.0.onnx` + `voices-v1.0.bin` 到 `backend\models\kokoro\`（工程内，推荐）或 `%USERPROFILE%\.cache\telg\kokoro\` |
| ⑧ | `pip install` 慢/失败 | 换国内镜像：`pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple` |
| ⑨ | Generate 报 `LLM API key not configured` | 设置里填 Key 并 **Apply**；或设置环境变量 `DEEPSEEK_API_KEY`（PowerShell：`$env:DEEPSEEK_API_KEY="sk-..."`） |
| ⑩ | 每次拉到新目录都要新建 venv 吗？ | **不需要**。venv 建一次即可复用：`D:\dev\telg-project\backend\.venv\Scripts\python.exe main.py`。仅换机器 / 换 Python 大版本才重建 |

---

## 6. 运行测试（可选）

工程自带 3 套 Playwright 端到端测试，跑一遍确认所有交互健康：

```powershell
# 第一次先装 Playwright 与浏览器（一次性）
pip install playwright
playwright install chromium

# 然后运行三套测试
cd D:\dev\telg-project
python tests\e2e\test_flow_e2e.py      # 全链路 35 项
python tests\e2e\test_tts_roles_e2e.py # TTS 角色 10 项
python tests\e2e\test_edge_e2e.py      # 边缘场景 11 项
```

预期：三套全部通过，`console errors: []`。
> e2e 通过注入 `localStorage['telg-test-data']` 走模板数据，**不依赖后端与网络**，随时可跑。

---

## 7. Linux / macOS 差异

| 事项 | Windows | Linux / macOS |
|------|---------|---------------|
| Python 命令 | `python` | `python3` |
| 激活虚拟环境 | `.venv\Scripts\Activate.ps1` | `source .venv/bin/activate` |
| 启动后端 | `.venv\Scripts\python.exe main.py` | `.venv/bin/python main.py` |
| ffmpeg | winget / choco | `sudo apt install ffmpeg` / `brew install ffmpeg` |
| 路径分隔 | `\` | `/` |
| 打包脚本 | 需 Git Bash / WSL | 直接 `./scripts/package.sh` |

---

## 8. 打包与 Git（Windows）

**打包 zip**（`scripts/package.sh` 是 bash 脚本）：
- 方式 1：安装 Git for Windows（自带 Git Bash）→ 右键工程根目录 → "Git Bash Here" → `./scripts/package.sh`；
- 方式 2：手动复制工程目录（排除 `.git/`、`backend/.venv/`、`backend/storage/audio/*.mp3`、`backend/telg.db`、`frontend/_shots/`、`__pycache__/`）。

**Git 推送**（如需同步远程）：
```powershell
cd D:\dev\telg-project
git add -A
git commit -m "提交说明（中英双语，见 rules/author-rules-作者规则.md）"
git push origin main
```
> 若提示输入凭据，用 GitHub PAT：
> `git remote set-url origin https://<USERNAME>:<PAT>@github.com/keepwendell/telg-project.git`
> 或 `git config --global credential.helper manager`（Windows 凭据管理器）。

---

## 9. 数据在哪 / 怎么重置

| 数据 | 位置 | 重置方式 |
|------|------|----------|
| SQLite 数据库 | `backend/telg.db` | 删除后重启后端（自动重建并播种种子素材） |
| 合成音频 | `backend/storage/audio/*.mp3` | 可手动清理；素材状态会经启动迁移自动降为未合成 |
| 前端设置 | 浏览器 `localStorage` | 开发者工具 → Application → Local Storage → 清除 |

---

## 10. 运行时修复记录（历史）

> 完整检查报告见 `reports/运行时问题检查/检查报告.md`。

| 编号 | 问题 | 修复 |
|------|------|------|
| P1 | 前端托管路径错误 | `FRONTEND_DIR = backend/../frontend`，8000 正常返回页面 |
| P2 | synthesize 为 stub | 真实逐句 edge-tts + ffmpeg 拼接 + 时间轴回填，支持音色/语速透传 |
| P3 | 种子无音频却标记已发布 | 种子 draft + 旧库启动自动降级 |
| P4 | 过时注释 | 更新 |
| P5 | health 硬编码 | DB 可达检查，返回 `{"status":"ok"}` |
| P6 | `python main.py` 无入口 | 补 `__main__` uvicorn，正常启动 |

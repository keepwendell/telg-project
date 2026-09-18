# TELG Kokoro 引擎适配计划（P1）

> 版本：2026-09-16 · 状态：**done（2026-09-18 已接入：`requirements-tts-kokoro.txt` + 合成引擎切换 + INT8 支持，见运行指南 §3.1）** · 关联文档：[TTS 引擎选型调研](./design-tts引擎选型.md) / [总体架构](../架构/architecture-总体架构.md) / [接口契约](../架构/api-contract-接口契约.md)

---

## 一、背景与目标

TELG 当前 TTS 唯一真实引擎是 edge-tts（联网逆向接口，大陆/新加坡网络常超时被拦）。经 20 方案调研，选定 **Kokoro-82M 作为新增主力离线引擎**（英文音色第一梯队、CPU 实时、Apache-2.0、ONNX 生态跨端可迁移）。本计划定义 Kokoro 从零到接入 TELG 的实施路径。

**目标**：Kokoro 成为 TELG 第二个真实 TTS 引擎（离线主力），与 edge-tts 以可插拔方式并存；合成管线、失败处理、前端交互全部复用现有机制。

---

## 二、已核实的关键事实（2026-09-16 实测/查证）

| 项 | 事实 |
|---|---|
| Python 包 | `pip install kokoro-onnx soundfile`（已实测安装成功） |
| API | `Kokoro.create(text, voice, speed=1.0, lang='en-us', sentence_pause=0.25, clause_pause=0.1) -> (samples: NDArray[float32], sample_rate)` |
| 输出 | 24kHz 单声道 float32 numpy 数组（`soundfile` 写 wav bytes） |
| 模型 | v1.0：8 语言 54 音色（英文 `af_*`/`am_*` 10+ 个，中文 `zf_*` 5 个）；ONNX 约 310MB / INT8 约 80MB |
| License | Apache-2.0（模型+代码，可商用） |
| 硬件 | CPU 实时（老 U 亦可用）；GPU 约 33x 实时 |
| 依赖 | onnxruntime + misaki（G2P，espeak-ng 数据）——**Windows 编译风险点待实测** |
| 句间停顿 | `sentence_pause`/`clause_pause` 参数原生支持，正好对齐 TELG 句间缓冲需求 |

---

## 三、架构设计（可插拔引擎）

```
TTSEngine(ABC)
 ├─ async synthesize(text, voice, **kwargs) -> bytes   # 逐句合成，返回 wav bytes
 ├─ available_voices() -> list[VoiceInfo]              # 音色列表（含语言/展示名）
 ├─ requires_gpu / is_online                           # 引擎元信息
 └─ ensure_loaded()                                    # 懒加载模型，缺失时抛分类错误

engines = { 'edge-tts': EdgeTTSEngine(),              # 现有实现包一层
            'kokoro':   KokoroEngine() }              # 新增
```

- **合成管线复用**：现有「逐句合成 → 拼接 → 时间戳回填」逻辑不动，仅替换"单句音频来源"
- **模型懒加载**：首次合成时检查 `~/.cache/telg/kokoro/`（`kokoro.onnx` + `voices.bin`）；缺失时返回明确分类错误（`model_missing`），前端横幅提示 + 提供下载指引
- **失败分类扩展**：在现有 `tts_error_class` 基础上增加 `model_missing` 类别，前端文案同步补充

---

## 四、前端改动

1. **Provider 下拉**：`edge-tts / Kokoro`（Piper 移除，CosyVoice 保留并标注 coming soon）
2. **音色列表动态化**：后端新增 `GET /api/v1/tts/voices?provider=kokoro`，按 Provider 返回音色（id、展示名、语言标签）；前端角色选择据此渲染
3. **试听真实化**：试听请求按当前 Provider 路由到对应引擎，Kokoro 走本地合成
4. **默认音色**：英文 `af_bella`（清晰）/ `af_heart`（温暖）；中文素材可用 `zf_*` 5 音色

---

## 五、实施步骤

| 步骤 | 内容 | 工作量 | 验收 |
|---|---|---|---|
| P1.0 环境验证 | 沙箱下载模型、验证合成质量/耗时/长文本分段；**Windows 实测安装**（espeak-ng/misaki 是否需 VS Build Tools） | 0.5 天 | 单句与长文本合成可用；Windows 安装结论明确 |
| P1.1 后端引擎 | `TTSEngine` 抽象 + `KokoroEngine` + 引擎注册路由 + 模型缓存管理 + voices 接口 | 0.5–1 天 | 试听与合成按 provider 路由；模型缺失报分类错误 |
| P1.2 前端适配 | Provider/音色列表动态化、试听真实化 | 0.5 天 | 下拉与角色选择按引擎渲染；试听可听 |
| P1.3 集成验证 | 整篇合成时间戳对齐、失败处理、README 更新（含 Windows/模型下载说明） | 0.5 天 | 端到端素材可播放；失败路径友好提示 |

合计约 **2–3 天**。

---

## 六、模型与缓存管理

- 缓存目录：`~/.cache/telg/kokoro/`（跨项目复用；Windows 为 `%USERPROFILE%\.cache\telg\kokoro\`）
- 下载源：HF 主源 + **ModelScope 镜像**（大陆加速）；提供 `scripts/download_kokoro.py` 手动下载脚本，也支持用户手动放置模型文件
- 模型不打入 git、不打入打包产物；`requirements.txt` 新增 `kokoro-onnx`、`soundfile`

---

## 七、跨端演进分析（移动 / iOS / macOS）

**结论：Kokoro 是本次选型中唯一"后端到端侧均可迁移"的方案，移动端可用，且是长期红利。**

两条路径：

| 路径 | 说明 | 适用 |
|---|---|---|
| **A. 客户端-服务模式（推荐先行）** | 移动/iOS/macOS App 作为 TELG 后端的新客户端，TTS 继续跑服务端，App 只做播放与交互；引擎切换对客户端完全透明 | 当前阶段 App 化时零改动 |
| **B. 端侧离线合成** | Kokoro 是标准 ONNX 模型（80–310MB），可借助 **onnxruntime 官方移动端绑定**（`onnxruntime-swift` / `onnxruntime-android` / CoreML）直接打进 iOS/macOS/Android 应用，本地合成、完全离线 | 追求离线与隐私、素材量大的成熟期 |

**对比其他候选的跨端可行性**：
- edge-tts：逆向云端接口，无官方 SDK，端侧无法合法打包 → 仅限服务端
- CosyVoice：5GB 模型 + GPU → 移动端不可行
- Piper：可端侧但中文差 + 新版 GPL-3.0 传染风险
- 硅基流动：纯云 API，端侧可调但依赖网络与 Key

**对本期实现的约束**：引擎层保持"纯 Python + 输入文本/输出音频 bytes"的干净接口（不绑定服务端专属状态），未来端侧复用同一调用语义。

---

## 八、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| Windows 安装需 C++ 编译（misaki/espeak-ng） | 高 | P1.0 先实测；备选：预编译 wheel、Docker、espeakng-loader 纯 Python 方案 |
| 模型下载源（HF 大陆慢） | 中 | ModelScope 镜像 + 手动放置 + 下载脚本 |
| 无情感 API | 低 | 当前技术英语场景可接受；情感诉求后续走硅基流动/CosyVoice 补位 |
| 长素材合成耗时（CPU 实时，几十秒级） | 低 | 现有进度轮询天然支持真实耗时，无需改动 |
| 中文音色偏平 | 低 | 中文素材建议走硅基流动补位；Kokoro 作英文主力 |

---

## 九、验收标准（整体）

1. Provider 切换 edge-tts ↔ Kokoro 后，试听与整篇合成均按对应引擎真实执行
2. Kokoro 合成素材的播放器时间戳与声音严格对齐（复用现有对齐机制）
3. 模型缺失时前端显示友好横幅（分类 + 原因 + 下载指引），不崩溃
4. 中英文素材均可用（英文默认音色 + 中文 `zf_*` 音色）
5. Windows 本地可完整跑通（或明确记录安装步骤与已知问题）

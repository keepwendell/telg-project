# TELG TTS 引擎选型调研

> 版本：2026-09-16 · 状态：draft（待评审）· 调研时间：2026-09-16 · 关联文档：[总体架构](../架构/architecture-总体架构.md) / [接口契约](../架构/api-contract-接口契约.md)
> 覆盖范围：20 个通用方案（14 开源 + 6 云 API）+ 2 个用户点名项目（N.E.K.O / OpenMontage）专项调研。

---

## 一、结论先行（TL;DR）

**推荐方案：Kokoro-82M 作为新增主力离线引擎 + 硅基流动作为云 API 备选 + 保留 edge-tts 作为 fallback。**

| 优先级 | 方案 | 角色 | 核心理由 |
|---|---|---|---|
| ★★★★★ | **Kokoro-82M** | 新增主力（离线） | 英文音色第一梯队、CPU 实时、350MB/量化 80MB、Apache-2.0、`kokoro.create()` 一行出 numpy bytes，完美匹配逐句合成管线 |
| ★★★★☆ | **硅基流动 TTS** | 云 API 备选 | 14 元免费额度零成本验证、OpenAI 兼容 API 接入最简单、大陆直连稳定、聚合 CosyVoice2 支持情感/方言 |
| ★★★★☆ | **CosyVoice 2/3** | 高质量模式（有 GPU 时） | 中英文质量天花板、自然语言 Instruct 控制情感、18+ 中文方言；但 5GB 模型 + conda/pynini 依赖重，不作默认 |
| ★★★☆☆ | **edge-tts** | 保留 fallback | 免 Key 零成本，但大陆/新加坡网络常超时，需加重试，不能作唯一依赖 |
| ✗ 不推荐 | Piper / ChatTTS / XTTS / Fish / Spark / OpenAI | — | 见第四节各节原因 |

---

## 二、评估维度与方法

按用户指定的三个重点加权评估：

| 维度 | 权重 | 考察要点 |
|---|---|---|
| ① 音色自然流畅 | 40% | 中英文 MOS/社区口碑、韵律、呼吸感、一致性 |
| ② 情感/噪音/口音个性化 | 30% | 情感参数是否 API 暴露、口音/方言支持、副语言控制（笑声/停顿） |
| ③ 方便打包成工程 | 30% | Python SDK/pip 包、逐句合成支持、模型体积、硬件要求、Windows 支持、离线/免 Key、License |

**TELG 场景特殊性**：核心是"技术英语听力素材"，英文音色质量 > 中文；后端纯 Python 异步，需按句独立合成返回音频；前端已有 Provider 下拉框（edge-tts/Piper/CosyVoice，后两者未实现）。

---

## 三、开源方案综合对比（14 个）

### 3.1 核心指标速览

| 方案 | License | 英文音色 | 中文音色 | 情感控制 | 模型体积 | 硬件 | 工程友好 | 离线/免Key | 综合 |
|---|---|---|---|---|---|---|---|---|---|
| **Kokoro-82M** | Apache-2.0 ✅商用 | ★★★★★ 第一梯队 | ★★★ 可懂但偏平 | 无（仅 speed） | 350MB / INT8 80MB | CPU 实时 | ★★★★★ pip+一行API | ✅ | **★★★★★** |
| **CosyVoice 2/3** | Apache-2.0 ✅商用 | ★★★★☆ | ★★★★★ 天花板 | ★★★★★ Instruct指令+参考音频+18方言 | 5GB (0.5B) | 需GPU 8GB+ | ★★★ 依赖重 | ✅ | **★★★★☆** |
| **GPT-SoVITS** | MIT(代码) ✅ | ★★★☆ | ★★★★☆ 克隆强 | 参考音频带入，无独立API | 1-2GB | GPU 4-8GB | ★★★★ 自带FastAPI+Win一键包 | ✅ | ★★★★ |
| **F5-TTS** | 代码MIT/权重**非商用** | ★★★★☆ 克隆强 | ★★★☆ | 语速+参考音频 | 1.35GB | GPU 4-8GB / CPU可跑 | ★★★★★ pip官方包 | ✅ | ★★★☆ |
| **Piper** | 旧MIT / 新**GPL-3.0** | ★★★★ 清晰但扁平 | ★★ 仅1音色且僵硬 | 无 | 40-60MB | 纯CPU 超实时 | ★★★★★ Win原生 | ✅ | ★★★ |
| **MeloTTS** | MIT ✅ | ★★★☆ | ★★★ 中英混读 | 无（仅 speed） | 300MB | CPU 实时 RTF 0.41 | ★★★★ pip | ✅ | ★★★ |
| **ChatTTS** | AGPL+CC-BY-NC **非商用** | ★★★ | ★★★★ 口语化强 | ★★★ [laugh]/[uv_break] | 1.6GB | GPU 4GB+ / CPU慢 | ★★★★ pip | ✅ | ★★★ |
| **IndexTTS** | **License存疑**(bilibili自定义) | ★★★☆ | ★★★★★ 断句准 | ★★★★★ 8维情感向量+文本描述 | 7-8GB | GPU 4-6GB | ★★★ 社区pip/ONNX | ✅ | ★★★ |
| **Fish Speech** | Research License **非商用** | ★★★★☆ 多语言强 | ★★★☆ | 参考音频 | S1 1GB / S2 8-16GB | S2 需24GB | ★★★★ pip+OpenAI兼容 | ✅ | ★★☆ |
| **Step-TTS 3B** | Apache-2.0 ✅ | ★★★★ | ★★★★ | 自然语言指令 | 6-8GB | GPU 8GB+ | ★★★ 源码脚本 | ✅ | ★★☆ |
| **Spark-TTS** | 已改CC-BY-NC-SA **非商用** | ★★★☆ | ★★★☆ | ★★★★ 性别/音调/语速/语气参数 | 1GB | GPU 4-6GB | ★★★ 非官方SDK | ✅ | ★★☆ |
| **EmotiVoice** | Apache-2.0 ✅ | ★★★ | ★★★☆ | ★★★★ 文本提示词调情绪因子 | ~10GB | GPU 6GB+ | ★★ 无pip+Win有坑 | ✅ | ★★ |
| **OpenVoice V2** | MIT ✅ | ★★★☆ | ★★★☆ | 参考音频style迁移 | 1.8GB | GPU 2GB+ | ★★ 两阶段管线 | ✅ | ★★ |
| **XTTS-v2** | CPML **非商用**+公司已关停 | ★★★ 已老 | ★★★ | 无 | 1.88GB | GPU 4-6GB | ★★★ 社区fork | ✅ | ★☆ |

> ★ 评分基于第三方实测/社区口碑（已查证），非官方宣传。License 标注"非商用"的方案，若 TELG 未来有商用计划需排除。

### 3.2 关键发现

- **License 是最大分水岭**：14 个开源方案中，模型权重允许商用的仅 Kokoro、CosyVoice、GPT-SoVITS（代码）、Step-TTS、MeloTTS、EmotiVoice、OpenVoice 7 个；其余 7 个（XTTS-v2、ChatTTS、Fish Speech、F5-TTS 权重、Spark-TTS、IndexTTS）均为非商用协议或 License 存疑。
- **英文音色第一梯队**：Kokoro（82M 小模型登顶 TTS Arena）、CosyVoice 2/3、Fish Speech S2、F5-TTS。
- **情感控制最强**：CosyVoice（自然语言 Instruct）、IndexTTS（8 维情感向量，音色情感解耦）、EmotiVoice（文本提示词调情绪因子）、Spark-TTS（参数化控制最透明）。**Kokoro/Piper/MeloTTS/XTTS 均无真正的情感控制。**
- **工程友好度 Top 3**：Kokoro（pip + 一行 API + CPU 实时 + 350MB）、Piper（40MB + 纯 CPU + Windows 原生）、F5-TTS（官方 pip + 1.35GB + CPU 可跑）。

---

## 四、云 API 方案综合对比（6 个）

### 4.1 核心指标速览（信息截止 2026-09-16）

| 方案 | 大陆访问 | 情感控制 | 方言 | 声音克隆 | 单价 | 免费额度 | Python集成 | 综合 |
|---|---|---|---|---|---|---|---|---|
| **硅基流动** | ★★★★★ 直连 | ★★★ 富文本标签 | 粤语/川/沪/津 | 10-20秒 | $7.15/M bytes | **14元** | ★★★★★ OpenAI兼容 | **★★★★☆** |
| **阿里云 CosyVoice** | ★★★★★ 直连 | ★★★★ 自然语言指令 | 粤语/川等 | 支持 | 200元/M字符 | 新客体验 | ★★★★ DashScope | ★★★★ |
| **Azure 中国区(世纪互联)** | ★★★★★ 直连 | ★★★★★ SSML 70+style | 广 | 高门槛 | 95.4元/M | 未查到 | ★★★★ | ★★★☆ |
| **火山引擎豆包2.0** | ★★★★★ 直连 | ★★★★★ emotion+指令生成 | 8种方言 | 10-30秒 | 280元/M | 新客优惠 | ★★★★ WebSocket | ★★★☆ |
| **MiniMax 国内版** | ★★★★★ 直连 | ★★★★ 9种情绪 | 40+语言 | 9.9元/音色 | 200-350元/M | 无 | ★★★★★ OpenAI兼容 | ★★★ |
| **Azure 全球区** | ✗ 需代理 | ★★★★★ | 广 | 高门槛 | $15/M | **50万字符/月** | ★★★★★ 官方SDK | ★★★ |
| **OpenAI TTS** | ✗ 需代理 | ★★★ 仅gpt-4o-mini-tts | 无中文方言 | 不支持 | $15-30/M | 无 | ★★★★★ | ★★ |

### 4.2 关键发现

- **大陆可用性是云 API 的硬门槛**：阿里云、火山引擎、MiniMax、硅基流动四家国内平台可直连；Azure 全球区和 OpenAI 在大陆均需代理，不适合作为 TELG 主力。
- **edge-tts 与自建 Azure Key 的本质区别**：edge-tts 是逆向 Edge 浏览器公开端点（`wss://speech.platform.bing.com`），免 Key 但无 SLA，微软不定期轮换 token 导致旧版失效，大陆/新加坡网络常超时。
- **性价比最高**：硅基流动（14 元免费 + $7.15/M bytes + OpenAI 兼容 API）和 Azure 全球区（$15/M + 每月 50 万免费，但需代理）。

---

## 五、用户点名项目专项调研

### 5.1 N.E.K.O（https://github.com/Project-N-E-K-O/N.E.K.O）

**定位**：AI 猫娘陪伴应用（"网络型情感知性生命体"），非 TTS 引擎。数字生命/桌宠类产品：主动陪伴、实时语音对话（Realtime API）、视觉理解、五维记忆、Live2D/VRM 多形态 Avatar、Agent 工具执行、Steam 免费版、Apache-2.0、Python 3.11 + uv。

**TTS 相关能力**（已查证）：
- `main_logic/tts_client/`：**TTS 引擎适配器（多 provider 对偶）**——解析当前核心与音色配置选择的外部语音提供商，为 worker 函数提供单一队列契约，`LLMSessionManager` 拥有队列、启动 daemon 线程、把生成的 PCM 转发给客户端。
- 实时语音模型（Realtime API 类）不使用本地 TTS 客户端；本地合成走外部 provider 队列 → PCM 流。
- **语音克隆**：上传约 5 秒连贯干净的人声录音即可自定义角色声音（进阶设置 → 语音克隆页面）。
- 支持 14+ AI 服务商（OpenAI / Gemini / Qwen / DeepSeek 等），UGC 语音包可上传分享（Steam 创意工坊）。

**对 TELG 的参考价值**：
- 它的"多 provider TTS 适配器 + 单一队列契约 + PCM 转发"架构与 TELG 想做的可插拔引擎设计同构，可作为 `TTSEngine` 接口设计的工程参考。
- 5 秒语音克隆能力提示：若 TELG 未来要做"自定义音色克隆"，可借鉴其"短录音 + 克隆模型"的交互（GPT-SoVITS 类模型）。
- **不作为 TELG 的 TTS 引擎候选**：它是完整应用而非可 pip 集成的库；其语音走服务商 Realtime API（实时对话场景），与 TELG 的"预合成听力素材"场景不同。

### 5.2 OpenMontage（https://gitcode.com/GitHub_Trending/op/OpenMontage）

**定位**：开源 agentic 视频生产系统（calesthio/OpenMontage，AGPL-3.0，Python）。把 AI 编码助手（Claude Code / Cursor / Copilot / Windsurf / Codex）变成视频制作工作室：自然语言描述 → 智能体执行完整流水线（调研、脚本、分镜、素材生成、配音、剪辑、字幕、音乐、合成）。11-12 条工作流、49-52 款工具、400-500+ agent skills。

**TTS 相关能力**（已查证）：
- **4 个 TTS 引擎**：ElevenLabs、Google TTS、OpenAI TTS、**Piper（本地免费）**。
- 免费路线：Piper TTS（本地离线）+ FFmpeg + Remotion + 免费素材源，$0 成本。
- 付费栈：Kling / Runway Gen-4 / Google Veo 3 / FLUX / ElevenLabs / Suno 等。
- ElevenLabs 集成覆盖 TTS、描述式音效（SFX）合成、AI 音乐生成、声音克隆。
- 生产质量门：预合成校验 + 渲染后自审；预算控制（成本估算 + 支出上限）。

**对 TELG 的参考价值**：
- 其"**云 API + 本地免费双轨 TTS**"（付费走 ElevenLabs、免费走 Piper）的 provider 策略与 TELG 规划一致（云备选 + 本地离线主力）；只是它选的本地免费是 Piper，而 TELG 调研结论推荐用 **Kokoro 替代 Piper**（中文更差 + GPL 风险）。
- 质量门与预算控制思路（校验 → 自审 → 成本上限）可借鉴到 TELG 的素材生成流水线（语料校验 → TTS 校验 → 用量统计）。
- **不作为 TELG 的 TTS 引擎候选**：它是视频流水线框架而非 TTS 库，AGPL-3.0 对闭源商用有传染性；TTS 只是其工具集之一。
- 注意：gitcode 页面简介（"全球首个开源智能视频制作系统"）为 AI 生成口径；真实仓库在 GitHub（calesthio/OpenMontage），以上事实以其 GitHub README 与第三方评测为准。

### 5.3 小结

两个项目均**不改变主选型结论**（Kokoro + 硅基流动 + edge-tts fallback）。它们属于"生态参考"：N.E.K.O 的多 provider TTS 适配器设计、OpenMontage 的云+本地双轨与质量门思路，可作为 TELG 引擎架构与流水线治理的设计参照。

---

## 六、按三重点加权的推荐排序

### 6.1 离线开源方案排名

| 排名 | 方案 | 音色(40%) | 情感(30%) | 工程(30%) | 加权总分 | 适用场景 |
|---|---|---|---|---|---|---|
| 1 | **Kokoro-82M** | 9.0 | 4.0 | 9.5 | **7.35** | 英语听力素材默认离线方案 |
| 2 | **CosyVoice 2/3** | 9.5 | 9.5 | 5.0 | **8.10**¹ | 有 GPU 时的高质量模式 |
| 3 | **GPT-SoVITS** | 7.5 | 5.0 | 7.0 | **6.65** | 中文音色克隆需求 |
| 4 | **F5-TTS** | 8.0 | 5.0 | 8.5 | **6.95**² | 英文克隆（非商用） |
| 5 | **MeloTTS** | 6.5 | 3.0 | 8.0 | **5.75** | 多语言轻量（无情感需求） |
| 6 | **Piper** | 6.0 | 2.0 | 9.5 | **5.65**³ | 极低端设备/英文-only |

> ¹ CosyVoice 加权分高但工程分低（5GB+GPU+重依赖），实际部署门槛高，故排 Kokoro 之后。
> ² F5-TTS 权重非商用，若 TELG 有商用计划需排除。
> ³ Piper 新版 GPL-3.0，中文差，仅适合英文+极轻量场景。

### 6.2 云 API 方案排名

| 排名 | 方案 | 音色(40%) | 情感(30%) | 工程/成本(30%) | 加权总分 | 适用场景 |
|---|---|---|---|---|---|---|
| 1 | **硅基流动** | 8.0 | 7.0 | 9.0 | **8.00** | 个人项目零成本云 TTS |
| 2 | **阿里云 CosyVoice** | 9.0 | 8.0 | 7.5 | **8.25**¹ | 对中文质量要求高的商用项目 |
| 3 | **Azure 中国区** | 8.5 | 9.5 | 6.0 | **7.90** | 已有 Azure 账号、需 SSML 精细控制 |
| 4 | **火山引擎豆包2.0** | 9.0 | 9.5 | 5.5 | **7.95**¹ | 对方言/情感演绎要求高且预算充足 |
| 5 | **MiniMax** | 9.0 | 7.5 | 5.5 | **7.35** | 质量优先、无免费额度可接受 |
| 6 | **OpenAI TTS** | 7.5 | 6.0 | 3.0 | **5.70** | 不推荐（大陆需代理+无免费+无方言） |

> ¹ 阿里云/火山引擎加权分高但单价贵（200-280 元/百万字符），个人项目成本敏感故排硅基流动之后。

---

## 七、TELG 落地建议

### 7.1 引擎架构（可插拔 Provider）

利用前端已有的 TTS Provider 下拉框，后端实现统一 `TTSEngine` 接口：

```python
class TTSEngine(ABC):
    @abstractmethod
    async def synthesize(self, text: str, voice: str, **kwargs) -> bytes:
        """逐句合成，返回音频 bytes (wav/mp3)"""
    @abstractmethod
    def available_voices(self) -> list[str]: ...
    @property
    def requires_gpu(self) -> bool: ...
    @property
    def is_online(self) -> bool: ...
```

### 7.2 建议实现顺序

| 阶段 | Provider | 工作量 | 说明 |
|---|---|---|---|
| P0 | edge-tts（已有） | 0 | 保留，加重试/超时/降级逻辑（已完成错误分类与 45s 超时） |
| P1 | **Kokoro** | 1-2 天 | 新增主力离线引擎，英文素材默认 |
| P2 | **硅基流动** | 0.5 天 | 云 API 备选，需用户配 Key，作为 Kokoro 中文/情感不足时的补充 |
| P3 | CosyVoice | 2-3 天 | 高质量模式，检测 GPU 可用性后动态启用，不打入默认依赖 |
| ✗ | Piper | — | 不建议实现（中文差+GPL），可从前端下拉框移除或标注"coming soon" |

### 7.3 模型体积与硬件要求汇总

| Provider | 新增磁盘占用 | 最低硬件 | 离线 | 免 Key |
|---|---|---|---|---|
| edge-tts | ~0 | 任意（需网络） | ✗ | ✅ |
| Kokoro | 350MB（模型）+ 50MB（依赖） | CPU 即可，2GB RAM | ✅ | ✅ |
| 硅基流动 | ~0（纯 API） | 任意（需网络） | ✗ | ✗（需 Key） |
| CosyVoice2 | 5GB（模型）+ ~3GB（依赖/conda） | NVIDIA GPU 8GB+ | ✅ | ✅ |

### 7.4 针对 TELG 核心场景（技术英语听力）的具体建议

1. **默认用 Kokoro 合成英文**：技术文本不需要强烈情感，Kokoro 的英文自然度+CPU 实时+离线完全够用。可选 `af_bella`（清晰有力）或 `af_heart`（温暖）作为默认英文音色。
2. **中文旁白/讲解用硅基流动**：Kokoro 中文偏平，若素材有中文讲解部分，调用硅基流动 CosyVoice2 补位（14 元免费额度足够）。
3. **需要"多种英文口音"听力训练时**：Kokoro 仅支持 US/UK，若需印度/澳洲口音，可临时切换 edge-tts（Azure 有 100+ 语言多口音）或硅基流动。
4. **情感/噪音控制**：TELG 当前场景（技术英语听力）对情感控制需求低。若未来扩展到"对话式听力"或"故事听力"，可启用 CosyVoice 本地（Instruct 指令）或硅基流动（富文本标签）。
5. **打包策略**：Kokoro 模型文件（350MB）不打入 git，改为首次运行时自动下载（放 `~/.cache/telg/kokoro/`），或提供单独的模型下载脚本。`requirements.txt` 新增 `kokoro-onnx`。Windows 用户需提示安装 VS Build Tools。

---

## 八、风险与注意事项

1. **Kokoro Windows 安装坑**：`kokoro-onnx` 在 Windows 上需编译 misaki 前端（C++），需安装 Visual Studio Build Tools（"使用 C++ 的桌面开发"工作负载）。建议在 README 中写明，或提供预编译 wheel。
2. **edge-tts 长期稳定性**：微软不定期轮换 `speech.platform.bing.com` 的 DRM token，旧版 edge-tts 会突然失效，需保持 `pip install -U edge-tts`。建议加版本锁定+更新提醒。
3. **CosyVoice 依赖冲突**：pynini 与 TELG 现有 Python 环境可能冲突，建议用独立 venv 或 conda 环境运行 CosyVoice，通过子进程/HTTP 调用而非直接 import。
4. **License 合规**：若 TELG 未来商用，**绝对不能**使用 XTTS-v2（CPML）、ChatTTS（CC-BY-NC）、Fish Speech（Research License）、F5-TTS 权重（CC-BY-NC）、Spark-TTS（CC-BY-NC-SA）。IndexTTS 的 License 存在官方宣传（Apache 2.0）与仓库 LICENSE（bilibili 自定义协议）的矛盾，商用前必须逐条核对仓库 LICENSE 原文。
5. **云 API 成本控制**：硅基流动 14 元免费额度用完后需付费。建议在 TELG 中加用量统计和配额提醒，避免意外扣费。
6. **模型下载源**：Kokoro 模型在 HuggingFace，大陆下载可能慢；建议提供 ModelScope 镜像或国内 CDN 下载地址。CosyVoice 模型在 ModelScope（国内加速），下载友好。
7. **N.E.K.O / OpenMontage 定位**：两者均为应用/框架级项目而非 TTS 库，仅作架构参考；OpenMontage 的 gitcode 简介为 AI 生成口径，落地前以 GitHub 仓库为准。

---

## 九、信息来源索引

### 开源方案
- Kokoro：https://huggingface.co/hexgrad/Kokoro-82M ；https://pypi.org/project/kokoro-onnx/ ；https://www.darlite.me/open-source/kokoro-tts
- CosyVoice：https://github.com/FunAudioLLM/CosyVoice ；https://www.modelscope.cn/models/iic/CosyVoice-300M-SFT/summary
- GPT-SoVITS：https://github.com/RVC-Boss/GPT-SoVITS
- F5-TTS：https://github.com/SWivid/F5-TTS ；https://localaimaster.com/blog/f5-tts-setup-guide
- Piper：https://github.com/OHF-Voice/piper1-gpl
- MeloTTS：https://github.com/myshell-ai/MeloTTS
- ChatTTS：https://github.com/2noise/ChatTTS
- IndexTTS：https://github.com/index-tts/index-tts
- Fish Speech：https://github.com/fishaudio/fish-speech
- Step-TTS：https://github.com/stepfun-ai/Step-Audio
- Spark-TTS：https://github.com/SparkAudio/Spark-TTS
- EmotiVoice：https://github.com/netease-youdao/EmotiVoice
- OpenVoice：https://github.com/myshell-ai/OpenVoice
- XTTS-v2：https://coqui-tts.readthedocs.io/en/latest/models/xtts.html

### 云 API 方案
- Azure Speech：https://azure.microsoft.com/zh-cn/pricing/details/speech/ ；https://www.azure.cn/pricing/details/cognitive-services/index.html
- 火山引擎：https://www.volcengine.com/product/tts ；https://docs.volcengine.com/docs/6561/1359370
- MiniMax：https://platform.minimaxi.com/document/T2A%20V2 ；https://platform.minimaxi.com/docs/guides/pricing-paygo
- OpenAI TTS：https://platform.openai.com/docs/guides/text-to-speech ；https://openai.com/pricing
- 硅基流动：https://docs.siliconflow.com/cn/userguide/capabilities/text-to-speech ；https://www.siliconflow.com/zh/pricing
- 阿里云：https://ai.aliyun.com/nls/tts ；https://help.aliyun.com/zh/isi/product-overview/billing-10

### 用户点名项目
- N.E.K.O：https://github.com/Project-N-E-K-O/N.E.K.O ；TTS Client 模块文档 https://project-neko.online/modules/tts-client
- OpenMontage：https://gitcode.com/GitHub_Trending/op/OpenMontage ；https://github.com/calesthio/OpenMontage ；第三方评测 https://andrew.ooo/posts/openmontage-agentic-video-production-system-review/ 、https://www.wasimshaikh.com/blog/openmontage-agentic-ai-video-production-system

> 所有价格、免费额度、License 信息截止 2026-09-16，后续可能变动，落地前请以官方页面为准。

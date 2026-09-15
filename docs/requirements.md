# TELG 需求规格（Requirements）

## 1. 核心生成参数

| 参数 | 示例 | 作用 |
|---|---|---|
| Topic | Tire Burst Stability Control | 决定技术主题（自由输入 + Presets） |
| Dialogue Type | 双人技术讨论 | 决定内容结构 |
| Length | 60 / 120 / 180s | 控制内容长度（Segmented Control） |
| Difficulty | Level 1–5 | 控制英语难度 |
| Domain / Role / Scenario | Automotive / Vehicle Dynamics Engineer / Technical Discussion | 决定技术语境与角色 |
| Voice | en-US-GuyNeural | TTS 音色（按角色设置，可增删角色） |

### Dialogue Type（第一阶段）

1. 双人技术讨论（Technical Discussion）
2. 单人技术讲解（Single Technical Deep-Dive）
3. 技术面试问答（Technical Interview）
4. 工程问题分析（Root-Cause Failure Analysis）

后续扩展：Code Review / Design Review / Test Discussion / Calibration Discussion / Project Meeting / Technical Presentation / Job Interview / Daily Engineering Communication。

### 进阶参数（Advanced，默认收起）

- Technical Depth（1–5）：技术深度
- Breadth（1–5）：话题谈论广度（涉及角色/相关维度）
- Vocabulary Density（%）：术语密度
- Dialogue Style / Tone：语气（neutral / cheerful / serious / urgent 等，模拟工作紧急、面试压力等情感色彩）
- Custom Instructions：自定义注入

## 2. 英语难度体系（Level 1–5）

目标**不是**简单按 CEFR 生硬划分，而是综合控制：

`vocabulary · sentence complexity · technical terminology density · speaking speed · grammar complexity · implicit meaning · dialogue naturalness`

| Level | 描述 | 示例 |
|---|---|---|
| L1 | 简单句、低技术词汇密度 | — |
| L2 | 标准工程表述 | — |
| L3 | 正常工程师之间的技术讨论 | "The cornering stiffness drops significantly after the tire burst, so we need to compensate for the resulting yaw moment." |
| L4 | 深度技术讨论 | — |
| L5 | 接近真实外企研发会议 | "We should first determine whether the yaw response is mainly caused by the asymmetric tire forces or by the change in the effective rolling radius." |

## 3. 用户主工作流

```
Choose Topic → Configure → Generate → Preview → Confirm → Listen → Replay → Review
```

具体步骤（当前实现）：

1. 新建素材（⌘K / ⌘N / 左侧 + New）→ 输入 Topic、配置参数
2. 语料生成（3 步进度：Request → Validate → Timeline）→ 生成完成后处于 Draft 态（语料阶段，与 TTS 解耦）
3. Adjust → Voice：调整音色/语气 → 合成音频（TTS 阶段）→ audioReady
4. 发布（可改名，二次确认删除）→ 进入素材库
5. 素材库/播放列表管理 + 全局播放条精听（句级同步、Replay、倍速、±10s）

**阶段状态机**：`draft（语料就绪）→ audio_ready（TTS 就绪）→ published`。发布后编辑进度区隐藏；点击 Adjust 解锁编辑（可回溯步骤）。

## 4. 讲义（Handout）构成

每次生成自动产出：

1. Technical Background（技术背景）
2. Technical Principle（技术原理）
3. Engineering Scenario（工程场景）
4. Dialogue Transcript（英文 + 中文，可切换）
5. Vocabulary（术语表：en / zh / 语境释义）
6. Listening Questions（听力理解题，可自测）
7. Core Sentence Patterns（可复用的工程表达）

支持导出 Markdown。

## 5. 成功标准（第一阶段）

用户不需要手写 Prompt、不需要自己找英语材料、不需要自己找 TTS，**只输入一个技术主题，几十秒内获得一套可直接用于训练的技术英语听力素材**。

## 6. 非目标（当前阶段不做）

- 用户系统 / 学习记录持久化到服务端
- 个性化推荐算法
- 本地 LLM / 高级 TTS 模型部署（Provider 预留但首期只做 OpenAI-compatible + edge-tts）
- 移动端适配（纯 PC Web App）

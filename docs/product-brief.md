# TELG 产品定义（Product Brief）

> Technical English Listening Generator — 面向技术研发人员的参数化技术英语听力素材生成器。

## 1. 背景与要解决的问题

研发人员（汽车、智能驾驶、智能底盘、控制算法、软件工程等）在工作中需要阅读和听懂大量英文技术内容，但现有英语学习材料普遍存在：

- **内容不相关**：旅游、购物、日常生活等主题对工作场景帮助有限；
- **技术背景不真实**：缺乏真实工程语境，学完无法直接迁移到工作；
- **难度不可控**：无法按个人水平精确调节；
- **缺少针对性**：不覆盖岗位真实场景（如 Design Review、Test Report Discussion、Technical Interview）。

产品要解决的核心问题：**给定一个技术主题，能否生成"真实、自然、可信、适合听力训练"的技术英语内容。**

## 2. 核心定位

**不是**：固定主题的英语听力 Demo、一个"LLM + TTS 的英语学习网站"。

**是**：一个参数化的 Technical English Listening Generator。

用户配置几个核心参数（Topic / Dialogue Type / Length / Difficulty / Voice），系统自动完成：

```
参数配置
  → LLM 生成技术英语素材（Technical Grounding）
  → 技术背景/原理生成
  → 逐句 TTS
  → 音频拼接
  → 句级时间轴
  → 播放器
  → 讲义（Handout）
```

最终输出**一套完整的听力学习材料**，而不仅仅是一段音频。

## 3. 产品差异化：Technical Grounding（技术知识锚定）

LLM 生成内容时**不能只考虑英语语言质量，还要考虑真实的工程背景**。

示例：Topic = Tire Burst Stability Control，生成对话应自然涉及：

`rolling resistance / cornering stiffness / yaw moment / yaw rate / sideslip / torque vectoring / wheel load / vehicle dynamics / stability control`

同时讲义应解释真实工程原理：

- Engineering Background：爆胎后滚动阻力、纵向/侧向力特性、有效滚动半径变化；前轮爆胎因左右受力不对称产生横摆力矩；
- Technical Principle：控制器根据爆胎位置修正车辆动力学参数，通过 Torque Vectoring 产生补偿横摆力矩，维持期望横摆率与侧滑状态。

**核心价值一句话：用真实技术知识作为内容背景，用英语作为训练载体。**

## 4. 目标用户

第一阶段：
- 技术研发人员（汽车工程师 / 控制算法工程师 / 软件工程师）
- 智能驾驶、智能底盘研发人员
- 想提升技术英语听说能力的工程师
- 外企研发岗位面试准备人员

后续扩展：其他工程领域、IT / AI / Robotics、科研人员、技术管理人员、技术面试用户。

## 5. 工作原则

- 简单优先、MVP 优先；
- Provider 可插拔（LLM / TTS 均不修改业务逻辑即可切换）；
- 数据结构稳定（Generation Artifact 作为 LLM、TTS、播放器、讲义之间的共同数据源）；
- 前后端解耦；
- 避免过度工程化。

## 6. 未来方向（MVP 验证成功后）

- **Listening Mode**：Blind Listening（无字幕）→ English Transcript → Chinese Explanation → Vocabulary 四轮训练；
- **个性化难度**：根据历史表现自动调整 Level（3 → 3.5 → 4）；
- **错题/薄弱词汇**：记录易错词，下一次生成优先覆盖；
- **个人技术词库**：用户建立 My Vocabulary，LLM 生成时优先使用；
- **技术领域模板**：Automotive / Software / AI 分层目录。

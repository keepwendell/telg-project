# TELG LLM Prompt 链路设计说明书
**版本**：v2.0
**状态**：待评审
**范围**：TELG 全部 4 条 LLM 链路（素材生成/refine、学习档案、引导初始化、推荐配置）
**目标读者**：产品经理、前端、后端、测试
**依据**：`frontend/index.html` 与 `backend/main.py` 实际代码核对结果
**入库日期**：2026-09-18（由 MainAgent 按用户提供的 v2.0 文档全文写入）

---
## 目录
1. [背景与目标](#1-背景与目标)
2. [产品定位与需求基准](#2-产品定位与需求基准)
3. [链路全景](#3-链路全景)
4. [前端契约（已核对）](#4-前端契约已核对)
5. [后端数据契约](#5-后端数据契约)
6. [Prompt 设计](#6-prompt-设计)
7. [字段语义对齐](#7-字段语义对齐)
8. [校验规则](#8-校验规则)
9. [重试机制](#9-重试机制)
10. [下游联动](#10-下游联动)
11. [另外 3 条 LLM 链路](#11-另外-3-条-llm-链路)
12. [指标与验收](#12-指标与验收)
13. [Patch 清单](#13-patch-清单)
14. [排期与行动项](#14-排期与行动项)
15. [附录](#15-附录)
---
## 1. 背景与目标
### 1.1 背景
TELG 现有 4 条 LLM 链路，全部走 OpenAI 兼容 SDK（默认 `deepseek-chat`）：
| 链路 | 端点 | 用途 |
|---|---|---|
| 素材生成 / refine | `POST /api/v1/generate`<br>`POST /api/v1/materials/{mid}/regenerate` | 生成双语技术对话素材 |
| 学习档案 | `POST /api/v1/config/profile/generate` | 根据画像生成学习档案 |
| 引导初始化 | `POST /api/v1/config/onboarding/generate` | 问卷 → 档案 + 推荐配置 |
| 推荐配置 | `POST /api/v1/config/recommendations/generate` | 根据档案推荐领域/角色/场景 |
主链路一次调用生成全部内容（背景、speakers、对话、词汇、题目、句型），System 静态、User 动态。
### 1.2 现存问题
经前端与后端代码核对，确认以下问题：
| # | 问题 | 影响 |
|---|---|---|
| 1 | System Prompt 开篇窄化为「为研发工程师生成技术对话」 | 与产品沉浸式定位不符 |
| 2 | 句式复杂度误用 `advanced.depth`，后端映射到 `DEPTH_DEFS`（技术深度） | 模型收到错误轴 |
| 3 | 词汇专业度 `difficulty` 与句式复杂度定义重叠 | 两轴边界不清 |
| 4 | `breadth` / `tone` / `vocabDensity` / `style` 前端仍提交、后端仍消费 | 僵尸参数，浪费 token |
| 5 | 不对称对话（asymmetric）前端已删 UI，后端仍校验 lead/respond | 校验与 UI 脱节 |
| 6 | refine 与首次生成 payload 结构不一致（speakerCount / asymmetric 回填） | 同一素材两次行为不同 |
| 7 | `topic` 与 `context` 首次生成时完全重复 | 字段冗余 |
| 8 | 全量重试成本高，重试反馈只有错误文本 | 通过率低、成本高 |
| 9 | 语义校验（词汇覆盖、题目依据）难程序化，硬阻断易误杀 | 拖累通过率 |
| 10 | `speakers[].voiceTag` 与 TTS 音色映射依赖顺序 | 脆弱，难迁移 |
| 11 | `Advanced` 无类型约束，字段全靠约定 | 契约易漂移 |
| 12 | 另外 3 条链路 System Prompt 仍写「研发工程师」 | 定位不一致 |
### 1.3 目标
- 修正字段语义错位，让模型收到正确轴；
- 删除僵尸参数，精简 Prompt；
- 引入结构化 Prompt、严格 Schema、分区校验/重试；
- 语义校验降级为 warning，不阻断；
- 统一 4 条链路的产品定位；
- 建立可观测指标。
---
## 2. 产品定位与需求基准
### 2.1 产品定位
**TELG 是沉浸式场景听力素材生成引擎。**
- 面向多类学习者：职场人、学生、求职者、技术从业者、管理者、创业者等；
- 通过领域、角色、场景语境、时长、词汇专业度、句式复杂度定制素材；
- 技术领域只是支持的众多领域之一，不是默认领域；
- 输出不是教科书对话，而是有场景、有角色、有目的、有情绪的真实交流。
### 2.2 用户设置项与真实意图
| 设置项 | 用户意图 | 约束类型 |
|---|---|---|
| 对话形态 | 几个人、什么结构 | 硬约束 |
| 练习领域 | 哪个技术领域，决定术语体系 | 硬约束 |
| 对话角色 | 谁出场，候选名单 | 硬约束 |
| 场景语境 | 什么场合、谈什么，**优先级最高** | 硬约束 |
| 对话时长 | 素材多长 | 软调节 |
| 词汇专业度 | 用多专业的词 | 软调节 |
| 句式复杂度 | 句子结构多难 | 软调节 |
| 生成方向（refine） | 往哪个方向改 | 软调节 |
| 改进指令（refine） | 具体修改诉求 | 软调节 |
### 2.3 关键边界
- **词汇专业度**：只约束术语密度、用词地道程度，不牵涉句法；
- **句式复杂度**：只约束从句层数、句子长度结构，不牵涉词汇难度与技术深度；
- **删除项**：技术深度、广度、语气、不对称对话、用户指定讨论人数、词汇密度、风格；
- **双人对话**：两位对等交流，无 lead/respond 主次结构；
- **多人讨论**：从候选角色中选 3–5 位参与，具体人数由系统决定；
- **场景语境优先级最高**：与其他设置冲突时，以语境为准。
### 2.4 前端 UI 文案（现有，准确）
**词汇专业度 L1–L5**
| Level | 中文 | 说明 |
|---|---|---|
| L1 | 生活化 | 日常聊天用语，贴近生活场景 |
| L2 | 职场化 | 基础商务沟通，通用职场表达 |
| L3 | 技术化 | 基础技术术语，常见工程表达 |
| L4 | 专业化 | 领域专业词汇，准确的技术用语 |
| L5 | 学术化 | 学术级词汇，接近论文与讲座 |
**句式复杂度 L1–L5**
| Level | 中文 | 说明 |
|---|---|---|
| L1 | 简单 | 短句为主，结构直白清晰 |
| L2 | 基础 | 简单并列复合，连接词基础 |
| L3 | 常用 | 含常用从句，表达有层次 |
| L4 | 复杂 | 多从句嵌套，句式富有变化 |
| L5 | 学术 | 长难句频繁，学术式行文 |
---
## 3. 链路全景
### 3.1 主链路
```text
前端新建/refine
      │
      ▼
build_artifact(p, action) ── 前置校验 validate_request
      │
      ▼
call_llm_with_retry(p, action)
   ├─ System：静态契约 + 固定约束字典
   ├─ User：结构化 XML，仅本次变量
   ├─ response_format=json_object（优先 json_schema）
   ├─ 首次完整生成 LLMArtifact
   ├─ 校验失败 → 分区重试 ArtifactPatch
   ├─ 合并 merge_patch → 全量复验
   └─ 最多 3 次尝试
      │
      ▼
meta 持久化（speakers/format/... + speaker_voice_map）
      │
      ▼
TTS / 播放 / 渲染
```
### 3.2 关键事实
- 一次 LLM 调用生成全部内容，短期不拆分；
- refine 与首次生成同链路，差异为 `action="regenerate"` 与 `direction` / `injections`；
- TTS 不经过 LLM，`start_ms/end_ms` 只由 TTS 写入；
- 4 条链路均为 System 静态 + User 动态。
---
## 4. 前端契约（已核对）
### 4.1 新建素材弹窗 → payload
**来源**：`frontend/index.html` 行 5080 `collectParams()`
```javascript
function collectParams() {
  const sc = state.genScene;
  const fmt = sc.format || 'dialogue';
  const payload = {
    topic: (sc.context || '').trim(),
    domain: sc.domain ? sc.domain.id : '',
    domainLabel: sc.domain ? sc.domain.name : '',
    format: fmt,
    context: (sc.context || '').trim(),
    difficulty: +document.querySelector('#diff-seg .seg-item.active').dataset.level,
    length: document.querySelector('#len-seg .seg-item.active').dataset.length,
    llm: llmDisplayLabel(),
    tts: normalizeTTSProvider((readStoredCfg().tts || {}).provider) || 'edge-tts',
    voice: 'en-US-GuyNeural + en-US-JennyNeural',
    llm_config: buildLLMConfig(),
    test_mode: buildTestMode(),
    advanced: {
      depth: +document.querySelector('#depth-seg .seg-item.active').dataset.depth,
      vocabDensity: +$('adv-vocab').value,
      style: $('adv-style').value,
      injections: $('adv-inject').value,
      tone: $('adv-tone').value,
      breadth: /* #breadth-seg 已不存在，兜底 3 */,
      directions: []
    }
  };
  // roles / roleSelection 按 format 分支
  return payload;
}
```
### 4.2 refine 弹窗 → payload
**来源**：行 5391 `refineGenerate()` + 行 5268 `paramsFromArt()`
关键差异：
| 字段 | 首次生成 | refine |
|---|---|---|
| `advanced.directions` | `[]` | 重写=`[]`，其余=`[方向]` |
| `advanced.injections` | 隐藏面板值 | `#refine-inject` 值 |
| `advanced.tone` | 隐藏面板值 | 硬编码 `'neutral'` |
| `roleSelection.speakerCount` | **不提交** | **回填提交** |
| `asymmetric` | **不提交** | **回填提交** |
### 4.3 表单默认值与交互
- 默认形态：`dialogue`（双人对话）；
- 角色/领域：**无内置预设**，来自用户学习偏好 + 历史用量；
- 多人讨论：`speakerCount=3` 只是界面默认值，首次生成不提交；
- 角色选择规则：
  - solo：单选，`sc.roles = [name]`；
  - dialogue：最多 2 个，超过 2 个保留后一个 + 新选；
  - discussion：多选，无上限。
### 4.4 隐藏高级面板
- `#advanced-panel` 默认 `hidden`，正常用户流程不可见；
- 包含 `adv-vocab` / `adv-style` / `adv-inject` / `adv-tone`；
- **这 4 个字段确实进入 payload**；
- 状态：**可提交但不可见**。
### 4.5 前端类型定义
- 原生 JS 单文件，**无 interface / type 定义**；
- 请求契约以后端 Pydantic 模型为准。
---
## 5. 后端数据契约
### 5.1 请求模型（现状）
**来源**：`backend/main.py` 行 507
```python
class GenerateIn(BaseModel):
    topic: str
    domain: str = ""
    domainLabel: str = ""
    format: str = "discussion"
    asymmetric: bool = False
    roles: dict = {}
    roleSelection: dict = {}
    context: str = ""
    # legacy fields
    role: str = ""
    scenario: str = ""
    difficulty: int = 3
    length: str = "medium"
    llm: str = ""
    tts: str = ""
    voice: str = ""
    advanced: dict = {}            # ← 无类型约束
    llm_config: dict = {}
    test_mode: bool = False
```
### 5.2 结构原语
```python
FORMATS = {
    "solo":       {"speakerMode": ("fixed", 1), "roleSelectionMode": "exact-fill"},
    "dialogue":   {"speakerMode": ("fixed", 2), "roleSelectionMode": "exact-fill", "supportsAsymmetric": True},
    "discussion": {"speakerMode": ("range", 3, 5), "roleSelectionMode": "candidate-pool"},
}
```
### 5.3 LLM 输出模型（现状）
**来源**：行 1018
```python
class LLMSpeaker(_BM):
    id: str
    role: str
    voiceTag: str = "neutral"
class LLMDialogue(_BM):
    speakerId: str = ""
    speaker: str = ""
    role: str = ""
    text_en: str
    text_zh: str
class LLMBackground(_BM):
    technical_background: str
    technical_principle: str
    engineering_scenario: str
class LLMVocab(_BM):
    en: str
    zh: str
    symbol: str = ""
    def_: str = _F(default="", alias="def")
class LLMQuestion(_BM):
    q: str
    options: list[str]
    answer: str       # ← 字符串（完整选项原文）
    explain: str
class LLMPattern(_BM):
    title: str
    pattern: str
    example: str
class LLMArtifact(_BM):
    background: LLMBackground
    speakers: list[LLMSpeaker] = []
    dialogue: list[LLMDialogue]
    vocabulary: list[LLMVocab]
    listening_questions: list[LLMQuestion]
    core_sentence_patterns: list[LLMPattern]
```
**注意**：
- `LLMBackground` 是固定 3 字段，不是数组；
- `LLMQuestion.answer` 是字符串，不是索引；
- `LLMDialogue` 保留 `speaker` / `role` 作为 legacy 兼容。
### 5.4 目标模型（v2）
```python
class VoiceHint(BaseModel):
    gender: str = ""
    accent: str = ""
    pace: str = ""
class Advanced(BaseModel):
    depth: int = 3                    # UI: 句式复杂度
    injections: str = ""
    directions: list[str] = []
class GenerateIn(BaseModel):
    topic: str
    domain: str = ""
    domainLabel: str = ""
    format: str = "dialogue"
    roles: dict = {}
    roleSelection: dict = {}
    context: str = ""
    difficulty: int = 3               # UI: 词汇专业度
    length: str = "300"
    advanced: Advanced = Advanced()
    llm_config: dict = {}
    test_mode: bool = False
    @model_validator(mode="before")
    def coerce_advanced(cls, values):
        adv = values.get("advanced")
        if isinstance(adv, dict):
            values["advanced"] = {
                k: v for k, v in adv.items()
                if k in {"depth", "injections", "directions"}
            }
        return values
```
**删除**：`asymmetric` / `role` / `scenario` / `llm` / `tts` / `voice`。
### 5.5 ArtifactPatch（新增）
```python
class ArtifactPatch(BaseModel):
    zone: Literal["A", "B", "C", "D"]
    background: Optional[LLMBackground] = None
    speakers: Optional[list[LLMSpeaker]] = None
    dialogue: Optional[list[LLMDialogue]] = None
    vocabulary: Optional[list[LLMVocab]] = None
    listening_questions: Optional[list[LLMQuestion]] = None
    core_sentence_patterns: Optional[list[LLMPattern]] = None
ZONE_FIELDS = {
    "A": {"speakers", "background", "dialogue"},
    "B": {"vocabulary"},
    "C": {"listening_questions"},
    "D": {"core_sentence_patterns"},
}
```
### 5.6 合并逻辑
```python
def merge_patch(base: LLMArtifact, patch: ArtifactPatch) -> LLMArtifact:
    data = base.model_dump()
    patch_data = patch.model_dump(exclude_none=True)
    for field in ZONE_FIELDS[patch.zone]:
        if field not in patch_data:
            raise ValueError(f"patch 缺少 zone={patch.zone} 的字段 {field}")
        data[field] = patch_data[field]
    return LLMArtifact(**data)
```
合并后必须重新跑完整 `validate_artifact`。
---
## 6. Prompt 设计
### 6.1 System Prompt 全文（主链路，目标版）
```text
你是 TELG 沉浸式场景听力素材生成引擎。
你的任务是为语言学习者生成"像真实发生一样"的双语对话素材，
让学习者在沉浸式场景中自然习得词汇、句型与表达。
学习者可能来自不同身份与阶段：职场人、学生、求职者、技术从业者、
管理者、创业者等。他们通过选择领域、角色、场景语境、时长、
词汇专业度、句式复杂度来定制属于自己的听力素材。
因此，你的输出不是"教科书对话"，也不是"技术文档朗读"，
而是有场景、有角色、有目的、有情绪的真实交流。
技术领域只是你支持的众多领域之一，不是默认领域。
你的输出会被 TTS 合成、被前端按字段渲染、被学习者用于听力与词汇训练，
因此每个字段都必须严格合规。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【一、输出契约（硬约束）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 只输出一个合法 JSON 对象，不要 Markdown、代码块、注释、解释、前后缀说明。
2. 字段名严格一致，不得增删字段，不得改大小写。
3. 所有 *_zh 字段必须是对应英文的准确中文翻译，不是改写、不是摘要。
4. 禁止输出 start_ms、end_ms、duration 等时间戳字段；时间戳由 TTS 写入。
5. 禁止编造具体版本号、性能数字、公司内部架构、真实人名、真实产品缺陷。
   不确定的指标用定性描述（如"明显下降""量级相当"）。
6. 字符串不得为空、不得只含空白；数组不得为空。
7. 禁止在 text_en 中出现中文字符；禁止在 text_zh 中出现整句英文（术语可保留英文）。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【二、JSON Schema（字段级）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "background": {
    "technical_background": "英文：该主题工程背景，2-3 句",
    "technical_principle": "英文：核心技术原理，2-3 句",
    "engineering_scenario": "英文：这段内容发生在什么工作场景，1-2 句",
    "technical_background_zh": "对应中文翻译",
    "technical_principle_zh": "对应中文翻译",
    "engineering_scenario_zh": "对应中文翻译"
  },
  "speakers": [
    {"id": "speaker_1", "role": "具体角色名", "voiceTag": "lead | respond | neutral"}
  ],
  "dialogue": [
    {"speakerId": "speaker_1", "text_en": "英文台词", "text_zh": "对应中文翻译"}
  ],
  "vocabulary": [
    {"en": "英文术语", "zh": "标准译法", "symbol": "符号，无则空串", "def": "英文释义"}
  ],
  "listening_questions": [
    {"q": "问题", "options": ["选项1", "选项2", "选项3"],
     "answer": "正确选项的完整原文", "explain": "答案出自哪句台词",
     "q_zh": "问题的中文翻译", "options_zh": ["各选项中文翻译"],
     "explain_zh": "答案出处的中文翻译"}
  ],
  "core_sentence_patterns": [
    {"title": "句型名", "pattern": "句式模板", "example": "例句",
     "title_zh": "句型名的中文翻译", "pattern_zh": "句式模板的中文翻译",
     "example_zh": "例句的中文翻译"}
  ]
}
字段级规则：
- speakers[].id 用 speaker_1 / speaker_2 / ... 命名；
  dialogue[].speakerId 必须且只能引用已声明的 id。
- speakers[].role 用具体真实角色名，禁用 "Engineer A" / "Speaker 1" 占位。
- dialogue 每句 1–4 句英文，单句不超过 60 词。
- vocabulary.en 必须是对话中出现或强相关的术语；同一术语不重复出现。
- listening_questions.answer 是 options 中的完整原文，必须唯一正确。
- listening_questions.options 至少 2 个、建议 4 个；干扰项看似合理但明确错误。
- core_sentence_patterns.pattern 是可迁移句型模板，example 取自或改写自对话。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【三、词汇专业度字典（只约束词汇）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
L1 生活化：日常聊天用语，贴近生活，术语密度约 10%
L2 职场化：基础商务沟通，术语密度约 25%
L3 技术化：基础技术术语，常见工程表达，术语密度约 40%
L4 专业化：领域专业词汇，准确技术用语，术语密度约 55%
L5 学术化：学术级词汇，接近论文与讲座，术语密度约 65%
禁止：本轴不得影响句子结构、从句层数、句长。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【四、句式复杂度字典（只约束句法）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
L1 简单：短句为主，直白清晰，平均 8–15 词
L2 基础：简单并列复合，平均 12–20 词
L3 常用：含常用从句，有层次，平均 15–25 词
L4 复杂：多从句嵌套，富有变化，平均 18–30 词
L5 学术：长难句频繁，学术式行文，平均 20–35 词
禁止：本轴不得影响词汇难度、术语密度、技术深度。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【五、对话结构硬约束】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
solo（单人讲解）：speakers 恰好 1 人，全程一人连贯讲解，
                  可带少量自问自答，但不得出现第二个说话人。
dialogue（双人对话）：speakers 恰好 2 人，双方对等交流，
                  围绕焦点来回推进，无主次结构。
discussion（多人讨论）：speakers 3–5 人，全部来自用户提供的候选角色；
                  每位至少发言 2 次；存在观点碰撞或信息互补，禁止轮流念稿。
通用：
- 开场 1–2 轮交代场景或抛出问题；
- 中段围绕焦点展开，含具体信息、权衡或排查；
- 收尾自然，不要总结陈词、不要"希望这对你有帮助"式客套。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【六、生成方向字典（仅 refine）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
重写：保持范围与结构，只调整措辞与表达。
扩写：补充更多技术细节与论证，篇幅可增加。
聚焦：收敛到单一侧面深入展开，删减其他分支。
发散：换成不同工程视角，与上一版明显不同。
生成方向仅作用于 refine，首次生成忽略。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【七、领域适配规则】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- 领域由用户在 <scenario><domain> 中指定，可能是技术、职场、学生、商务、学术等。
- 你需根据领域自动选择：术语体系、常见角色、典型场景、交流目的。
- 技术领域：术语准确、机制合规、宁浅勿错。
- 职场领域：目标导向、有协作与分歧、有上下级或跨部门关系。
- 学生领域：有课程、考试、社团、宿舍、求职等典型场景。
- 商务领域：有谈判、汇报、客户沟通、跨文化差异。
- 学术领域：有研讨、答辩、文献讨论、实验协作。
- 若领域未在以上列出，按该领域真实交流方式生成，不得套用技术模板。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【八、质量红线（按优先级）】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
① 场景真实性：无论技术、职场、学生还是商务场景，都要符合该场景的真实交流方式；
   技术内容宁浅勿错，严禁编造；非技术场景不得强行植入技术味。
② 可听性：有现场感、语气词、追问、反驳、澄清；
   避免教科书腔、避免新闻播报腔、避免 AI 味套话。
③ 信息密度：每句带具体信息；删除空泛寒暄、重复确认、无信息量过渡。
④ 教学价值：词汇、题目、句型必须能在对话中找到依据；
   题目难度需与词汇专业度、句式复杂度大致对齐。
⑤ 沉浸感：对话应让学习者感觉"自己就在现场"；
   要有具体场合、具体对象、具体目的；避免泛泛而谈。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【九、翻译规则】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- text_zh 是 text_en 的准确翻译，保持语序自然、术语一致。
- 技术术语优先使用行业通用中文译名；无通用译名时保留英文。
- 翻译中不得引入原文没有的信息，不得删减原文信息。
- 中文标点使用全角；英文标点使用半角。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【十、优先级与冲突解决】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
当设置之间存在冲突时，按以下优先级：
1. 场景语境（context）—— 最高，冲突时以语境为准。
2. 对话形态与角色候选 —— 硬约束，不得违反。
3. 词汇专业度与句式复杂度 —— 软调节，可在语境需要时略微偏离。
4. 生成方向与改进指令 —— 仅 refine 时生效。
若无法同时满足所有约束，优先保证：技术真实性 > 结构合规 > 难度对齐 > 篇幅精确。
请直接输出 JSON。
```
### 6.2 User Prompt 模板（主链路）
```text
请生成一套可直接用于听力训练的双语素材（英文内容 + 中文翻译）。
## 本次任务
- 主题：<topic>
- 领域：<domain>（必须符合该领域真实语境与术语惯例）
- 形态：<format 结构描述>
- 场景语境：<context>
- 词汇专业度 Level <N>：<VOCAB_PROFICIENCY_DEFS[N]>
- 句式复杂度 Level <N>：<SYNTAX_COMPLEXITY_DEFS[N]>
## 生成约束
- 时长 <length> 秒，目标总词数约 <target_words> 词
  （约 <turns> 轮对话，宁精勿灌水）
- 特殊要求：<injections 或 "无">
[可选] - 生成方向：<directions>
## 内容看点
请根据主题自行确定一个最有价值的讨论焦点
（如某参数/方案的权衡、一次故障排查、一场评审分歧），
让内容围绕该焦点自然展开、有张力；不要平铺直叙地罗列知识点。
只输出合法 JSON，不要 Markdown、注释、解释。
```
**format 分支结构描述**：
- solo：`- 形态：单人讲解独白（solo），全程 1 位讲者；- 讲者角色：<role>`
- dialogue：`- 形态：双人平等对话（dialogue，对称）；- 角色：<a> 与 <b>（双方对等交流）`
- discussion：`- 形态：多人讨论（discussion），出场 3–5 人（由你根据语境确定）；- 候选角色：<candidates>；- 从候选角色中挑选最贴合语境的出场人选；候选名单不足 3 位或与语境不适配时，可补充贴合该领域/语境的真实角色（禁止占位名）`
**refine 时首行插入**：
```text
（本次为重新生成：请更换切入角度或结构，内容与上一版不雷同，质量更优。）
```
### 6.3 重试反馈结构（结构化）
```json
{
  "attempt": 2,
  "mode": "patch",
  "zone": "C",
  "errors": [
    {
      "path": "listening_questions",
      "code": "too_few",
      "fix": "至少 2 题，每题至少 2 个选项"
    }
  ],
  "locked_fields": ["speakers", "background", "dialogue", "vocabulary", "core_sentence_patterns"],
  "must_fix_only": true
}
```
**Prompt 中写死**：
```text
本次只允许修改 zone=<zone> 的字段，其他字段不要返回。
只修正上述 path，其他字段原样保留。
```
---
## 7. 字段语义对齐
### 7.1 前端 → 后端 → Prompt 消费
| UI 设置项 | 前端提交 | 后端字段 | Prompt 消费（目标） | 字典 |
|---|---|---|---|---|
| 对话形态 | `format` | `format` | ✅ | FORMATS |
| 练习领域 | `domain` / `domainLabel` | 同 | ✅ | 领域适配规则 |
| 对话角色 | `roles` / `roleSelection` | 同 | ✅ | 角色命名 |
| 场景语境 | `context` | 同 | ✅ 最高优先级 | 冲突解决 |
| 对话时长 | `length` | 同 | ✅ | LENGTH_WORDS |
| 词汇专业度 | `difficulty` | 同 | ✅ | VOCAB_PROFICIENCY_DEFS |
| 句式复杂度 | `advanced.depth` | 同 | ✅ | SYNTAX_COMPLEXITY_DEFS |
| 生成方向 | `advanced.directions` | 同 | ✅ | DIRECTION_DEFS |
| 改进指令 | `advanced.injections` | 同 | ✅ | — |
### 7.2 僵尸参数（待删除）
| 字段 | 前端来源 | 后端消费 | 处理 |
|---|---|---|---|
| `advanced.breadth` | `#breadth-seg` 已不存在，兜底 3 | 写入 prompt | 删除 |
| `advanced.tone` | 隐藏面板 / 硬编码 neutral | 写入 prompt | 删除 |
| `advanced.vocabDensity` | 隐藏面板 `#adv-vocab` | 不写入 prompt | 删除 |
| `advanced.style` | 隐藏面板 `#adv-style` | 不写入 prompt | 删除 |
| `asymmetric` | refine 回填 | 校验 lead/respond | 删除 |
| `roleSelection.speakerCount` | refine 回填 | 写入 prompt | 统一不提交 |
### 7.3 字段语义错位修正
| 原字段 | 原语义 | 修正后 | 字典 |
|---|---|---|---|
| `DIFFICULTY_DEFS` | 混入句长/从句 | 拆为 `VOCAB_PROFICIENCY_DEFS` | 只约束词汇 |
| `DEPTH_DEFS` | 技术深度（概览→主审） | 拆为 `SYNTAX_COMPLEXITY_DEFS` | 只约束句法 |
---
## 8. 校验规则
### 8.1 阻断性校验
- JSON 合法性、Schema 字段类型、必填、枚举；
- 人数与形态：solo=1；dialogue=2；discussion=3–5；
- 角色来源：exact-fill 精确匹配；candidate-pool（discussion）：候选名单 ≥3 位时出场角色必须全部来自候选池；候选名单不足 3 位时允许补充领域真实角色，但补充角色禁止占位名（Engineer A / Speaker 1 等）；
- speakerId 一致性：禁止未声明 / 重复；
- `text_en` 无中文；`text_zh` 含中文；
- 词汇 ≥4、题目 ≥2 且选项 ≥2、句型 ≥2；
- 禁止 `start_ms/end_ms`；
- 总词数 ≤ 目标 3 倍；
- dialogue ≥3 句。
### 8.2 非阻断 warning
- 词汇覆盖率 < 30%；
- 题目答案关键词未在对话中出现；
- 词数偏离目标 ±25%；
- 领域与语境可能不一致；
- 生成方向与上一版差异不明显。
### 8.3 校验伪代码
```python
class ValidationIssue(BaseModel):
    zone: Literal["A", "B", "C", "D", "global"]
    path: str
    code: str
    message: str
    blocking: bool
def validate_artifact(art: LLMArtifact, p: GenerateIn) -> list[ValidationIssue]:
    issues = []
    fmt = (p.format or "dialogue").strip().lower()
    spec = FORMATS.get(fmt, FORMATS["dialogue"])
    # 1. 人数与形态
    n = len(art.speakers); mode = spec["speakerMode"]
    if mode[0] == "fixed" and n != mode[1]:
        issues.append(ValidationIssue(zone="A", path="speakers",
            code="headcount_mismatch",
            message=f"出场人数应为 {mode[1]}，实际 {n}", blocking=True))
    elif mode[0] == "range" and not (mode[1] <= n <= mode[2]):
        issues.append(ValidationIssue(zone="A", path="speakers",
            code="headcount_out_of_range",
            message=f"出场人数应在 [{mode[1]}, {mode[2]}]，实际 {n}", blocking=True))
    # 2. 角色来源
    if spec["roleSelectionMode"] == "exact-fill":
        wanted = [_norm_role(r) for r in request_roles(p)]
        for sp in art.speakers:
            if _norm_role(sp.role) not in wanted:
                issues.append(ValidationIssue(zone="A", path="speakers",
                    code="role_not_in_slots",
                    message=f"出场角色「{sp.role}」不在指定填槽中", blocking=True))
    else:
        cands = {_norm_role(c) for c in ((p.roleSelection or {}).get("candidates") or [])}
        for sp in art.speakers:
            if sp.role and _norm_role(sp.role) not in cands:
                issues.append(ValidationIssue(zone="A", path="speakers",
                    code="role_not_in_candidates",
                    message=f"出场角色「{sp.role}」不在候选池中", blocking=True))
    # 3. speakerId 一致性
    ids = {sp.id for sp in art.speakers}
    if len(ids) != len(art.speakers):
        issues.append(ValidationIssue(zone="A", path="speakers",
            code="duplicate_id", message="speakers 存在重复 id", blocking=True))
    for i, d in enumerate(art.dialogue):
        sid = d.speakerId or d.speaker
        if not sid:
            issues.append(ValidationIssue(zone="A", path=f"dialogue[{i}]",
                code="missing_speaker_id", message="缺少 speakerId", blocking=True))
        elif sid not in ids:
            issues.append(ValidationIssue(zone="A", path=f"dialogue[{i}]",
                code="unknown_speaker_id",
                message=f"引用了未声明的 speakerId: {sid}", blocking=True))
    # 4. 质量守卫
    target = LENGTH_WORDS.get(parse_sec(p.length) or 120, 290)
    total = sum(len(re.findall(r"[a-zA-Z']+", s.text_en)) for s in art.dialogue)
    if total > target * 3:
        issues.append(ValidationIssue(zone="A", path="dialogue",
            code="word_count_over",
            message=f"总词数 {total} 超过目标 {target} 的 3 倍", blocking=True))
    if len(art.dialogue) < 3:
        issues.append(ValidationIssue(zone="A", path="dialogue",
            code="dialogue_too_short", message="dialogue 至少 3 句", blocking=True))
    for i, s in enumerate(art.dialogue):
        if not s.text_en or not s.text_en.strip():
            issues.append(ValidationIssue(zone="A", path=f"dialogue[{i}].text_en",
                code="empty", message="text_en 为空", blocking=True))
        if re.search(r"[\u4e00-\u9fff]", s.text_en):
            issues.append(ValidationIssue(zone="A", path=f"dialogue[{i}].text_en",
                code="contains_chinese", message="text_en 含中文", blocking=True))
    if len(art.vocabulary) < 4:
        issues.append(ValidationIssue(zone="B", path="vocabulary",
            code="too_few", message="vocabulary 至少 4 条", blocking=True))
    if len(art.listening_questions) < 2:
        issues.append(ValidationIssue(zone="C", path="listening_questions",
            code="too_few", message="listening_questions 至少 2 题", blocking=True))
    for i, q in enumerate(art.listening_questions):
        if len(q.options) < 2:
            issues.append(ValidationIssue(zone="C", path=f"listening_questions[{i}]",
                code="options_too_few", message="选项少于 2", blocking=True))
        if q.answer not in q.options:
            issues.append(ValidationIssue(zone="C", path=f"listening_questions[{i}]",
                code="answer_not_in_options", message="answer 不在 options 中", blocking=True))
    if len(art.core_sentence_patterns) < 2:
        issues.append(ValidationIssue(zone="D", path="core_sentence_patterns",
            code="too_few", message="core_sentence_patterns 至少 2 条", blocking=True))
    # 5. 非阻断 warning
    dialogue_text = " ".join(d.text_en for d in art.dialogue).lower()
    hits = sum(1 for v in art.vocabulary if v.en.lower() in dialogue_text)
    if hits / max(len(art.vocabulary), 1) < 0.3:
        issues.append(ValidationIssue(zone="B", path="vocabulary",
            code="low_coverage", message="词汇覆盖率低于 30%", blocking=False))
    for i, q in enumerate(art.listening_questions):
        if q.answer and q.answer.lower() not in dialogue_text:
            issues.append(ValidationIssue(zone="C", path=f"listening_questions[{i}]",
                code="not_grounded", message="答案关键词未在对话中出现", blocking=False))
    if not (target * 0.75 <= total <= target * 1.25):
        issues.append(ValidationIssue(zone="A", path="dialogue",
            code="word_count_deviation",
            message=f"词数 {total} 偏离目标 {target} ±25%", blocking=False))
    return issues
```
---
## 9. 重试机制
### 9.1 分区定义
| Zone | 字段 |
|---|---|
| A | speakers, background, dialogue |
| B | vocabulary |
| C | listening_questions |
| D | core_sentence_patterns |
### 9.2 重试流程
```python
def call_llm_with_retry(p, action):
    artifact = call_llm_full(p, action)          # 完整 Schema
    issues = validate_artifact(artifact, p)
    errors = [i for i in issues if i.blocking]
    warnings = [i for i in issues if not i.blocking]
    log_warnings(warnings)
    if not errors:
        return artifact, issues
    for attempt in range(2, 4):
        failed_zones = group_errors_by_zone(errors)
        for zone in failed_zones:
            patch = call_llm_patch(p, action, artifact, zone, errors)
            artifact = merge_patch(artifact, patch)
        issues = validate_artifact(artifact, p)
        errors = [i for i in issues if i.blocking]
        if not errors:
            return artifact, issues
    raise HTTPException(502, "校验失败")
```
### 9.3 provider 降级策略
1. `json_schema` strict：优先；
2. tool use / function calling：次优；
3. `json_object`：再次；
4. 纯文本 + 后处理：兜底。
**不支持 Partial Schema 时**，退化为「完整 JSON + 区域锁定」：
```python
def call_llm_patch_fallback(p, action, base, zone, errors):
    raw = call_llm_full_with_lock(p, action, base, zone, errors)
    locked_fields = set(LLMArtifact.model_fields) - ZONE_FIELDS[zone]
    for field in locked_fields:
        if raw[field] != base.model_dump()[field]:
            raise ValueError(f"锁定字段 {field} 被修改")
    return ArtifactPatch(zone=zone, **{f: raw[f] for f in ZONE_FIELDS[zone]})
```
---
## 10. 下游联动
### 10.1 TTS 音色映射
**现状**：
- `speakers[].voiceTag` 是 `lead | respond | neutral`；
- 前端 `voice` 字段硬编码 `'en-US-GuyNeural + en-US-JennyNeural'`。
**目标**：
持久化 `speaker_voice_map`：
```json
{
  "speaker_1": "en-US-GuyNeural",
  "speaker_2": "en-US-JennyNeural"
}
```
TTS 按 `speakerId` 映射，不按数组顺序。
### 10.2 meta 持久化
- `meta.speakers`（id / role / voiceTag）
- `meta.format`、`meta.difficulty`、`meta.depth`
- `meta.roles`、`meta.roleSelection`
- `speaker_voice_map`
### 10.3 时间戳
- `start_ms` / `end_ms` **只由 TTS 写入**；
- LLM 输出禁止携带。
---
## 11. 另外 3 条 LLM 链路
### 11.1 学习档案生成
**端点**：`POST /api/v1/config/profile/generate`
**模型**：`ProfileGenIn` → `LLMProfileOut`
**参数**：temperature=0.4，max_tokens=700，response_format=json_object，重试 3 次
**System Prompt 目标版**：
```text
你是 TELG 学习档案生成器，根据用户提供的画像信息，生成一份结构化学习档案。
## 输出契约（硬约束）
- 只输出合法 JSON 对象：
  {"role_portrait": "…", "domain_profile": "…", "focus_tone": "…"}
- role_portrait：基于用户职位/角色，扩写为 2-3 句专业画像
  （该角色的工作语境、常用沟通对象、典型英文表达需求），英文。
- domain_profile：基于用户练习领域，扩写为 3-4 句领域档案
  （该领域术语惯例、典型工作场景、角色画像；术语准确、宁浅勿错），英文。
- focus_tone：基于用户的专注方向与练习场景，给出 1-2 句训练建议与语气偏好，
  英文。
- 未提供的字段保持简洁，不编造。
请直接输出 JSON。
```
### 11.2 引导初始化
**端点**：`POST /api/v1/config/onboarding/generate`
**模型**：`OnboardGenIn` → `OnboardGenOut`
**参数**：temperature=0.4，max_tokens=1400
**System Prompt 目标版**：
```text
你是 TELG 听力素材生成器的一次性初始化引擎，根据用户问卷回答，
同时生成「学习档案」与「推荐配置」。
## 输出契约（硬约束）
- 只输出合法 JSON 对象：
  {"role_portrait": "…", "domain_profile": "…", "focus_tone": "…",
   "domains": [{"id": "…", "name": "…", "desc": "…"}],
   "roles": ["…"], "scenarios": ["…"]}
- role_portrait / domain_profile / focus_tone：规则同学习档案生成。
- domains：4-6 个与该用户紧密相关的领域，第一个必须是主练习领域；
  id 用 kebab-case 小写英文标识（若与内置领域匹配则沿用），
  name 为英文领域名，desc 为不超过 20 字的中文描述。
- roles：3-6 个该领域一线真实岗位（英文岗位名）。
- scenarios：3-6 个贴合该用户工作场景的英文练习场景短语。
- 严格贴合问卷中的角色、领域、语言方向与专注方向，禁止输出无关通用内容。
请直接输出 JSON。
```
### 11.3 推荐配置
**端点**：`POST /api/v1/config/recommendations/generate`
**模型**：`RecDomainOut` / `LLMRecsOut`
**参数**：temperature=0.4，max_tokens=900
**System Prompt 目标版**：
```text
你是 TELG 听力素材生成器的推荐配置引擎，根据用户的学习档案，
为其推荐「领域 / 角色 / 场景」三组选项，作为新建素材弹窗的默认下拉选项。
## 输出契约（硬约束）
- 只输出合法 JSON 对象：
  {"domains": [...], "roles": [...], "scenarios": [...]}
- domains：4-6 个（规则同引导初始化，desc ≤20 字，优先沿用内置 id）。
- roles：3-6 个该领域一线常见真实岗位（英文岗位名），要求真实、专业、可对话。
- scenarios：3-6 个贴合该用户工作场景的英文练习场景短语，真实可演。
- 严格贴合用户档案中的角色、领域、专注方向与画像，禁止输出无关通用内容。
请直接输出 JSON。
```
### 11.4 三条链路共性
- System 静态 + User 直填（无 few-shot）；
- temperature 统一 0.4；
- 重试 3 次 + 错误回填；
- 与主链路共用 `json_object` 降级策略。
---
## 12. 指标与验收
### 12.1 指标
| 指标 | 目标 |
|---|---|
| JSON 合法率 | ≥ 99% |
| 首次校验通过率 | 提升 |
| 平均重试次数 | 下降 |
| 平均 token / 耗时 | 下降 |
| warning 率 | 可观测，不阻断 |
| 人工评分：技术真实性 | ≥ 4/5 |
| 人工评分：可听性 | ≥ 4/5 |
| 人工评分：教学价值 | ≥ 4/5 |
### 12.2 验收方式
- 离线回放 50–100 条历史请求；
- 对比优化前后首次通过率、重试次数、成本；
- 人工抽检 warning 样本；
- 覆盖非技术领域样本（职场、学生、商务）。
### 12.3 事件埋点
- `json_legal_rate`
- `first_pass_rate`
- `retry_count`
- `warning_rate`
- `human_score`
---
## 13. Patch 清单
### 13.1 P0（必须先做）
| # | 位置 | 改动 |
|---|---|---|
| P0-1 | `backend/main.py` 字典 | 删除 `DIFFICULTY_DEFS` / `DEPTH_DEFS`，新增 `VOCAB_PROFICIENCY_DEFS` / `SYNTAX_COMPLEXITY_DEFS` |
| P0-2 | `backend/main.py` `LLM_SYSTEM_PROMPT` | 重写开篇 + 红线 + 领域适配，删除 asymmetric |
| P0-3 | `backend/main.py` `build_user_prompt` | 映射改为 `vocab_proficiency` / `syntax_complexity`；删除 breadth / tone |
| P0-4 | `backend/main.py` `validate_artifact` | 删除 asymmetric 校验；改为返回 `list[ValidationIssue]`；新增 warning |
| P0-5 | `backend/main.py` `GenerateIn` | 新增 `Advanced` 类型；兼容旧 dict |
| P0-6 | `frontend/index.html` `collectParams` | 删除 breadth / tone / vocabDensity / style |
| P0-7 | `frontend/index.html` `paramsFromArt` | 删除 speakerCount / asymmetric / vocabDensity / style / tone / breadth |
| P0-8 | `frontend/index.html` `refineGenerate` | 删除硬编码 tone |
### 13.2 P1（其次）
| # | 位置 | 改动 |
|---|---|---|
| P1-1 | `backend/main.py` | 新增 `ArtifactPatch` / `merge_patch` |
| P1-2 | `backend/main.py` `call_llm_with_retry` | 改为分区重试 |
| P1-3 | `frontend/index.html` `length` | 统一为字符串或数字 |
| P1-4 | `frontend/index.html` `#advanced-panel` | 保留但不再提交 |
### 13.3 P2（可延后）
| # | 位置 | 改动 |
|---|---|---|
| P2-1 | `backend/main.py` TTS 映射 | 新增 `speaker_voice_map` |
| P2-2 | 另外 3 条 System Prompt | 定位去技术化 |
| P2-3 | `topic` / `context` | 去重（前端不再提交 topic） |
| P2-4 | 前端字段名 | `data-depth` → `data-syntax`，`data-level` → `data-vocab` |
---
## 14. 排期与行动项
| 周 | 任务 | Owner |
|---|---|---|
| W1 | P0-1 ~ P0-5：后端字段语义、Prompt、校验 | 后端 |
| W1 | P0-6 ~ P0-8：前端清理 | 前端 |
| W2 | P1-1 ~ P1-2：分区重试 | 后端 |
| W2 | P1-3 ~ P1-4：前端类型与面板 | 前端 |
| W3 | P2-1 ~ P2-4：音色映射、3 条链路、去重 | 后端 + 前端 |
| W3 | 离线回放与指标看板 | 后端 + PM |
| W4 | 评审与上线 | 全员 |
---
## 15. 附录
### 15.1 关键文件与行号
| 文件 | 内容 | 行号 |
|---|---|---|
| `frontend/index.html` | `collectParams` | 5080 |
| `frontend/index.html` | `API.generate` | 2811 |
| `frontend/index.html` | `refineGenerate` | 5391 |
| `frontend/index.html` | `paramsFromArt` | 5268 |
| `frontend/index.html` | `genScene` 初始状态 | 2988 |
| `frontend/index.html` | `genRoleCandidates` | 4057 |
| `frontend/index.html` | `toggleGenRole` | 4246 |
| `frontend/index.html` | `#advanced-panel` HTML | 1389 |
| `frontend/index.html` | i18n 文案 | 3027 / 3209 |
| `frontend/index.html` | `LLM_PRESETS` | 5401 |
| `backend/main.py` | `GenerateIn` | 507 |
| `backend/main.py` | `FORMATS` | 545 |
| `backend/main.py` | `LLM_SYSTEM_PROMPT` | 876–930 |
| `backend/main.py` | `build_user_prompt` | 931–1016 |
| `backend/main.py` | `LLMArtifact` | 1018 |
| `backend/main.py` | `validate_artifact` | 1089–1156 |
| `backend/main.py` | `ProfileGenIn` / `LLMProfileOut` | 1800 |
| `backend/main.py` | `OnboardGenIn` / `OnboardGenOut` | 2185 |
| `backend/main.py` | `RecDomainOut` / `LLMRecsOut` | 2295 |
### 15.2 术语表
| 术语 | 含义 |
|---|---|
| Artifact | 完整生成对象（LLMArtifact） |
| ArtifactPatch | 分区重试对象，只含 zone 字段 |
| Zone A/B/C/D | 分区：A=对话主结构，B=词汇，C=题目，D=句型 |
| 阻断性校验 | 失败即触发重试 |
| warning | 不阻断，只记录 |
| exact-fill | solo / dialogue 的角色精确填槽 |
| candidate-pool | discussion 的角色候选池 |
| speaker_voice_map | speakerId → TTS 音色名 |
### 15.3 变更记录
| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | — | 初稿 |
| v2.0 | — | 基于前端与后端实际代码核对，修正字段语义、删除僵尸参数、扩展 System Prompt、新增分区重试、统一 4 条链路定位 |
| v2.1 | 2026-09-18 | discussion 恢复「候选不足可补充角色」：校验改为候选池 ≥3 严格池内、<3 允许补充真实角色（禁止占位名）；mock 种子数据 answer 统一为完整选项原文、每题补足 ≥2；修复 call_llm_with_retry 调用级重试、i18n contextRequired 访问、datasetGenerate/进度条 context 兜底 |
---
**本设计说明书为 TELG LLM 链路的唯一产品与技术口径，后续实现以本文档为准。**

# 功能体验修复建议（进行中，待确认上库）

**版本**：v0.1（评审稿）
**状态**：待评审 — 代码已改于 `frontend/index.html`，**未提交、未上库**
**范围**：生成等待交互、播放列表体验、句子收藏
**验证**：JS 语法检查 + Playwright 冒烟实测（本地后端启动后验证通过）

---

## 1. 背景

主链路（生成 → 播放 → 收藏 → 素材库）已稳定，本轮聚焦 4 项功能体验细化：

1. 素材生成/合成等待中的界面提示；
2. 创建草稿（生成中）时点击其他素材播放，应有相应交互；
3. 播放列表体验优化；
4. 句子收藏功能优化。

按"先不用那么复杂"的原则，本轮全部采用**最小改动**，不引入新组件、不重构既有结构。

---

## 2. 变更清单

### 2.1 生成中切走不抢焦点（核心修复）

**问题**：生成进行中用户点击其他素材播放，生成完成后 `runGenerate` 会无条件执行 `playArtifact(art)`，把用户正在听的素材**强制切回**新生成的素材——打断当前播放。

**修复**（`frontend/index.html`）：

- `runGenerate` 进入时记录 `genStartCurrentId = state.current ? state.current.id : null`；
- 生成完成块改为按焦点状态分支：
  - 用户已切走（`switchedAway`）：只 `renderLibrary()` 刷新素材列表 + toast「Corpus generated — xxx · it is now in the library」，**不触碰当前 UI**；
  - 用户未切走：维持原行为（toast + `playArtifact(art)` 选中新素材）。
- `loadMaterial` 增加生成/合成中切换的轻提示 toast：`gen.switchHint`（「素材正在生成中，完成后将出现在素材库」），让用户明确后台任务仍在继续。

**一致性说明**：合成（TTS）完成路径此前已是正确行为（`isCurrent` 判定，切走只刷新列表），本轮与生成路径对齐。

### 2.2 生成等待界面提示

**问题**：生成/合成等待时仅有 3 步进度与场景标题，没有"可以继续干别的"的引导，等待感强。

**修复**：

- 新增 `#gen-waiting-note` 提示行（进度条下方、场景标题之下）；
- `runGenerate` 与合成流程均设置该行文案：`gen.waiting`（「生成中，可继续浏览或播放已有素材…」）；
- 中英文案均已加入 i18n（`gen.waiting` / `gen.switchHint` / `pl.skipUnsynth`），随界面语言切换。

### 2.3 播放列表体验

**问题 A**：连播（`queuePlay`）跳过未合成音频的素材时**静默无提示**，用户以为列表播完了。

**修复**：`audio ended` 连播逻辑增加 `skipped` 标记——若存在跳过，toast「已跳过未合成音频的素材」（`pl.skipUnsynth`）。

**问题 B**：用户直接点击素材播放时，若当前未处于任何播放列表上下文，连播无法生效（队列为空）。

**修复**：`loadMaterial` 中，若 `state.activePlaylist` 为空且素材属于某个播放列表，自动将该列表设为活动列表——连播立即有队列上下文。

### 2.4 句子收藏优化

**问题**：收藏条目仅存英文原文（`text: s.text_en`），收藏面板无中文对照，复习价值打折。

**修复**：

- `toggleBookmark` 新增条目字段 `text_zh: s.text_zh || ''`；
- `renderBookmarks` 每条收藏在英文下方显示中文翻译行（`.i-zh` 样式）；
- **兼容旧数据**：历史收藏无 `text_zh` 字段时不渲染翻译行，不报错。

### 2.5 生成素材默认名称规范化（新增）

**问题**：素材默认标题直接取场景语境原文（常为整句长文本），素材库/播放列表显示拥挤；反复生成同一场景会产生同名素材，无法区分。

**修复**：

- 新增 `normalizeTitle`：压缩连续空白、去除首尾标点、超 40 字符截断（尾部截齐），空标题兜底 `Untitled`；
- 新增 `dedupeTitle`：与素材库现有标题查重，同名自动追加 ` #2` / ` #3` …；
- 应用在生成完成块：仅**新建**素材生效（先规范化再去重，再 `PATCH` 回后端）；**refine 保留原素材名**（用户可能已重命名）；
- 不动 `topic/context` 原文——完整语义仍传给 LLM，只规范显示名。

### 2.6 生成焦点判定修复（新增）

**问题**：初版用「起点素材 ≠ 新素材」判定"用户切走"，但用户生成时**未做任何操作**也会被误判，导致新素材生成后不被选中。

**修复**：改为显式导航标记——`runGenerate` 建立 `state.genNavGuard`；`loadMaterial` / `jumpToBookmark`（用户主动加载素材的两个入口）置 `navigated=true`；完成时仅当「导航过且当前素材不是新素材」才不抢焦点，否则照常选中新素材。

---

## 3. 涉及代码位置

| 变更 | 位置（`frontend/index.html`） |
|---|---|
| i18n 新增 key（EN / ZH） | `'gen.contextRequired'` 之后（EN 与 ZH 两处大对象） |
| `#gen-waiting-note` DOM | `#gen-progress-box` 内、`#gen-topic-label` 之后 |
| `runGenerate` 焦点标记 + 完成分支 | `runGenerate` 开头与完成块 |
| 合成流程 waiting note | 合成流程 `setGenSteps('audio')` 处 |
| `loadMaterial` 切换提示 + 自动列表 + 导航标记 | `loadMaterial` 开头 |
| `jumpToBookmark` 导航标记 | `jumpToBookmark` 开头 |
| 连播跳过提示 | `audio ended` 连播块（`pl.materialIds` 循环） |
| 收藏 `text_zh` | `toggleBookmark` / `renderBookmarks` |
| 标题规范化 + 去重 | `normalizeTitle` / `dedupeTitle` / 生成完成块 |

---

## 4. 验证情况

| 项目 | 结果 |
|---|---|
| JS 语法（`node --check`，提取 `<script>` 全量） | ✅ 通过 |
| 生成时未切走 → 完成自动选中新素材 | ✅ 通过（Playwright 冒烟） |
| 生成中切到素材 X → 完成焦点保持 X（toast 提示入库） | ✅ 通过（Playwright 冒烟） |
| 新素材完成入库并刷新列表 | ✅ 通过 |
| 长场景语境 → 标题规范化截断 ≤40 字符 | ✅ 通过 |
| 同一场景重复生成 → 标题自动 `#2` / `#3` | ✅ 通过 |
| 收藏条目写入 `text_zh` | ✅ 通过 |
| 收藏面板渲染中文翻译行（`.i-zh`） | ✅ 通过 |
| 页面运行无 `pageerror` | ✅ 通过 |

> 说明：冒烟测试需本地后端运行（mock 数据集生成链路会调用后端 `importMaterial` 入库），验证后已停止临时后端进程。

---

## 5. 待确认事项

1. **收藏优化形态**：当前仅补中文翻译。是否还需要按素材分组、批量取消、收藏数角标等增强？（本轮按"先简单"未做）
2. **播放列表**：是否需要在播放条上显示队列进度（如「列表 2/5」）或"当前播放素材常显指示"？当前仅自动进入所属列表。
3. **生成等待**：是否需要"取消生成"入口？（本轮未做，避免引入中断语义）

---

## 6. 上库状态

- 本轮全部改动仅在工作区 `frontend/index.html`，**未 commit、未 push**；
- 待确认后按规范上库（commit 中英双语标题 + 逐条正文）。

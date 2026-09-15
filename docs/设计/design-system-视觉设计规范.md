# TELG 视觉与交互规范（Design System）

> 参考：OpenCode / Linear / Vercel / Spotify / Apple Music。目标：成熟的专业生产力工具 + 现代音乐播放器，而不是展示 AI 能力的 Demo。

## 1. 核心原则

```
Less UI, More Content
Less Decoration, More Information
Less Color, More Hierarchy
```

- 中性背景、弱 Border、极少 Shadow、**单一 Accent Color**；
- 层级靠字体、字号、间距、明暗建立，不靠装饰；
- 圆角 6–10px；字体 Inter / Geist / 系统字体栈；
- 深色为主，支持浅色主题切换（全局 `data-theme`）。

## 2. 全局布局（PC 工作区）

```
┌──────────────────────────────────────────────────────────┐
│ Logo / Product Name             Generator    Player       │
├──────────────┬───────────────────────────────────────────┤
│              │              Main Content                 │
│ Navigation   │                                           │
│ (素材库/播放列表) │                                           │
├──────────────┴───────────────────────────────────────────┤
│                  Global Player Bar                       │
└──────────────────────────────────────────────────────────┘
```

- 统一工作台模式：左侧素材库 + 中间材料精读 + 右侧详情（Grounding/Vocab/Quiz/Patterns）+ 底部全局播放条；
- 生成入口：⌘K / ⌘N / 左侧 + New，弹出 OpenCode 风格生成面板（不切页）；
- 左右栏可折叠 / 拖拽调宽（宽度记忆到 localStorage）；
- 两页概念（Generator / Player）已废弃——采用统一工作台，消除页面切换突兀感。

## 3. 播放器（Global Player Bar）

- 固定底部，任何页面保持存在；
- Play/Pause、Seek（轻量进度条，禁止巨大 Waveform）、±10s、倍速、Prev/Next Sentence、Sentence Replay、A-B 书签；
- 进度条仅作极轻的进度视觉元素；
- 句子级高亮：当前播放句用轻微背景 / Accent Highlight；每句支持 Replay；点击句跳转 seek。

## 4. 详情 / 讲义

- Transcript **不用 Chat Bubble**；当前播放句轻背景高亮，中文可整体切换（开关）；
- 右侧 Tab：Grounding / Vocabulary / Quiz / Patterns；
- Blind 模式：英文模糊 + 中文隐藏，训练裸听。

## 5. 设置页规范

- 左侧弱 Tab 导航（图标 + 文字），上下滚动，参考 OpenCode Desktop 设置；
- Tab：General / LLM / TTS / Shortcuts / Developer / About；
- **所有设置点击「Apply」后才生效**；
- 各设置项独立一行，名称 + 一句精简说明 + 右侧控件；
- 相近内容聚类，标题层级用字号/分割线区分；
- LLM：provider / model / base_url / api_key（眼睛图标查看真值，仅存本机 localStorage）/ temperature 滑杆；
- TTS：音色角色每行独立（角色名 + 音色单选 + 独立试听按钮 + 增删）；
- Developer（门控）：开发者模式总开关（默认开，正式发布需 key 解锁），其下才展示 LLM 诊断（请求/响应展示）、TTS 诊断、固化测试数据等；
- 中文字幕开关：只显示 On/Off。

## 6. 禁止项

```
AI Dashboard 风格 · 大量 Card · 大量 Icon · 彩色 Badge
Gradient / Glow · AI 粒子效果 · 巨大 Waveform · Chat Bubble Transcript
无意义动画 · 过度装饰
Icon 仅用于明确功能操作（Play/Pause/Search/Back/More/Close）
```

## 7. 快捷键

| 键 | 功能 |
|---|---|
| ⌘K / ⌘N | 新建素材（生成面板） |
| ⌘Enter | 生成 |
| / | 聚焦搜索 |
| Space | 播放 / 暂停 |
| J / K | 前 / 后一句 |
| R | 重播当前句 |
| Escape | 关闭弹窗 |

输入态与设置弹窗开启时不响应快捷键。

## 8. 响应式

- PC 优先；窗口变窄时左右栏自动折叠（宽度记忆），内容区自适应；
- 480px 以上无横向溢出；设置弹窗窄屏下 Tab 转横向滚动；
- 播放列表/素材库行内操作（改名/删除）在窄屏不换行挤压。

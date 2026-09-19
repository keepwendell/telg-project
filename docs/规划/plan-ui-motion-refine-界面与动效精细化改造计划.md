# 界面与动效精细化改造计划（plan-ui-motion-refine）

> 版本：2026-09-19 · 状态：planned（方案已评审，待排期执行） · 关联文档：[设计/design-system-视觉设计规范](../设计/design-system-视觉设计规范.md)、[规划/architecture-frontend-stack-evolution-前端技术栈演进](./architecture-frontend-stack-evolution-前端技术栈演进.md)、[roadmap-待办事项](./roadmap-待办事项.md)
>
> 本文档是 Scenear 前端 UI 与动效精细化改造的实施蓝本。目标：在不改功能、不动结构、不引入构建链的前提下，用成熟库 + 统一 Token 体系，把整体观感与动效打磨到"成熟生产力工具"水准。

---

## 1. 背景与目标

### 1.1 背景

当前前端为**原生 JS 单页架构**（无构建步骤，Python 后端同源托管），已具备良好的功能基线与设计基础（深/浅双主题、单一 accent、统一工作台布局）。但视觉与动效层面存在三类问题：

1. **风格碎片化**：全局 `tokens.css`（Material 3 风格 `--surface` 体系）、生成面板 `#gen-panel`（独立 V2 调色板 `--g-*`）、Refine 弹窗 `#adjust-modal`（独立变量）三套色板并存，且大量十六进制硬编码（`#0c0e12`、`#12151a`、`#262b33` 等）散落组件样式中——组件越多，风格越发散。
2. **动效零散无体系**：已有动效（`genIn`、`pulse`、`narr-wave`、`roleSpin`、`shake`、toast 滑入、主题过渡等）各自为政，时长/缓动/触发方式不统一，部分交互（seg 切换、tab 指示、列表增删、当前句高亮）缺少状态过渡或过渡生硬。
3. **交互细节粗糙**：Tooltip 定位手写、弹窗遮罩与入场不一致、部分 hover/active 态缺失、滚动条与空态等全局组件质感不统一。

### 1.2 目标

| 目标 | 衡量标准 |
|---|---|
| 风格统一 | 全站收敛为**一套语义 Token**（深/浅双主题），无散落硬编码色值 |
| 动效体系化 | 统一时长/缓动/分层规范，所有交互组件有标准状态过渡 |
| 观感成熟 | 对齐 Linear / Arc 式"工程深色 + 冷静蓝"的成熟生产力工具气质 |
| 功能零影响 | `state.js` 字段、localStorage 键、i18n key、API 契约全部不变 |
| 结构稳定 | DOM class / id 不变，Playwright e2e 全绿 |
| 交付不变 | 最终仍交付单文件 `index.html`（或现有拆分结构打包后），不引入构建链 |

### 1.3 技术约束（决定选型的前提）

- 前端**无构建链**：`frontend/` 由 Python uvicorn 同源托管，不能走 `npm install + bundle` 常规路线；成熟库只能以 **CDN 直引（ESM/UMD）** 或**本地化 vendor 文件**方式落地。
- **e2e 回归基线**：`tests/` 下 Playwright 用例依赖 `.lib-item`、`.trow`、`.seg-item` 等选择器，禁止改 DOM 结构与 class 名。
- **React 迁移不启动**：按《前端技术栈演进》结论"方向合理、时机未到"，本轮改造在原生 JS 架构内完成，不迁移 React。
- 设计规范红线：《视觉设计规范》明确"Less UI More Content / 单一 Accent / 禁止 AI Dashboard 风格、无意义动画"。

---

## 2. 现状盘点

### 2.1 前端文件结构

| 文件 | 规模 | 职责 |
|---|---|---|
| `frontend/index.html` | 1168 行 | 主界面（工作台 + 生成面板 + Refine + 设置 + 播放条 + 全局浮层） |
| `frontend/onboarding.html` | 48 行 + `js/onboarding.js` 544 行 | 首启引导页 |
| `frontend/css/tokens.css` | 32 行 | 设计变量（全局双主题色板、圆角、阴影、字体、缓动） |
| `frontend/css/base.css` | 30 行 | 基础样式 + 全局动效基础 + 主题切换过渡 |
| `frontend/css/components.css` | 971 行 | 全量组件样式（含 gen-panel / adjust-modal 的局部覆盖） |
| `frontend/css/onboarding.css` | 191 行 | 引导页样式 |
| `frontend/js/state.js` | 426 行 | 全局 state + i18n 字典 + 工具函数 |
| `frontend/js/config.js` / `player.js` / `i18n.js` | 790 / 2308 / 1827 行 | 配置 / 播放器 / 国际化 |

### 2.2 界面区块

统一工作台：**顶栏**（brand + 导航 + 引擎状态 + 主题切换）→ **左侧素材库**（可拖拽/折叠）→ **中间台词精读区**（句行 + 生成进度 + 旁白/概述卡）→ **右侧详情面板**（Grounding / Vocabulary / Quiz / Patterns 四 Tab，可折叠）→ **底部全局播放条**（播放控制 + 进度 + 倍速/音量/详情）。另有 ⌘K 生成面板、Refine 弹窗、设置弹窗（6 弱 Tab）、确认/重命名/播放列表弹窗、toast、tooltip、onboarding。

### 2.3 风格碎片问题明细（需要收敛的点）

| 位置 | 现状 | 问题 |
|---|---|---|
| `tokens.css` | `--surface-low/high/highest` + `--primary:#adc6ff`（M3 语义） | 主界面色板 |
| `#gen-panel` | 独立 `--g-*` 变量 + legacy 别名覆盖（近黑 `#0c0e12`、蓝 `#5b9cff`） | 与全局主色不一致（`#adc6ff` vs `#5b9cff`），自成体系 |
| `#adjust-modal` | `--on-mute` 等独立变量 + `html[data-theme]` 内硬编码背景 | 第三套局部方言 |
| 组件样式内 | `#0c0e12`、`#12151a`、`#262b33`、`rgba(91,156,255,.5)` 等直接写死 | 改主题需逐处同步，无法全局调色 |

### 2.4 已有动效清单（保留并规范化的基础）

| 动效 | 位置 | 现状 |
|---|---|---|
| 弹窗入场 `genIn` | `components.css` | 已有（translateY + scale + fade），可用于统一弹窗语言 |
| 主题切换过渡 | `base.css` | body/modal/panel 等 background/color 300ms |
| 状态脉冲 `pulse` | 引擎状态点 | 1.6s 循环 |
| 声波动画 `narr-wave` | 旁白播放 | 三道竖线脉动 |
| 角色试听旋转 `roleSpin` | TTS 试听 | 加载旋转 |
| 报错抖动 `shake` | 重命名弹窗 | 0.4s |
| Toast 滑入 | `.toast` | 22ms 过渡 |
| 按钮 hover/active | `.btn` | 150ms + translateY(1px) |

---

## 3. 总体方案：三层体系

```
┌────────────────────────────────────────────────────────┐
│  L3 组件呈现层：六大区块 + 全局组件，共用一套语言        │
├────────────────────────────────────────────────────────┤
│  L2 动效语言层：时长 / 缓动 / 层级 Motion Token         │
├────────────────────────────────────────────────────────┤
│  L1 Token 收敛层：唯一语义 Token 集（深/浅双主题）      │
└────────────────────────────────────────────────────────┘
```

### 3.1 风格定位

**延续 V2 调色板方向，收敛为全站唯一标准**（与设计规范"OpenCode / Linear"定位一致）：

- 深色主题：近黑底（`#0d0f13` 级）+ 分层灰面 + 单一冷静蓝 accent（`#5b9cff` 系），主界面从 M3 浅蓝 `#adc6ff` 收敛到同一蓝家族。
- 浅色主题：保持现有灰白系 + 对应蓝色 accent（`#2e63c8` 系），与深色同步收敛。
- 全站只用语义 token（`--surface-*` / `--line-*` / `--accent` / `--text-*`），禁止组件内硬编码色值。

### 3.2 设计原则（红线）

1. **功能零影响**：`state.js` 字段、localStorage 键、i18n key、API 契约一律不动。
2. **结构稳定**：DOM class / id 不动（Playwright e2e 依赖）；只改样式表与新增动效脚本。
3. **Token 单源**：色板、圆角、阴影、字体、时长、缓动全部收敛到 `tokens.css`。
4. **双主题同步**：每处改动深/浅两套同验（`html[data-theme]`）。
5. **动效克制**：动效服务功能语义（状态反馈 / 方向引导 / 层级表达），禁止装饰性炫技。
6. **渐进可回退**：四阶段推进，每阶段独立可验证、可回退。
7. **可访问性**：支持 `prefers-reduced-motion` 降级；键盘焦点可见。

---

## 4. 改造范围清单

### 4.1 六大区块

| # | 区块 | 关键改造点 | 涉及样式/结构 |
|---|---|---|---|
| ① | 工作台框架 | 顶栏 hover 态、侧栏折叠/拖拽过渡、面板切换衔接、滚动条统一 | `.app-header` `.lib-sidebar` `.inspector` `.resize-handle` |
| ② | 素材库 | 列表行 hover/active 过渡、新建按钮按压反馈、播放列表展开动画、删除确认态 | `.lib-item` `.lib-new-btn` `.playlist-row` `.pl-expand` |
| ③ | 台词精读区 | 当前句高亮过渡 + 滚动跟随（平滑定位）、盲听模糊开关过渡、翻译展开动画、旁白/概述卡入场 | `.trow` `.trow.active` `.blind-mode` `.trow-zh` `.overview-card` |
| ④ | 生成链路 | 分段控件滑动指示器、chip 增删动画（manage 模式）、生成进度步骤流、trace 行入场、按钮 loading 态 | `#gen-panel` `#fmt-seg` `.chip` `.gen-phase` `.gen-step` `.llm-trace` |
| ⑤ | 播放链路 | 播放/暂停图标过渡、进度条 thumb 拖拽反馈、速度/字体菜单浮层、音量交互、当前句播放态色点 | `.player-bar` `.pb-play` `.pb-seek` `.speed-menu` `.font-menu` |
| ⑥ | 设置与引导 | 弱 Tab 指示器滑动、开关 toggle 过渡、设置行 hover、Onboarding 步骤切换 | `.modal-settings` `.m-tab` `.s-nav-item` `.toggle` `.onboard-step` |

### 4.2 全局横切组件

| 组件 | 改造点 |
|---|---|
| Toast | 统一入场/离场时序（stack 化、图标缩放回弹） |
| Tooltip | 交回 Floating UI 定位（替换手写 `#telg-tip` / `#gen-panel .tooltip` 逻辑），统一入场动效 |
| 弹窗（modal / gen-panel / confirm） | 统一遮罩淡入 + 内容 `genIn` 入场语言，关闭态淡出 |
| 主题切换 | 全站 `background/color/border/box-shadow` 过渡统一（已有基础，补齐遗漏组件） |
| 空态 / 加载态 | 空态图标微动效、生成等待态步骤推进动画（克制） |
| 焦点可见性 | `:focus-visible` 统一 outline 样式 |

### 4.3 不改动清单（明确"保持原样"）

- 所有设置项、输入框、下拉、滑杆、seg 选项、参数键名与默认值；
- 全部 DOM id 与业务 class 名；
- i18n 文案与 key；
- 播放/生成/存储逻辑（`player.js` / `state.js` 业务分支不动，仅允许新增动效调用）。

---

## 5. 动效规范（Motion Token）

在 `tokens.css` 新增动效 token，全站引用：

```css
:root{
  /* 时长（ms） */
  --dur-fast: 120ms;    /* hover / 按压 / 图标态 */
  --dur-base: 200ms;    /* 状态切换 / 入场 / toast */
  --dur-slow: 320ms;    /* 面板展开 / 弹窗 / 主题切换 */
  /* 缓动 */
  --ease-standard: cubic-bezier(.2,.7,.2,1);   /* 现有 --ease，保留为唯一标准 */
  --ease-emphasized: cubic-bezier(.22,.61,.36,1); /* 大弹窗入场（现有 genIn） */
  --ease-decelerate: cubic-bezier(0,0,.2,1);   /* 进入方向 */
  --ease-accelerate: cubic-bezier(.4,0,1,1);   /* 退出方向 */
}
```

**分层规范**：

| 层级 | 场景 | 时长 | 手法 |
|---|---|---|---|
| 功能性 | hover / active / 图标切换 / 开关 | 120–200ms | color/background/border/transform 过渡 |
| 结构性 | 弹窗、侧栏、菜单、列表增删 | 200–320ms | 位移 + 透明度 + 缩放，`emphasized` 缓动 |
| 装饰性 | 声波、脉冲、加载 | 循环动画 | 全局仅保留 3–4 种，其余删除或降级 |

**动效标准目录**（每类组件固定实现，新组件照抄）：

- 按钮：hover 背景/边框 120ms + active `translateY(1px)` 或 `scale(.985)`；
- 分段控件（seg）：激活项滑动背景（利用现有 grid 布局做位移过渡）或选中态 fill 过渡；
- Tab 指示器：下划线 2px 滑动（width 过渡）；
- Toast：底部上滑 + 淡入，`show` 后 2.4s 自动离场；
- Tooltip：淡入 + 4px 位移 + 箭头旋转（Floating UI 定位）；
- 弹窗：遮罩 200ms 淡入 + 内容 320ms `genIn`；
- 当前句高亮：background 200ms + inset 侧边条过渡 + `scrollIntoView({behavior:'smooth'})`（容器内手动平滑定位，避免整页滚动）；
- 盲听模糊：filter 300ms 过渡（已有基础，补全明暗两态）；
- 主题切换：300ms `--ease-standard`，覆盖全部组件（补齐遗漏）。

**降级**：`@media (prefers-reduced-motion: reduce)` 下所有动画/过渡降为瞬时或仅透明度。

---

## 6. 技术选型

**原则**：CDN 直引 / 本地 vendor 化；轻量；不破坏现有结构；动效克制。

| 用途 | 选型 | 引入方式 | 体积 | 说明 |
|---|---|---|---|---|
| 动效引擎 | **Motion**（`motion.dev`，原 framer-motion 轻量版） | ESM CDN：`https://cdn.jsdelivr.net/npm/motion@11/+esm`，或下载至 `frontend/vendor/motion.js` | ~10–15KB gzip | 基于 Web Animations API、零依赖、`animate()` 函数式 API，适配原生 DOM 操作；负责入场/离场编排、列表增删、元素位移 |
| 定位引擎 | **Floating UI**（`@floating-ui/dom`） | ESM CDN：`https://cdn.jsdelivr.net/npm/@floating-ui/dom@1/+esm`，或本地 vendor | ~6KB gzip | 接管 tooltip / popover / 下拉菜单定位，替换手写定位逻辑（`#telg-tip`、`#gen-panel .tooltip`、`#engine-status` 提示等） |
| 质感细节 | 纯 CSS 变量 | 内联 | 0 | 圆角 / 阴影 / 过渡曲线全部 token 化，不引库 |
| 图标 | 保留现有内联 SVG sprite | 内联 | 0 | 风格统一、零成本；不引 icon 库（避免风格侵入） |
| 备选 | **GSAP**（如需复杂时间线/scrub） | CDN：`https://cdn.jsdelivr.net/npm/gsap@3` | ~60KB+ | 仅在出现"进度条 scrub、时间线编排"等明确需求时启用，默认不用 |

**引入策略**：
1. 优先 **本地 vendor**（下载到 `frontend/vendor/`），保证离线可用、e2e 环境稳定，与现有字体加载方式一致；
2. `index.html` 以 `<script type="module">` 引入动效脚本（`js/ui.js` 新增，承载 Motion/Floating UI 封装 + 动效工具函数）；
3. 不修改现有 `player.js` / `state.js` 业务逻辑，动效以"附加增强"方式挂接（`ui.js` 独立文件，页面加载后扫描并增强）。

---

## 7. 实施计划

### 阶段 0：Token 收敛（纯 CSS · 1–2 天）

| 任务 | 说明 | 验证 |
|---|---|---|
| 0.1 硬编码审计 | 扫描 `css/*.css` 与 `index.html` 内联样式，产出"硬编码色值 → 目标 token"映射清单 | 清单完整无遗漏 |
| 0.2 tokens.css 扩展 | 统一色板（深/浅两套）、补齐语义 token（`--accent`/`--text-*`/`--surface-*`/`--line-*`）、新增动效 token（§5） | 深/浅渲染一致 |
| 0.3 收敛 `#gen-panel` | V2 调色板从"独立变量 + legacy 别名"改为**引用全局语义 token**（保留少量专有语义变量） | 生成面板观感不变 |
| 0.4 收敛 `#adjust-modal` | 硬编码背景/边框替换为 token | Refine 弹窗双主题一致 |
| 0.5 组件硬编码清理 | 逐块替换 `components.css` / `onboarding.css` 中的十六进制与裸 rgba | 全站无散落色值（grep 复核） |

**验收**：深/浅 × 主界面/生成面板/Refine/设置 渲染无回归；`grep -rn '#[0-9a-fA-F]\{3,6\}' css/` 仅剩 token 定义处。

### 阶段 1：动效体系落地（1–2 天）

| 任务 | 说明 | 验证 |
|---|---|---|
| 1.1 vendor 引入 | 下载 Motion / Floating UI 至 `frontend/vendor/`，`index.html` 挂载 `js/ui.js` | 无网络依赖可加载 |
| 1.2 动效工具层 | `ui.js`：统一 `ui.fade()` / `ui.slide()` / `ui.pop()` / tooltip 工厂 / toast 工厂，全部读取 Motion Token | 函数可单测调用 |
| 1.3 全局基础动效 | 按钮/seg/tab/toggle/列表行 hover-active 标准过渡（CSS 为主） | 双主题手测 |
| 1.4 浮层统一 | Tooltip 全量接入 Floating UI + 统一入场；弹窗遮罩/入场语言统一 | 所有浮层定位正确 |
| 1.5 reduced-motion | 全局降级规则落地 | 系统开启减弱动效后无异常 |

### 阶段 2：区块精修（3–5 天，按优先级顺序）

> 每区块独立完成、独立验证，互不阻塞。建议顺序：④ 生成链路 → ⑤ 播放链路 → ③ 台词精读区 → ② 素材库 → ① 工作台框架 → ⑥ 设置与引导 → 全局横切组件。

| 区块 | 关键交付 |
|---|---|
| ④ 生成链路 | seg 滑动指示、chip 增删动效、生成步骤推进动画、trace 行入场、loading 态 |
| ⑤ 播放链路 | play/pause 图标过渡、进度 thumb 反馈、菜单浮层统一、当前句播放态动效 |
| ③ 台词精读区 | 当前句高亮 + 容器内平滑滚动、盲听模糊过渡、翻译展开、旁白/概述卡入场 |
| ② 素材库 | 行 hover/active、播放列表展开、删除确认态过渡 |
| ① 工作台框架 | 侧栏折叠/拖拽过渡、顶栏交互态、滚动条统一 |
| ⑥ 设置与引导 | 弱 Tab 指示器、toggle 过渡、Onboarding 步骤切换 |
| 全局 | toast 时序、tooltip、弹窗、空态/加载态、焦点可见性 |

### 阶段 3：验证与交付（1 天）

| 任务 | 说明 |
|---|---|
| e2e 回归 | `tests/` 三个 Playwright 文件全绿（生成链路 / 边界 / 主流程） |
| 渲染矩阵 | 深/浅 × 中/英 × 桌面/窄屏（≤720px）逐区块过一遍截图对比 |
| 打包 | 按 `scripts/package.sh` 流程产出单文件 `index.html` 交付 |
| 文档同步 | 更新本规划状态为 done / 部分完成，记录实际偏差 |

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| CDN 离线导致库加载失败 | 动效失效 | 一律本地 vendor 化；`ui.js` 检测加载失败时静默降级为 CSS 过渡 |
| Motion 与现有 CSS transition 冲突 | 动效异常 | 明确分工：CSS 管 hover/状态，Motion 管入场/编排；不重叠作用同一属性 |
| 改 class 破坏 e2e | 回归失败 | 红线：只改样式与新增脚本，不改 DOM 结构/class/id；改动后先跑 e2e |
| 动画性能（布局抖动） | 掉帧 | 只用 transform/opacity 动画；`will-change` 克制；滚动跟随用容器内定位 |
| 风格收敛导致主界面观感突变 | 用户不适 | 阶段 0 收敛以"肉眼无感"为目标（同色系迁移），先对齐再微调 |
| 双主题遗漏 | 浅色异常 | 每区块完成即跑深/浅截图对比，纳入验收标准 |

---

## 9. 待确认事项

1. **Accent 色收敛方向**：主界面从 `#adc6ff` 收敛到 V2 的 `#5b9cff` 家族（推荐，全站同蓝），还是保持主界面 M3 浅蓝、生成面板单独收敛？→ 默认按前者。
2. **动效强度**：默认"克制派"（仅功能语义动效）；若希望更有"产品质感"（如列表交错入场、面板 spring 弹跳），需明确授权，以便在阶段 2 加入。
3. **交付形式**：沿用现有拆分结构（`index.html + css + js`）由后端托管，还是阶段 3 统一打包单文件？→ 默认与现行交付一致（单文件）。

---

## 10. 决策记录

| 日期 | 决策 | 备注 |
|---|---|---|
| 2026-09-19 | 采纳"三层体系 + 四阶段"改造方案；技术选型 Motion + Floating UI（CDN/vendor 直引）；不启动 React 迁移；红线锁定功能与结构零影响 | 本规划为实施蓝本，执行偏差记录于各阶段验收 |
| 2026-09-19 | **阶段 0（Token 收敛）完成**：tokens.css 重写为唯一权威色板（深/浅双主题收敛至 V2 蓝家族 `#5b9cff`/`#2e63c8`）；gen-panel `--g-*` 与 adjust-modal 全部改为 token 引用；补齐 11 个缺失变量（`--warning`/`--err`/`--accent`/`--dim`/`--font-body`/`--mono`/`--error-container` 等，修复现存失效样式）；onboarding.css 删除自带分叉色板、改引 tokens.css；`css/all.css` 标注废弃（全仓库无引用）。验证：98 个使用变量 0 缺失；深/浅 × 主界面/生成面板/onboarding 浏览器渲染正常；e2e 三文件与基线对比零新增回归（flow 自 B5、tts_roles 自 L6 的失败为既有环境问题） | 动效 token（`--dur-*`/`--ease-*`）已就位，供阶段 1 使用 |
| 2026-09-19 | **阶段 1（动效体系）完成**：vendor 本地化（`frontend/vendor/`：motion.min.js 64KB + floating-ui.core/dom UMD 22KB，全为全局变量格式，file:// 与 http 双环境可用）；新增 `js/ui.js` 动效工具层（`Ui.fadeIn/fadeOut/slideIn/popIn/staggerIn/popIcon` + tooltip 接入 Floating UI，库缺失/reduced-motion 时静默降级）；index.html 挂载 vendor+ui.js；base.css 新增全局标准交互过渡、modal 遮罩 `overlayIn` 淡入、`prefers-reduced-motion` 全局降级；components/onboarding 全部 80 条 transition 时长 token 化（`var(--dur-fast/base/slow)`）、弹窗入场动画统一 token。验证：Playwright 探针确认 Motion/FloatingUIDOM/Ui 加载、Floating UI 计算定位生效（left=328.875/top=198）、无 JS 错误；e2e 三文件与基线逐项对比零新增回归（A1/L9"无 JS 错误"均 PASS） | 阶段 2 起逐区块精修可直接调用 `Ui.*` 工具 |
| 2026-09-19 | **阶段 2-④ 生成链路完成**：seg 滑动指示器（`Ui.enhanceSegAll` 给 12 个 .seg 注入 .seg-thumb，CSS transition 驱动滑动，`has-seg-thumb` 作用域隔离不影响 onboarding；openGenPanel 调 `layoutSegThumbs` 处理 hidden 面板打开时尺寸为 0 的问题）；trace 行入场（`appendLlmTrace` 新行 `Ui.fadeIn`）；gen-step 推进（`genPaint` 当前步骤淡入反馈）。验证：探针确认 thumb 位置随 active 正确滑动（392/577/761 三档）、无 JS 错误；edge e2e 全 PASS | Motion 的 transform 字符串动画不可靠，改 CSS transition；点击监听需 setTimeout 0 等业务 renderGenScene 完成 |
| 2026-09-19 | **阶段 2-⑤ 播放链路完成**：play/pause 图标交叉淡入（`setPlayIcon` 改 opacity 切换而非 display，两图标 absolute 重叠 + `--dur-fast` opacity 过渡）；speed/font 菜单 `Ui.slideIn` 入场；`.trow` 当前句高亮加 background/box-shadow `--dur-fast` 过渡。验证：探针确认 playing/paused 时图标 opacity 0/1 正确切换、speed 菜单正常打开、无 JS 错误 |  |
| 2026-09-19 | **阶段 2-③ 台词精读区完成**：素材加载后台词行 `Ui.staggerIn` 交错入场（stagger 15ms）；翻译展开（max-height transition）、盲听模糊（filter blur transition）、平滑滚动跟随（scrollIntoView smooth）均已有，无需改 |  |
| 2026-09-19 | **阶段 2-② 素材库完成**：`.lib-item` transition 补 box-shadow/border-color（active 高亮条、删除确认态平滑）；现状 hover/active 过渡已够，克制派不过度 |  |
| 2026-09-19 | **阶段 2-① 工作台框架完成**：侧栏折叠 width 过渡、顶栏 btn-icon hover 已有；**修复**——滚动条样式从废弃 `all.css` 迁移到 `base.css`（`::-webkit-scrollbar` 系列），之前 all.css 无引用导致滚动条样式丢失 |  |
| 2026-09-19 | **阶段 2 验收**：edge e2e 全 PASS；flow A1（无 JS 错误）PASS、B1-B4 PASS、B5 起失败与基线完全一致（既有环境问题）；tts_roles L9 PASS、L6/L7 既有失败。零新增回归 | ⑥ 设置与引导、全局横切在克制派下已有基础（弹窗 genIn/tab 过渡），不做大改 |

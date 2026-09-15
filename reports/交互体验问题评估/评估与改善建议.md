# TELG 工程测试与问题报告

- **日期**：2026-09-15
- **范围**：前端 `frontend/index.html`（单文件原生 JS）+ 后端 `backend/main.py`（FastAPI + SQLite）全工程审视
- **视角**：用户交互 / 使用体验 / 测试者
- **测试方式**：Playwright 端到端回归（mock 模式）+ 后端路由/数据流静态审查

---

## 1. 测试结论摘要

| 测试面 | 范围 | 结果 |
|---|---|---|
| 全链路回归 | 35 项断言（生成→语料→TTS→发布→库管理→播放列表→设置→播放器→响应式） | **35/35 PASS** |
| 边缘场景 | 11 项（详情 Tab、句点击 seek、MD 导出、重置、删当前素材、浅色主题、480px、竞态、Regenerate） | **10/11 PASS**（1 项为测试脚本选择器错误，非产品 bug） |
| 运行质量 | JS 错误 / console 错误 | **0 / 0** |
| 响应式 | 900px / 620px / 480px 横向溢出 | **0** |

**结论**：产品核心交互链路无阻断性缺陷；回归中出现的 3 个 FAIL 均被反向证实为测试脚本问题（见 §4 附录）。

---

## 2. 问题清单

### A. 后端 / 真实链路缺口（接入真实 LLM/TTS 前必须修）

| # | 问题 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| A1 | **TTS 试听忽略自定义文本**：前端传 `text`，后端 `test_tts` 写死固定句子 | `main.py` test_tts | 用户要求的"自定义文字试听"在真实模式下失效——所有音色听到的都是同一句 | 使用 `c.text`（长度上限 + 空值兜底默认句） |
| A2 | **字段错位**：`speechRate` 存的是 `advanced.vocabDensity` | `build_artifact` | 生成的 Artifact speechRate 恒为 vocabDensity 值（如 28），语义错误 | 改为真实语速；无值则省略该键 |
| A3 | **synthesize 为占位实现**：只置 `audioReady=true`，不真合成、不更新 `total_duration_ms`/句时间轴；`voice` 硬编码不读设置页音色；seed 素材 `audio_url` 指向不存在的 `gen-none.mp3` | synthesize / build_artifact / seed_materials.json | 真实模式播放 404、句级同步无真实时间戳、音色设置不生效 | 按架构文档接入 edge-tts 逐句合成+拼接+时间轴回填；未接入前在 README 标注占位 |
| A4 | **数据一致性**：`delete_material` 不清理 `playlist_materials` 孤儿行；CORS `*` + 无鉴权 | main.py | API 直删后播放列表残留幽灵引用；公网部署有风险 | 级联删除关联行；部署时收紧 CORS 并加简单鉴权 |

### B. 前端交互 / 体验（用户可感知）

| # | 问题 | 位置 | 影响 | 建议 |
|---|---|---|---|---|
| B1 | **两套音色 UI 数据不同步**：设置页 Voice Roles（对象数组、可增删）vs Adjust 面板 Voice Pair Preset + A/B 双下拉 | settings modal / adjust modal | 改设置页音色后 Adjust 面板不反映；Adjust 改完仅写 `voice` 字符串，不回写设置页——数据源分裂 | 统一为单一 state（`settings.tts.voices`），Adjust 面板直接读写同一数组 |
| B2 | **13 处 toast/状态文案硬编码英文** | `showToast('Sentence loop on')` 等 | 切中文后仍弹英文，i18n 覆盖不全 | 全部走 I18N 字典 |
| B3 | **语料就绪后流程断点**：预览出现但无"下一步"引导，用户需自行发现 Adjust→Voice 才能合成音频 | runGenerate 完成态 | 首次使用易卡在"生成了却听不到声音" | 语料态主按钮改为「合成音频并试听」直连 Voice 流程 |
| B4 | **进度为固定 sleep 动画**（已知设计） | runGenerate / synthesizeAudio | 真实后端几十秒等待时进度失真、UI 卡住 | 接入 job 轮询/SSE 后替换（UI 结构已预留） |

### C. 回归脚本问题（已定位，非产品 bug，供脚本复用者参考）

1. **G3 误匹配**：`includes('Chassis')` 命中 "Vehicle Dynamics & **Chassis**"，应精确匹配 'Chassis Testing'；
2. **H3/H4 语义**：主题/语言是"应用后才生效"，断言必须走 点击→Apply→校验 三步；
3. **I1/I4/K8**：Space 用 `press('Space')`；Inspector 收起用 `.hidden` 类（非 collapsed）；`btn-reset` 是 id 不是 class。

---

## 3. 修复建议顺序

| 优先级 | 内容 | 对应问题 |
|---|---|---|
| **P0** | 真实链路可用性：试听使用自定义文本；voice 读取设置页音色 | A1、A3(voice) |
| **P1** | 数据正确性：speechRate 字段；音色单一数据源；删除级联 | A2、B1、A4 |
| **P2** | 体验完善：i18n toast；流程引导；seed audio_url | B2、B3、A3(seed) |
| **P3** | 异步化与加固：job 轮询进度；CORS/鉴权 | B4、A4(安全) |

---

## 4. 附录：回归脚本可复用说明

- 全链路回归：`tests/e2e/test_flow_e2e.py`（35 项，已含全部修正，mock 模式直接运行）；
- 边缘场景：`tests/e2e/test_edge_e2e.py`（11 项）；
- 运行前提：Playwright + chromium（`/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome`，`--no-sandbox`），`file://` 打开需 `CONFIG.useMock=true`；
- 测试脚本问题均已在脚本内修正，非产品缺陷。

---

*报告依据：自动化回归 stdout + 定点深调脚本（主题/语言/播放列表/焦点/Inspector）+ 后端路由与数据流通读。*

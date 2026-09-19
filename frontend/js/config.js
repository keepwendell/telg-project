const API_ORIGIN = (function () {
  try {
    const ov = JSON.parse(localStorage.getItem('telg-settings') || 'null');
    if (ov && ov.backendBase) return String(ov.backendBase).replace(/\/+$/, '');
  } catch (e) {}
  return 'http://127.0.0.1:8000';
})();
const CONFIG = {
  devMode: true,                    /* release builds set this to false (Developer settings hidden; unlock with key) */
  apiBase: API_ORIGIN + '/api/v1',
  speeds: [0.8, 1.0, 1.25, 1.5],
  fontSizes: ['13px', '15px', '17px'],
  diffHints: {
    1: 'Casual daily language, close to real life.',
    2: 'Basic business communication, common workplace phrases.',
    3: 'Core technical terms, common engineering expressions.',
    4: 'Domain-specific vocabulary, precise technical wording.',
    5: 'Academic-grade vocabulary, close to papers and lectures.'
  },
  lenHints: { '120': '~240 words', '300': '~725 words', '480': '~1160 words', '720': '~1740 words', '900': '~2175 words' },
  depthLabels: {
    1: 'Short sentences, straightforward structure',
    2: 'Simple coordinated structures, basic connectors',
    3: 'Common subordinate clauses, layered expression',
    4: 'Multiple nested clauses, varied sentence patterns',
    5: 'Frequent long complex sentences, academic style'
  }
};
/* Phase-scoped mock. Two independent switches, both gated by Developer Mode,
   each default OFF:
   - LLM Mock: simulate the LLM corpus-generation stage; the main page shows
     the intermediate steps (prompt → template match → corpus → validate).
   - TTS Mock: take over the corpus source (fixed dataset); audio synthesis,
     audition and playback always run against the real backend.
   Everything else stays live regardless of these switches. */
function llmMockOn() {
  if (!CONFIG.devMode) return false;
  return String(localStorage.getItem('telg-llm-mock') || '').trim() === '1';
}
function ttsMockOn() {
  if (!CONFIG.devMode) return false;
  return String(localStorage.getItem('telg-tts-mock') || '').trim() === '1';
}
/* Any LLM-stage mock active? (kept as the umbrella predicate for the
   generation pipeline: TTS Mock also implies the corpus source is fixed.) */
function mockMode() { return llmMockOn() || ttsMockOn(); }
/* ---------- LLM intermediate-step trace (LLM Mock link debugging) ---------- */
function showLlmTrace(show) {
  const el = $('llm-trace');
  if (el) { el.classList.toggle('hidden', !show); if (show) el.innerHTML = ''; }
}
function appendLlmTrace(msg, cls) {
  const el = $('llm-trace');
  if (!el || el.classList.contains('hidden')) return;
  const line = document.createElement('div');
  line.className = 'tr-line';
  line.innerHTML = '<span class="tr-t">' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '</span><span class="' + (cls || '') + '"></span>';
  line.lastChild.textContent = msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  if (window.Ui && Ui.fadeIn) Ui.fadeIn(line, { duration: Ui.getDur('fast') });
}
function readSavedSettings() {
  try { return JSON.parse(localStorage.getItem('telg-settings') || 'null') || {}; } catch (e) { return {}; }
}
/* Single source of truth for provider display names; "custom" covers any
   OpenAI-compatible endpoint not in LLM_PRESETS (type your own base/model). */
const PROVIDER_LABELS = { deepseek: 'DeepSeek', moonshot: 'Kimi (Moonshot)', ark: '豆包 · Volcengine Ark', openai: 'OpenAI', qwen: 'Qwen (DashScope)', ollama: 'Ollama (Local)', custom: 'Custom' };
/* Latest engine self-check: { ts, llm: {name,ok,detail,ms}, tts: {name,ok,detail,ms} }.
   Kept in memory + localStorage so a page reload shows the last result
   immediately instead of blinking "checking" every time. */
let engineCheck = null;
const ENG_CHECK_TTL = 30 * 60 * 1000; /* re-run at most every 30 min, or on click / after Apply */
function fmtCheckTs(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + p(d.getDate()) + ' ' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
/* Map raw backend/network error text to a short human-readable phrase. */
function friendlyErr(e, lang) {
  const s = String(e || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const zh = lang === 'zh';
  const rules = [
    [/\\(placeholder\\)|placeholder key/i, zh ? '使用占位 Key，未配置真实 Key' : 'placeholder key, no real key set'],
    [/api[ _-]?key contains non[- ]ascii/i, zh ? 'API Key 含非 ASCII 字符' : 'API key has non-ASCII chars'],
    [/returned html instead of json|not served here|static file server/i, zh ? '后端不可达（非 API 服务）' : 'backend unreachable (not an API server)'],
    [/connection timed? ?out/i, zh ? '网络连接超时' : 'connection timeout'],
    [/connection refused/i, zh ? '连接被拒绝' : 'connection refused'],
    [/failed to fetch|fetch failed|network error/i, zh ? '网络请求失败' : 'network request failed'],
    [/unauthorized|invalid api key|\b401\b/i, zh ? 'Key 无效或未授权' : 'invalid or unauthorized key'],
    [/\b429\b|rate limit/i, zh ? '请求频率受限' : 'rate limited'],
    [/model not found|model .*not.*exist/i, zh ? '模型不存在或不可用' : 'model not found'],
  ];
  for (const [re, msg] of rules) if (re.test(s)) return msg;
  return s;
}
/* Compress a raw error into a short user-facing toast line. */
function humanToast(msg, lang) {
  const s = String(msg || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const f = friendlyErr(s, lang);
  if (f !== s) return f;
  return s.length > 130 ? s.slice(0, 130) + '…' : s;
}
function renderEngineTip(c) {
  const tip = $('eng-tip'); if (!tip) return;
  if (!c || !c.llm || !c.tts) { tip.textContent = state.lang === 'zh' ? '自检中…' : 'Self-check…'; return; }
  const lang = state.lang;
  const fmtTime = ts => {
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const llmStatus = c.llm.ok ? (lang==='zh' ? '可用' : 'OK') : (lang==='zh' ? '不可用' : 'Offline');
  const ttsStatus = c.tts.ok ? (lang==='zh' ? '可用' : 'OK') : (lang==='zh' ? '不可用' : 'Offline');
  const L = (lang==='zh' ? 'LLM 状态：' : 'LLM: ') + c.llm.name + ' — ' + llmStatus;
  const T = (lang==='zh' ? 'TTS 状态：' : 'TTS: ') + c.tts.name + ' — ' + ttsStatus;
  const lx = c.llm.detail ? friendlyErr(c.llm.detail, lang) : (c.llm.ok && c.llm.ms ? c.llm.ms + 'ms' : '');
  const tx = c.tts.detail ? friendlyErr(c.tts.detail, lang) : (c.tts.ok && c.tts.ms ? c.tts.ms + 'ms' : '');
  const refresh = (lang==='zh' ? '刷新时间：' : 'Refreshed: ') + fmtTime(c.ts);
  tip.textContent = L + (lx ? '\n' + (lang==='zh' ? '详情：' : 'Detail: ') + lx : '')
    + '\n' + T + (tx ? '\n' + (lang==='zh' ? '详情：' : 'Detail: ') + tx : '')
    + '\n' + refresh;
}
function updateEngineBadge() {
  const dot = $('eng-dot'), label = $('eng-label'), mode = $('eng-mode');
  if (!dot || !label) return;
  const s = readSavedSettings();
  const llm = s.llm || {};
  const llmProv = LLM_PRESETS[llm.provider] ? llm.provider : 'custom';
  const llmName = PROVIDER_LABELS[llmProv] || llmProv;
  const ttsProv = normalizeTTSProvider((s.tts || {}).provider || 'edge-tts');
  const ttsName = ttsProv === 'kokoro' ? 'Kokoro' : (ttsProv === 'cosyvoice' ? 'CosyVoice' : 'edge-tts');
  label.textContent = llmName + ' · ' + ttsName;
  if (mode) mode.textContent = (llmMockOn() || ttsMockOn()) ? 'mock' : 'live';
  /* The dot reflects the latest REAL self-check result (test-llm / test-tts
     against the live backend), not just "has a key been typed". */
  let c = engineCheck;
  if (!c) { try { const raw = localStorage.getItem('telg-engine-check'); if (raw) c = JSON.parse(raw); } catch (e) {} }
  if (!c || !c.llm || !c.tts) {
    dot.classList.add('pulse'); dot.classList.remove('warn');
    dot.style.background = 'var(--warning)';
    renderEngineTip(null);
    return;
  }
  const ok = c.llm.ok && c.tts.ok;
  dot.classList.add('pulse'); dot.classList.toggle('warn', !ok);
  dot.style.background = ok ? 'var(--ok)' : 'var(--warning)';
  renderEngineTip(c);
}
/* Run a real connection self-check for LLM and TTS with the applied settings.
   Clicking the badge forces a fresh run; otherwise a cached result (≤30 min)
   is reused so the page never auto-fires slow TTS syntheses repeatedly. */
async function selfCheck(force) {
  try {
    if (engineCheck && !force && Date.now() - engineCheck.ts < ENG_CHECK_TTL) { updateEngineBadge(); return; }
  } catch (e) {}
  engineCheck = { ts: Date.now(), llm: null, tts: null };
  updateEngineBadge();
  const s = readSavedSettings();
  const llm = s.llm || {};
  const llmProv = LLM_PRESETS[llm.provider] ? llm.provider : 'custom';
  const llmName = PROVIDER_LABELS[llmProv] || llmProv;
  let lr; const t0 = performance.now();
  try {
    lr = await API.testLLM({ provider: llmProv, base_url: llm.baseUrl || '', api_key: llm.apiKey || '', model: llm.model || '', temperature: parseFloat(llm.temperature) || 0.7 });
  } catch (e) { lr = { ok: false, error: e.message }; }
  engineCheck.llm = { name: llmName, ok: !!lr.ok, detail: lr.error || (lr.mock ? 'Mock' : (lr.model || '')), ms: Math.round(performance.now() - t0) };
  const tts = s.tts || {};
  const ttsProv = normalizeTTSProvider(tts.provider || 'edge-tts');
  const ttsName = ttsProv === 'kokoro' ? 'Kokoro' : (ttsProv === 'cosyvoice' ? 'CosyVoice' : 'edge-tts');
  let tr; const t1 = performance.now();
  try {
    tr = await API.testTTS({ provider: ttsProv, voice: '', speech_rate: parseFloat(tts.speechRate) || 1.0, style: '', text: '' });
  } catch (e) { tr = { ok: false, error: e.message }; }
  engineCheck.tts = { name: ttsName, ok: !!tr.ok, detail: tr.error || (tr.mock ? 'Mock' : ''), ms: Math.round(performance.now() - t1) };
  try { localStorage.setItem('telg-engine-check', JSON.stringify(engineCheck)); } catch (e) {}
  updateEngineBadge();
}
/* Pause every audition <audio> (settings page + adjust modal). Called when
   leaving the audition area so audio never keeps playing behind a closed UI. */
function stopAuditions() {
  ['tts-audio', 'adj-audio'].forEach(id => {
    const a = document.getElementById(id);
    if (!a) return;
    try { a.pause(); } catch (e) {}
    a.onended = null;
    a.removeAttribute('src');
  });
}

/* ---------------- MOCK DATA (Generation Artifacts) ---------------- */
const MOCK_MATERIALS = [
  {
    "id": "m1",
    "meta": {
      "title": "Tire Burst Stability Control",
      "topic": "Tire Burst Stability Control",
      "domain": "Automotive",
      "role": "Vehicle Dynamics Engineer",
      "scenario": "Technical Discussion & Trade-off",
      "dialogue_type": "technical_discussion",
      "difficulty": "Level 3",
      "length": "medium",
      "llm_provider": "DeepSeek-V3",
      "tts_provider": "edge-tts",
      "voice": "en-US-GuyNeural + en-US-JennyNeural",
      "audio_url": "/mock/audio/m1.wav",
      "total_duration_ms": 65000,
      "audioReady": false,
      "tag": "ESC / VDC",
      "filter": "Automotive",
      "overview": {
        "text_en": "In a 120 km/h highway blowout simulation, a Vehicle Dynamics engineer and a Controls lead review ESC calibration and whether differential braking can hold the car stable before the driver reacts.",
        "text_zh": "在120公里/小时高速爆胎仿真中，车辆动力学工程师与控制负责人评审ESC标定，并讨论差动制动能否在驾驶员反应前稳住车辆。"
      }
    },
    "background": {
      "technical_background": "A sudden front-axle tire burst causes instantaneous loss of cornering stiffness (C_α) and generates severe rolling resistance disparity. This unbalances longitudinal drag, producing an unexpected disruptive yaw moment that pulls the chassis abruptly toward the blown tire side.",
      "technical_principle": "The active chassis system uses rapid differential braking (ESC) coupled with e-axle negative torque allocation on the healthy side. By tracking the driver's steering intent via target yaw rate models (r_ref), closed-loop stabilization mitigates sideslip angle buildup within 60 ms.",
      "engineering_scenario": "120 km/h highway straight-line blowout simulation — ESC calibration review between a Vehicle Dynamics engineer and a Controls lead.",
      "technical_background_zh": "前轴轮胎突然爆胎导致侧偏刚度（C_α）瞬时丧失，并产生严重的滚动阻力差。这使纵向阻力失衡，产生意外且具有破坏性的横摆力矩，将整车猛然拉向爆胎一侧。",
      "technical_principle_zh": "主动底盘系统采用快速差动制动（ESC），并结合健康侧的电子轴负扭矩分配。通过目标横摆角速度模型（r_ref）跟踪驾驶员的转向意图，闭环稳定可在60毫秒内抑制质心侧偏角的累积。",
      "engineering_scenario_zh": "120公里/小时高速直线爆胎仿真——车辆动力学工程师与控制负责人之间的ESC标定评审。"
    },
    "dialogue": [
      {
        "id": 1,
        "speaker": "Engineer A",
        "role": "Vehicle Dynamics",
        "voice": "GuyNeural",
        "start_ms": 0,
        "end_ms": 8000,
        "text_en": "We noticed an aggressive yaw divergence during the 120 kph straight-line blowout simulation on the left front wheel. The baseline ESC was far too sluggish to counteract the immediate rolling resistance spike.",
        "text_zh": "我们在左前轮120公里时速直线爆胎仿真中观察到剧烈的横摆发散。基础ESC介入过于迟缓，无法有效抵消瞬时滚动阻力骤增。"
      },
      {
        "id": 2,
        "speaker": "Engineer B",
        "role": "Controls Lead",
        "voice": "JennyNeural",
        "start_ms": 8000,
        "end_ms": 19000,
        "text_en": "Right. Because your lateral cornering stiffness on that corner drops to near zero instantaneously. What did the sideslip angle look like before differential braking kicked in?",
        "text_zh": "没错。因为该侧车轮的侧偏刚度瞬间跌落至接近零。在差动制动介入之前，质心侧偏角的变化如何？"
      },
      {
        "id": 3,
        "speaker": "Engineer A",
        "role": "Vehicle Dynamics",
        "voice": "GuyNeural",
        "start_ms": 19000,
        "end_ms": 32000,
        "text_en": "Sideslip climbed beyond 3.8 degrees within 180 milliseconds. If we don't apply an opposing compensatory yaw moment across the rear axle via torque vectoring right away, the driver has virtually zero control margin.",
        "text_zh": "质心侧偏角在180毫秒内攀升超过3.8度。如果不立即通过后桥扭矩矢量分配施加反向补偿横摆力矩，驾驶员几乎没有操纵裕度。"
      },
      {
        "id": 4,
        "speaker": "Engineer B",
        "role": "Controls Lead",
        "voice": "JennyNeural",
        "start_ms": 32000,
        "end_ms": 46000,
        "text_en": "Agreed. Let's calibrate the feedforward compensator based on wheel speed variance and the direct estimated burst drag force, right into the target yaw rate calculation.",
        "text_zh": "同意。我们基于轮速方差和直接预估的爆胎阻力标定前馈补偿器，直接纳入目标横摆角速度计算。"
      },
      {
        "id": 5,
        "speaker": "Engineer A",
        "role": "Vehicle Dynamics",
        "voice": "GuyNeural",
        "start_ms": 46000,
        "end_ms": 57000,
        "text_en": "And we need to adapt the effective rolling radius estimate in real time, otherwise the wheel speed sensors will trigger false ABS interventions.",
        "text_zh": "我们还需要实时修正有效滚动半径的估计，否则轮速传感器会触发误报的ABS干预。"
      },
      {
        "id": 6,
        "speaker": "Engineer B",
        "role": "Controls Lead",
        "voice": "JennyNeural",
        "start_ms": 57000,
        "end_ms": 65000,
        "text_en": "Exactly. Let's schedule a closed-loop validation on the HIL rig tomorrow morning and review the yaw error budget.",
        "text_zh": "正是。明天上午我们在HIL台架上做一轮闭环验证，并复核横摆误差预算。"
      }
    ],
    "vocabulary": [
      {
        "en": "cornering stiffness",
        "zh": "侧偏刚度",
        "symbol": "C_α",
        "def": "Ratio of tire lateral force per radian of slip angle within the linear elastic envelope."
      },
      {
        "en": "asymmetric yaw moment",
        "zh": "不对称横摆力矩",
        "symbol": "M_z",
        "def": "Unbalanced rotational moment about the vertical axis that pulls the chassis sideways."
      },
      {
        "en": "differential braking",
        "zh": "差动制动",
        "symbol": "Δp",
        "def": "Applying brake force independently to single wheels to generate a corrective yaw moment."
      },
      {
        "en": "effective rolling radius",
        "zh": "有效滚动半径",
        "symbol": "R_eff",
        "def": "Distance travelled per radian of wheel rotation under load; used to compute slip ratio."
      }
    ],
    "listening_questions": [
      {
        "q": "Why was the baseline ESC too slow to react during the burst event?",
        "options": [
          "Brake fluid temperature exceeded the thermal limit.",
          "Its intervention was far too delayed for the instant rolling resistance spike.",
          "The steering angle sensor lost its calibration frame."
        ],
        "answer": 1,
        "explain": "Segment 00:00 — Engineer A stresses the baseline ESC was \"far too sluggish to counteract the immediate rolling resistance spike.\"",
        "q_zh": "为什么基线ESC在爆胎事件中反应过慢？",
        "options_zh": [
          "制动液温度超过了热限值。",
          "其介入对瞬时滚动阻力骤增来说过于迟缓。",
          "转向角传感器丢失了标定基准。"
        ],
        "explain_zh": "片段00:00——工程师A强调基线ESC“过于迟缓，无法有效抵消瞬时滚动阻力骤增”。"
      },
      {
        "q": "What does Engineer B propose for the feedforward compensator?",
        "options": [
          "Increase total friction braking force symmetrically.",
          "Use wheel speed variance and estimated burst drag force in the target yaw rate calculation.",
          "Disconnect the electric powertrain immediately."
        ],
        "answer": 1,
        "explain": "Segment 00:32 — \"calibrate the feedforward compensator based on wheel speed variance and the direct estimated burst drag force...\"",
        "q_zh": "工程师B对前馈补偿器提出了什么建议？",
        "options_zh": [
          "对称地增加总摩擦制动力。",
          "在目标横摆角速度计算中使用轮速方差和估计的爆胎阻力。",
          "立即断开电驱动动力总成。"
        ],
        "explain_zh": "片段00:32——“基于轮速方差和直接预估的爆胎阻力标定前馈补偿器……”。"
      }
    ],
    "core_sentence_patterns": [
      {
        "title": "Root-Cause Deduction",
        "pattern": "\"That explains the sudden [phenomenon]...\"",
        "example": "\"That explains the sudden drop in CAN bus voltage when the precharge relay closes.\"",
        "title_zh": "根因推断",
        "pattern_zh": "“这就解释了突然的[现象]……”",
        "example_zh": "“这就解释了预充继电器闭合时CAN总线电压的突然跌落。”"
      },
      {
        "title": "Controller Requirement",
        "pattern": "\"Our [subsystem] needs to [action] within [timeframe] to generate [effect]...\"",
        "example": "\"Our torque vectoring controller needs to apply differential braking within 30 ms to generate an opposing restoring moment.\"",
        "title_zh": "控制器需求",
        "pattern_zh": "我们的[子系统]需要在[时间范围]内[动作]，以产生[效果]……",
        "example_zh": "我们的扭矩矢量控制器需要在30毫秒内施加差动制动，以产生对向的恢复力矩……"
      },
      {
        "title": "Adverse Consequence Warning",
        "pattern": "\"...otherwise the [component] will trigger false [intervention].\"",
        "example": "\"...otherwise the wheel speed sensors will trigger false ABS interventions.\"",
        "title_zh": "不利后果预警",
        "pattern_zh": "……否则[部件]将触发误报的[干预]。",
        "example_zh": "……否则轮速传感器将触发误报的ABS干预。"
      }
    ]
  },
  {
    "id": "m2",
    "meta": {
      "title": "CAN Bus Jitter & Packet Drop",
      "topic": "CAN Bus Jitter & Packet Drop",
      "domain": "Embedded SW & Firmware",
      "role": "Embedded Kernel Debugger",
      "scenario": "Root-Cause Failure RCA Meeting",
      "dialogue_type": "root_cause_analysis",
      "difficulty": "Level 2",
      "length": "short",
      "llm_provider": "DeepSeek-V3",
      "tts_provider": "edge-tts",
      "voice": "en-US-GuyNeural + en-US-JennyNeural",
      "audio_url": "/mock/audio/m2.wav",
      "total_duration_ms": 60000,
      "audioReady": false,
      "tag": "CAN / RTOS",
      "filter": "Software",
      "overview": {
        "text_en": "At a morning RCA meeting, an embedded lead and a kernel debugger trace intermittent CAN frame loss that only appears on cold starts, comparing oscilloscope signals against the bit-time tolerance window.",
        "text_zh": "在早晨的根因分析会上，嵌入式负责人与内核调试工程师排查只在冷启动时出现的CAN帧丢失，对照位时序容差窗口比对示波器信号。"
      }
    },
    "background": {
      "technical_background": "Intermittent frame loss on a chassis domain CAN bus appears only at low temperatures. A transceiver that powers up before its reference oscillator stabilizes can produce corrupted or dropped frames during the cold-start window.",
      "technical_principle": "The bus sample point must sit inside the bit-time tolerance window. If oscillator drift shifts the sample point, bit errors accumulate and the error counter triggers bus-off states, degrading real-time control traffic.",
      "engineering_scenario": "Morning RCA meeting on cold-start frame loss — embedded lead and kernel debugger reviewing oscilloscope traces and error counters.",
      "technical_background_zh": "底盘域CAN总线的间歇性帧丢失仅在低温时出现。收发器在其参考振荡器稳定之前上电，会在冷启动窗口内产生损坏或丢失的帧。",
      "technical_principle_zh": "总线采样点必须落在位时间容差窗口内。若振荡器漂移使采样点偏移，位错误将累积并使错误计数器触发总线关闭状态，降低实时控制通信质量。",
      "engineering_scenario_zh": "针对冷启动帧丢失的晨间根本原因分析会——嵌入式负责人与内核调试工程师共同查看示波器波形和错误计数器。"
    },
    "dialogue": [
      {
        "id": 1,
        "speaker": "Engineer A",
        "role": "Embedded Lead",
        "voice": "GuyNeural",
        "start_ms": 0,
        "end_ms": 9000,
        "text_en": "We keep seeing intermittent CAN frame loss on the chassis domain bus during cold starts. It only shows up below minus ten degrees.",
        "text_zh": "冷启动时我们在底盘域总线上反复看到间歇性的CAN帧丢失。只有零下十度以下才会出现。"
      },
      {
        "id": 2,
        "speaker": "Engineer B",
        "role": "Kernel Debugger",
        "voice": "JennyNeural",
        "start_ms": 9000,
        "end_ms": 20000,
        "text_en": "Could be the transceiver waking up before the oscillator has stabilized. What's the bit-error rate on the trace?",
        "text_zh": "可能是收发器在晶振稳定之前就唤醒了。轨迹上的误码率是多少？"
      },
      {
        "id": 3,
        "speaker": "Engineer A",
        "role": "Embedded Lead",
        "voice": "GuyNeural",
        "start_ms": 20000,
        "end_ms": 32000,
        "text_en": "Around one point four times ten to the minus four, which is well above our threshold. The jitter on the sync segment also looks suspicious.",
        "text_zh": "大约1.4×10⁻⁴，远高于我们的阈值。同步段的抖动看起来也很可疑。"
      },
      {
        "id": 4,
        "speaker": "Engineer B",
        "role": "Kernel Debugger",
        "voice": "JennyNeural",
        "start_ms": 32000,
        "end_ms": 60000,
        "text_en": "Let's capture the waveforms with the new scope and compare the sample points against the tolerance window. That will tell us whether to fix it in the driver or in the transceiver.",
        "text_zh": "我们用新示波器抓取波形，把采样点与容差窗口对比。这能判断该修驱动还是收发器。"
      }
    ],
    "vocabulary": [
      {
        "en": "bit error rate",
        "zh": "误码率",
        "symbol": "BER",
        "def": "Ratio of erroneous bits to total transmitted bits over a measurement window."
      },
      {
        "en": "transceiver",
        "zh": "收发器",
        "symbol": "PHY",
        "def": "Physical-layer device that converts between the bus differential signal and digital bits."
      },
      {
        "en": "oscillator",
        "zh": "晶振",
        "symbol": "f_clk",
        "def": "Clock source that must stabilize before reliable bit sampling can start."
      },
      {
        "en": "sample point",
        "zh": "采样点",
        "symbol": "t_smp",
        "def": "Position within the bit time where the receiver samples the bus level."
      }
    ],
    "listening_questions": [
      {
        "q": "What is the primary suspect for the cold-start frame loss?",
        "options": [
          "A broken cable shield",
          "The transceiver waking up before the oscillator stabilizes",
          "A baud rate mismatch between nodes"
        ],
        "answer": 1,
        "explain": "Segment 00:09 — Engineer B hypothesizes: \"Could be the transceiver waking up before the oscillator has stabilized.\"",
        "q_zh": "冷启动帧丢失的主要嫌疑是什么？",
        "options_zh": [
          "电缆屏蔽层破损",
          "收发器在振荡器稳定之前提前唤醒",
          "节点间波特率不匹配"
        ],
        "explain_zh": "片段00:09——工程师B推测：“可能是收发器在振荡器稳定之前提前唤醒了。”"
      }
    ],
    "core_sentence_patterns": [
      {
        "title": "Hypothesis Framing",
        "pattern": "\"Could be [cause A] before [condition B]...\"",
        "example": "\"Could be the watchdog firing before the scheduler is ready.\"",
        "title_zh": "假设构建",
        "pattern_zh": "可能是[原因A]先于[条件B]……",
        "example_zh": "可能是看门狗在调度器就绪之前触发。"
      },
      {
        "title": "Measurement Request",
        "pattern": "\"Let's capture [signal] and compare [measure] against [reference].\"",
        "example": "\"Let's capture the voltage rail and compare the ripple against the spec.\"",
        "title_zh": "测量请求",
        "pattern_zh": "让我们采集[信号]，并将[测量值]与[参考值]进行比较。",
        "example_zh": "让我们采集电压轨，并将纹波与规格进行比较。"
      }
    ]
  },
  {
    "id": "m3",
    "meta": {
      "title": "Torque Vectoring in Turn-in",
      "topic": "Torque Vectoring in Turn-in",
      "domain": "Automotive",
      "role": "Control Algorithm Architect",
      "scenario": "Technical Discussion & Trade-off",
      "dialogue_type": "technical_discussion",
      "difficulty": "Level 4",
      "length": "long",
      "llm_provider": "DeepSeek-V3",
      "tts_provider": "edge-tts",
      "voice": "en-US-GuyNeural + en-US-JennyNeural",
      "audio_url": "/mock/audio/m3.wav",
      "total_duration_ms": 75000,
      "audioReady": false,
      "tag": "TV / AWD",
      "filter": "Drivetrain",
      "overview": {
        "text_en": "Two control engineers debate torque vectoring during hard turn-in, weighing rear-axle brake torque against e-axle drive torque when the inside wheel starts to unload.",
        "text_zh": "两位控制工程师在激烈入弯工况下讨论扭矩矢量分配，权衡内侧轮开始卸载时后轴制动力矩与电轴驱动扭矩的取舍。"
      }
    },
    "background": {
      "technical_background": "During hard turn-in, the inside rear wheel unloads and loses lateral grip before the front axle reaches its slip limit, capping achievable yaw acceleration and delaying the driver's requested rotation.",
      "technical_principle": "Torque vectoring biases drive torque toward the outside rear wheel to create an additional yaw moment. The intervention must be gated by estimated friction and steering rate — early biasing trades longitudinal traction for yaw response; late biasing misses the corner entry.",
      "engineering_scenario": "Vehicle dynamics development meeting on corner-entry behavior — dynamics engineer and control architect aligning the intervention strategy.",
      "technical_background_zh": "急转弯入弯时，内侧后轮卸载并在前轴达到侧滑极限之前失去横向抓地力，限制了可达到的横摆加速度，延迟了驾驶员请求的车身旋转响应。",
      "technical_principle_zh": "扭矩矢量分配将驱动扭矩偏向外部后轮，以产生额外的横摆力矩。干预必须由估计的摩擦系数和转向速率门控——过早介入会以纵向牵引力换取横摆响应，过晚介入则会错过入弯时机。",
      "engineering_scenario_zh": "关于入弯行为的车辆动力学开发会议——动力学工程师与控制架构师对齐干预策略。"
    },
    "dialogue": [
      {
        "id": 1,
        "speaker": "Engineer A",
        "role": "Vehicle Dynamics",
        "voice": "GuyNeural",
        "start_ms": 0,
        "end_ms": 9000,
        "text_en": "During hard turn-in the inside rear wheel keeps losing grip before the front axle reaches its slip limit. We lose yaw response exactly when the driver needs it.",
        "text_zh": "急转向入弯时，内后轮在前轴到达滑移极限之前就失去了抓地力。恰在驾驶员需要横摆响应时我们丢失了它。"
      },
      {
        "id": 2,
        "speaker": "Engineer B",
        "role": "Controls Architect",
        "voice": "JennyNeural",
        "start_ms": 9000,
        "end_ms": 20000,
        "text_en": "That's the classic yaw-acceleration shortfall. The torque vectoring controller should pre-emptively bias torque to the outer rear wheel.",
        "text_zh": "这是典型的横摆角加速度不足。扭矩矢量控制器应该预先把扭矩偏向弯外后轮。"
      },
      {
        "id": 3,
        "speaker": "Engineer A",
        "role": "Vehicle Dynamics",
        "voice": "GuyNeural",
        "start_ms": 20000,
        "end_ms": 33000,
        "text_en": "But if we shift too early, we trade longitudinal traction for yaw response, and the driver feels the nose tuck in under partial throttle.",
        "text_zh": "但如果转移过早，我们会拿纵向牵引力换横摆响应，部分油门下车头会明显内收。"
      },
      {
        "id": 4,
        "speaker": "Engineer B",
        "role": "Controls Architect",
        "voice": "JennyNeural",
        "start_ms": 33000,
        "end_ms": 47000,
        "text_en": "Right, so we gate the intervention on the estimated friction coefficient and the steering rate, not just the yaw error alone.",
        "text_zh": "对，所以介入要由预估附着系数和转向速率门控，而不是只看横摆误差。"
      },
      {
        "id": 5,
        "speaker": "Engineer A",
        "role": "Vehicle Dynamics",
        "voice": "GuyNeural",
        "start_ms": 47000,
        "end_ms": 75000,
        "text_en": "Agreed. Let's run a swept-steer maneuver matrix tomorrow and log the outer-wheel slip margin across different surface conditions.",
        "text_zh": "同意。明天我们跑一遍扫频转向工况矩阵，记录不同路面下弯外轮的滑移裕度。"
      }
    ],
    "vocabulary": [
      {
        "en": "yaw-acceleration shortfall",
        "zh": "横摆角加速度不足",
        "symbol": "ṙ",
        "def": "Insufficient rotational acceleration to meet the driver's intended path change."
      },
      {
        "en": "friction coefficient",
        "zh": "附着系数",
        "symbol": "μ",
        "def": "Tire-road grip ratio used to estimate available lateral force."
      },
      {
        "en": "slip margin",
        "zh": "滑移裕度",
        "symbol": "Δα",
        "def": "Headroom between current slip and the peak lateral-force point of the tire curve."
      },
      {
        "en": "swept-steer maneuver",
        "zh": "扫频转向工况",
        "symbol": "Δδ(t)",
        "def": "A test run with linearly increasing steering input to excite the chassis dynamics."
      }
    ],
    "listening_questions": [
      {
        "q": "When should the torque biasing intervention be gated?",
        "options": [
          "Always at full throttle",
          "On the estimated friction coefficient and the steering rate",
          "Only after ABS activates"
        ],
        "answer": 1,
        "explain": "Segment 00:33 — Engineer B: \"we gate the intervention on the estimated friction coefficient and the steering rate, not just the yaw error alone.\"",
        "q_zh": "扭矩偏置干预应在何时被门控？",
        "options_zh": [
          "始终在全油门时",
          "根据估计的摩擦系数和转向速率",
          "仅在ABS激活之后"
        ],
        "explain_zh": "片段00:33——工程师B：“我们根据估计的摩擦系数和转向速率门控干预，而不仅仅依据横摆误差。”"
      }
    ],
    "core_sentence_patterns": [
      {
        "title": "Trade-off Framing",
        "pattern": "\"If we [action] too early, we trade [A] for [B]...\"",
        "example": "\"If we pre-charge the pack too early, we trade cell lifetime for response time.\"",
        "title_zh": "权衡表述",
        "pattern_zh": "如果我们过早[动作]，就会用[A]换取[B]……",
        "example_zh": "如果我们过早预充电电池包，就会用电芯寿命换取响应时间。"
      },
      {
        "title": "Test Design",
        "pattern": "\"Let's run a [maneuver] matrix and log [metric] across [conditions].\"",
        "example": "\"Let's run a thermal cycling matrix and log cell voltage across all SOC points.\"",
        "title_zh": "试验设计",
        "pattern_zh": "让我们运行一个[工况]矩阵，并在[条件]范围内记录[指标]。",
        "example_zh": "让我们运行一个热循环矩阵，并在所有SOC点记录电芯电压。"
      }
    ]
  }
];

/* ---------------- API FACADE (mock-first, backend-ready) ---------------- */
function validateLLMCfg(cfg) {
  /* Config sanity check used when no real backend is reachable (mock mode). */
  if (!cfg || !String(cfg.base_url || '').trim()) return 'base_url is empty';
  const b = String(cfg.base_url).trim();
  if (!/^https?:\/\//i.test(b)) return 'base_url must start with http:// or https://';
  const k = String(cfg.api_key || '').trim();
  if (!k) return 'api_key is empty';
  if (/[^\x20-\x7e]/.test(k)) return 'api_key contains non-ASCII characters (placeholder?) — enter a real key';
  return null;
}

/* Normalize backend-relative URLs (audio etc.) to absolute against API_ORIGIN. */
function absUrl(u) {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) === '/') return API_ORIGIN + u;
  return API_ORIGIN + '/' + u;
}

/* Robust fetch wrapper: turns network errors and non-JSON (HTML) responses
   into actionable messages instead of "Unexpected token '<'". */
async function apiFetch(path, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
  let res;
  try {
    res = await fetch(CONFIG.apiBase + path, Object.assign({ signal: ctrl.signal }, opts || {}));
  } catch (e) {
    clearTimeout(timer);
    throw new Error('Cannot reach backend at ' + CONFIG.apiBase + ' — start FastAPI (uvicorn backend.main:app --reload) and open http://localhost:8000');
  }
  clearTimeout(timer);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    let body = '';
    try { body = (await res.text()).slice(0, 100).replace(/\s+/g, ' '); } catch (_) {}
    throw new Error('Backend returned HTML instead of JSON (' + res.status + ') — the page was opened without FastAPI. Start backend/main.py and open http://127.0.0.1:8000 (not a static server)' + (body ? ' · got: ' + body.slice(0, 60) : ''));
  }
  const data = await res.json();
  if (!res.ok) {
    const msg = data && data.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}
async function apiFetchSoft(path, opts) {
  try { return await apiFetch(path, opts); }
  catch (e) { return { ok: false, error: e.message }; }
}

const API = {
  async generate(params, replaceId) {
    /* TTS Mock: corpus take-over (dataset). LLM Mock: still calls the real LLM
       (link debugging) — force test_mode off so the backend never substitutes
       its own mock. */
    if (ttsMockOn()) return datasetGenerate(params, replaceId);
    if (llmMockOn()) params = Object.assign({}, params, { test_mode: false });
    if (replaceId) return apiFetch('/materials/' + replaceId + '/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
    return apiFetch('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  },
  /* SSE 流式生成语料 */
  generateStream(params, onProgress, onComplete, onError) {
    return new Promise((resolve, reject) => {
      fetch(API_ORIGIN + '/api/v1/generate/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      }).then(response => {
        if (!response.ok) throw new Error('Network response was not ok');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        function read() {
          reader.read().then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.step === 'complete' && data.status === 'done') {
                    onComplete && onComplete(data.result);
                    resolve(data.result);
                  } else if (data.status === 'error') {
                    onError && onError(data.message);
                    reject(new Error(data.message));
                  } else {
                    onProgress && onProgress(data);
                  }
                } catch (e) {
                  console.error('SSE parse error:', e);
                }
              }
            }
            read();
          }).catch(err => {
            onError && onError(err.message);
            reject(err);
          });
        }
        read();
      }).catch(err => {
        onError && onError(err.message);
        reject(err);
      });
    });
  },
  async importMaterial(art) {
    return apiFetch('/materials/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifact: art }) });
  },
  async regenerateMaterial(id, params) {
    return apiFetch('/materials/' + id + '/regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  },
  async listMaterials() {
    return apiFetch('/materials');
  },
  async getMaterial(id) {
    return apiFetch('/materials/' + id);
  },
  async synthesize(id, cfg) {
    return apiFetch('/materials/' + id + '/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg || {}) }, 300000);
  },
  /* SSE 流式合成语音 */
  synthesizeStream(id, cfg, onProgress, onComplete, onError) {
    return new Promise((resolve, reject) => {
      fetch(API_ORIGIN + '/api/v1/materials/' + id + '/synthesize/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg || {})
      }).then(response => {
        if (!response.ok) throw new Error('Network response was not ok');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        function read() {
          reader.read().then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const data = JSON.parse(line.slice(6));
                  if (data.step === 'complete' && data.status === 'done') {
                    onComplete && onComplete(data.result);
                    resolve(data.result);
                  } else if (data.status === 'error') {
                    onError && onError(data.message);
                    reject(new Error(data.message));
                  } else {
                    onProgress && onProgress(data);
                  }
                } catch (e) {
                  console.error('SSE parse error:', e);
                }
              }
            }
            read();
          }).catch(err => {
            onError && onError(err.message);
            reject(err);
          });
        }
        read();
      }).catch(err => {
        onError && onError(err.message);
        reject(err);
      });
    });
  },
  async voices(provider) {
    return apiFetchSoft('/tts/voices?provider=' + encodeURIComponent(provider || 'edge-tts'));
  },
  async health() {
    return apiFetch('/health', {}, 8000);
  },
  async usage(gran, offsetDays) {
    if (mockMode()) throw new Error('mock');
    return apiFetch('/usage?granularity=' + (gran || 'week') + '&offset_days=' + (offsetDays || 0));
  },
  async patchMaterial(id, patch) {
    return apiFetch('/materials/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  },
  async deleteMaterial(id) {
    return apiFetch('/materials/' + id, { method: 'DELETE' });
  },
  async listPlaylists() {
    return apiFetch('/playlists');
  },
  async createPlaylist(name) {
    return apiFetch('/playlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  },
  async renamePlaylist(id, name) {
    return apiFetch('/playlists/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  },
  async deletePlaylist(id) {
    return apiFetch('/playlists/' + id, { method: 'DELETE' });
  },
  async addToPlaylist(pid, mid) {
    return apiFetch('/playlists/' + pid + '/materials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ material_id: mid }) });
  },
  async removeFromPlaylist(pid, mid) {
    return apiFetch('/playlists/' + pid + '/materials/' + mid, { method: 'DELETE' });
  },
  async testLLM(cfg) {
    /* Connection test always hits the live backend — it diagnoses real
       reachability, so it is NOT gated by Test Data / mock mode. */
    const err = validateLLMCfg(cfg);
    if (err) return { ok: false, error: err };
    return apiFetchSoft('/config/test-llm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  },
  async testTTS(cfg) {
    return apiFetchSoft('/config/test-tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  },
  async testGenerate(cfg) {
    if (llmMockOn()) { await new Promise(r => setTimeout(r, 800)); return { ok: true, latency_ms: 42, segs: 6, words: 290, total_ms: 120000, title: 'Tire Burst Stability Control' }; }
    return apiFetchSoft('/config/test-generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  },
  async promptPreview(params) {
    /* Pure prompt assembly on the backend — always real, regardless of
       LLM Mock (it never calls the LLM and needs no API key). */
    return apiFetchSoft('/config/prompt-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
  },
  async unlockDev(key) {
    if (mockMode()) { await new Promise(r => setTimeout(r, 200)); return { ok: key === 'telg-dev' }; }
    return apiFetchSoft('/config/unlock-dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  }
};

/* Mock generator: keyword-match a content pool, re-stamp meta from params */

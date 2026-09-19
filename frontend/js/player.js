function narrEndMs(art) {
  const n = art && art.meta && art.meta.narration;
  return n ? (Number(n.end_ms) || 0) : 0;
}
function hasNarration(art) {
  const n = art && art.meta && art.meta.narration;
  return !!(n && n.text_en && (Number(n.end_ms) || 0) > 0);
}
/* 手动播放旁白：进度条跳到旁白段起点播放（仅旁白，播完停在旁白段末尾）。
   旁白与正文在同一个合成文件里，播放互斥由同一 audio 天然保证。 */
function playNarration() {
  const art = currentArtifact();
  if (!art || art.meta.audioReady !== true) { showToast('Audio not synthesized yet — click Synthesize Audio', 'warn'); return; }
  if (!hasNarration(art)) return;
  seek(0, false);
  state.narrOnly = true;
  play();
}
function toggleNarration() {
  if (state.narrOnly && state.playing) { pause(); return; }
  if (state.narrOnly && !state.playing) { play(); return; }
  playNarration();
}
function setListenMode(mode) {
  state.listenMode = mode;
  applyListenMode();
}
function applyFontSize(fs) {
  state.fontIdx = Math.max(0, CONFIG.fontSizes.indexOf(fs));
  $('font-label').textContent = fs;
  /* 整体影响整个页面的字体大小：通过 CSS 变量控制 */
  document.documentElement.style.setProperty('--transcript-font-size', fs);
  const ins = $('inspector');
  if (ins) ins.dataset.fs = state.fontIdx;
  /* transcript 里的句子直接应用字号 */
  document.querySelectorAll('#transcript-list .trow-en, #transcript-list .trow-zh').forEach(el => {
    el.style.fontSize = fs; el.style.lineHeight = (parseInt(fs) + 9) + 'px';
  });
}
function setFontMenu() {
  const m = $('font-menu');
  m.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.fs === CONFIG.fontSizes[state.fontIdx]));
}
function toggleFontMenu() {
  const m = $('font-menu');
  const hidden = m.classList.toggle('hidden');
  if (!hidden) { setFontMenu(); if (window.Ui && Ui.slideIn) Ui.slideIn(m, { duration: Ui.getDur('fast') }); }
}
function closeFontMenu() { $('font-menu').classList.add('hidden'); }
function syncLoopUI() {
  const b = document.getElementById('btn-pb-loop');
  if (b) b.classList.toggle('on', state.loop);
}
function toggleLoop() {
  if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; }
  state.loop = !state.loop;
  syncLoopUI();
  if (state.loop) {
    /* entering loop: jump to the start of the current sentence so the loop
       is actually heard from the beginning of the sentence */
    const idx = currentSegIndex();
    if (idx >= 0) seekSentence(idx, state.playing);
  }
  showToast(state.loop ? 'Sentence loop on' : 'Sentence loop off', 'info');
}
function syncDetailBtn() {
  const ins = document.querySelector('.inspector'), btn = $('btn-pb-subs');
  if (!ins || !btn) return;
  const has = !!state.current;      /* show the Details control only when there is content */
  const on = has && !ins.classList.contains('hidden');
  btn.classList.toggle('on', on);
  btn.style.display = has ? '' : 'none';
}
function toggleInspector() {
  const ins = document.querySelector('.inspector');
  ins.classList.toggle('hidden');
  syncDetailBtn();
}


/* ---------------- GENERATOR FLOW ---------------- */
function buildLLMConfig() {
  try {
    const s = JSON.parse(localStorage.getItem('telg-settings') || 'null');
    return s && s.llm ? { provider: s.llm.provider, base_url: s.llm.baseUrl, api_key: s.llm.apiKey, model: s.llm.model, temperature: parseFloat(s.llm.temperature) || 0.7 } : {};
  } catch (e) { return {}; }
}
function buildTestMode() {
  try {
    const s = JSON.parse(localStorage.getItem('telg-settings') || 'null');
    return !!(s && s.llm && s.llm.testMode);
  } catch (e) { return false; }
}
function collectParams() {
  const sc = state.genScene;
  const fmt = sc.format || 'dialogue';
  const payload = {
    domain: sc.domain ? sc.domain.id : '',
    domainLabel: sc.domain ? sc.domain.name : '',
    format: fmt,
    context: (sc.context || '').trim(),
    difficulty: +document.querySelector('#diff-seg .seg-item.active').dataset.vocab,
    length: document.querySelector('#len-seg .seg-item.active').dataset.length,
    llm: llmDisplayLabel(), tts: normalizeTTSProvider((readStoredCfg().tts || {}).provider) || 'edge-tts', voice: 'en-US-GuyNeural + en-US-JennyNeural',
    llm_config: buildLLMConfig(),
    test_mode: buildTestMode(),
    advanced: {
      depth: +document.querySelector('#depth-seg .seg-item.active').dataset.syntax,
      injections: $('adv-inject').value,
      directions: []
    }
  };
  if (fmt === 'solo') {
    const r = (sc.roles || []).filter(Boolean);
    /* 用户角色是优先项：没选就留空，由 LLM 按领域与语境补充真实角色 */
    payload.roles = { speaker: r[0] || '' };
  } else if (fmt === 'dialogue') {
    const r = (sc.roles || []).filter(Boolean);
    payload.roles = { a: r[0] || '', b: r[1] || '' };
  } else {
    const cands = (sc.roles || []).filter(Boolean);
    /* candidates are a preference, not a hard roster — headcount and final
       cast are left to the model (speakerCount omitted) */
    payload.roleSelection = { candidates: cands };
  }
  return payload;
}
function setPhases(done, active) {
  active = (active === undefined) ? -1 : active;
  const box = $('gen-phases');
  box.classList.remove('hidden');
  const frac = Math.min(3, done + (active >= 0 ? 1 : 0));
  $('gen-phases-fill').style.width = (frac * 100 / 3) + '%';
  $('gen-phases-pct').textContent = frac + '/3';
  document.querySelectorAll('.gen-phase').forEach((ph, i) => {
    ph.classList.toggle('active', i === active);
    ph.classList.toggle('done', i < done);
    ph.querySelector('.gen-phase-n').innerHTML = String(i + 1);
  });
}
function syncPhases() {
  const art = state.current;
  if (!art || !art.meta.generated) { $('gen-phases').classList.add('hidden'); return; }
  const a = art.meta;
  if (a.saved === true) { $('gen-phases').classList.add('hidden'); return; }
  if (a.audioReady === true) setPhases(2);
  else setPhases(1);
}
function setSynthBanner() {
  const art = currentArtifact();
  const banner = $('synth-banner');
  if (!art || !art.meta.generated) { banner.classList.add('hidden'); return; }
  const label = $('synth-banner-label');
  if (art.meta.saved === true) { banner.classList.add('hidden'); return; }
  const corpusState = art.meta.audioReady === false;
  banner.classList.remove('hidden');
  label.textContent = I18N[state.lang][corpusState ? 'tr.synth' : 'tr.audioReady'];
  $('btn-refine').classList.toggle('hidden', !corpusState);
  $('btn-synth').classList.toggle('hidden', !corpusState);
  $('btn-edit-audio').classList.toggle('hidden', corpusState);
  $('btn-publish-banner').classList.toggle('hidden', corpusState);
  /* while a generation or synthesis task is running, every action in the
     banner must be disabled — no concurrent edits during the pipeline */
  const busy = state.synthesizing || state.generating;
  ['btn-refine','btn-synth','btn-edit-audio','btn-publish-banner'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) el.disabled = busy;
  });
}
function genPaint(steps, i) {
  const now = Date.now();
  steps.forEach((s, j) => {
    s.classList.toggle('active', j === i);
    s.classList.toggle('done', j < i);
    const icon = s.querySelector('.gen-step-icon');
    if (j < i) {
      icon.innerHTML = '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    } else if (j === i) {
      icon.innerHTML = '<span class="spinner"></span>';
    } else {
      icon.innerHTML = '<span class="circle"></span>';
    }
  });
  /* 更新进度条 */
  const pct = Math.round((i / steps.length) * 100);
  const fill = document.getElementById('gen-progress-bar-fill');
  if (fill) fill.style.width = pct + '%';
  /* 更新状态文字 */
  const statusDetail = document.getElementById('gen-progress-status-detail');
  if (statusDetail && steps[i]) {
    const label = steps[i].querySelector('.gen-step-label');
    if (label) statusDetail.textContent = label.textContent;
  }
  /* 更新计时 */
  if (!state.genStartTime) state.genStartTime = now;
  const elapsed = ((now - state.genStartTime) / 1000).toFixed(1);
  const timeEl = document.getElementById('gen-progress-time');
  if (timeEl) timeEl.textContent = elapsed + 's';
  /* 推进反馈：当前步骤淡入 */
  const cur = steps[i];
  if (cur && window.Ui && Ui.fadeIn) Ui.fadeIn(cur, { duration: Ui.getDur('fast') });
}
function setGenSteps(mode, totalSteps) {
  const L = I18N[state.lang];
  const stepsContainer = document.getElementById('gen-progress-steps');
  if (!stepsContainer) return;
  
  let labels = [];
  if (mode === 'audio') {
    labels = ['准备 TTS 引擎 & 加载音色', '合成旁白（剧情引子）', '合成对话句子', '合并音频 & 生成时间轴'];
  } else {
    labels = ['解析参数 & 构建 Prompt', '调用 LLM 生成对话语料', '验证结构 & 检查内容', '生成词汇表 & 听力题', '保存素材到数据库'];
  }
  
  /* 动态生成步骤 */
  stepsContainer.innerHTML = labels.map((label, i) => `
    <div class="gen-progress-step" data-step="${i}">
      <span class="gen-step-icon"></span>
      <span class="gen-step-label">${label}</span>
      <span class="gen-step-time"></span>
    </div>
  `).join('');
  
  /* 更新标题 */
  const title = document.getElementById('gen-progress-title');
  if (title) title.textContent = mode === 'audio' ? '语音合成' : '素材生成';
  
  /* 更新状态 */
  const statusText = document.getElementById('gen-progress-status-text');
  if (statusText) statusText.textContent = 'Running';
}
/* ================= 素材命名（结构化主名称 + 参数条） =================
   主名称 = {领域} · {形态} · {主题}；参数条 = 词汇 L{N} · 句式 L{N} · {时长}。
   名称语言由生成时 locale 决定（中文语境中文名，英文语境英文名），不随界面切换。
   主题优先取 LLM 生成的 llm_title，不合格回退规则提取；重名追加 (1)/(2)。 */
function localeOf(ctx) {
  return /[\u4e00-\u9fff]/.test(String(ctx || '')) ? 'zh' : 'en';
}
function formatLabel(fmt, locale) {
  const f = String(fmt || 'dialogue').toLowerCase();
  if (locale === 'zh') return f === 'solo' ? '单人讲解' : (f === 'discussion' ? '多人讨论' : '双人对话');
  return f === 'solo' ? 'Solo' : (f === 'discussion' ? 'Discussion' : 'Dialogue');
}
function minutesOf(lengthSec) {
  const sec = parseFloat(String(lengthSec || '').replace(/[^0-9.]/g, '')) || 0;
  if (sec <= 0) return 0;
  return Math.round(sec / 60);
}
function parseSec(lengthStr) {
  /* "5min" → 300, "300s" → 300, "300" → 300 */
  const s = String(lengthStr || '').trim().toLowerCase();
  const num = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!num) return 0;
  if (s.includes('min')) return Math.round(num * 60);
  return Math.round(num);
}
function paramsStr(m, locale, mobile) {
  const diff = parseInt(String(m.difficulty || '').replace(/\D/g, ''), 10) || 3;
  const dep = parseInt(String(m.depth != null ? m.depth : 3), 10) || 3;
  const min = minutesOf(m.length);
  if (mobile) return 'L' + diff + ' · ' + min + 'min';
  if (locale === 'zh') return '词汇 L' + diff + ' · 句式 L' + dep + ' · ' + min + ' 分钟';
  return 'Vocab L' + diff + ' · Syntax L' + dep + ' · ' + min + ' min';
}
/* 规则提取主题（LLM 不可用/不合格时的兜底）：去标点、压空白、取 ≤20 字。 */
function extractTopicFallback(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/[\s\-_"'“”‘’,.。，、:：;；!？?!]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 20) t = t.slice(0, 20).replace(/[\s\-_"'“”‘’,.。，、:：;；]+$/, '');
  return t || (localeOf(raw) === 'zh' ? '场景对话' : 'Scene Dialogue');
}
/* LLM 主题校验：非空、长度、语言匹配（中文语境须中文标题）。 */
function validateLlmTitle(t, locale) {
  const s = String(t || '').trim();
  if (!s) return null;
  if (locale === 'zh' && !/[\u4e00-\u9fff]/.test(s)) return null;
  if (locale === 'zh' && s.length > 20) return null;
  if (locale === 'en' && s.length > 30) return null;
  return s;
}
/* 拼装主名称：领域 · 形态 · 主题（主题不与领域重复）。 */
function buildMainTitle(meta, locale) {
  let domain = String(meta.domainLabel || meta.domain || '').trim();
  if (!domain) domain = locale === 'zh' ? '通用' : 'General';
  let topic = validateLlmTitle(meta.llm_title, locale) || extractTopicFallback(meta.context || meta.topic || '');
  /* 主题开头若与领域重复则去掉重复前缀（避免「汽车电子 · 汽车电子底盘」） */
  const dl = String(domain).toLowerCase();
  const tl = String(topic).toLowerCase();
  if (dl && tl.startsWith(dl)) topic = String(topic).slice(domain.length).replace(/^[\s·\-]+/, '') || topic;
  return domain + ' · ' + formatLabel(meta.format, locale) + ' · ' + topic;
}
/* 重名去重：标题(1)、标题(2)… */
function dedupeTitle(t) {
  const low = String(t).toLowerCase();
  const taken = new Set(state.library.map(m => String(m.meta && m.meta.title || '').toLowerCase()));
  if (!taken.has(low)) return t;
  let n = 1;
  while (taken.has((t + '(' + n + ')').toLowerCase())) n++;
  return t + '(' + n + ')';
}
function runGenerate(params, replaceId) {
  if (state.generating || state.synthesizing) return;
  params = params || collectParams();
  if (!params) return;   /* collectParams already toasted the reason */
  if (!params.context || !String(params.context).trim()) { showToast(I18N[state.lang]['gen.contextRequired'] || 'Please enter a scene context first', 'warn'); return; }
  closeGenPanel();
  closeRefineModal();
  state.generating = true;
  setSynthBanner();   /* disable every banner action while the pipeline runs */
  $('gen-progress-box').classList.remove('hidden');
  $('transcript-body').classList.add('hidden');
  setPhases(0, 0);
  setGenSteps('corpus');
  const _tp = String(params.topic || params.context || '');
  $('gen-topic-label').textContent = I18N[state.lang]['gen.corpusLabel'] + (_tp.length > 48 ? _tp.slice(0, 48) + '…' : _tp);
  const wn = $('gen-waiting-note'); if (wn) wn.textContent = I18N[state.lang]['gen.waiting'] || '';
  state.genNavGuard = { navigated: false };              /* set when the user opens another material mid-generation — completion must not hijack their focus */
  const steps = document.querySelectorAll('#gen-progress-steps .gen-progress-step');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    const llmDbg = llmMockOn() && !ttsMockOn();
    const ttsTake = ttsMockOn();
    try {
      if (llmDbg) {
        /* LLM link debugging: show the intermediate steps, then call the real
           LLM below. No key → the backend reports the real failure. */
        showLlmTrace(true);
        genPaint(steps, 0);
        const dbg = { topic: params.topic || params.context, domain: params.domainLabel || params.domain, format: params.format, roles: params.roles || (params.roleSelection || {}).candidates || [], context: params.context, difficulty: 'Level ' + params.difficulty, length: params.length, depth: (params.advanced || {}).depth || 3 };
        appendLlmTrace('Assembling request parameters — ' + JSON.stringify(dbg), 'tr-ok');
        const lc = params.llm_config || {};
        appendLlmTrace('Request body — { topic, domain, format, roles, context, difficulty, length, llm_config: { provider:' + (lc.provider || '?') + ', model:' + (lc.model || '?') + ', base_url:' + (lc.base_url || '?') + ', api_key:' + (lc.api_key ? '•••' : 'not set') + ', temperature:' + (lc.temperature ?? 0.7) + ' } }');
        appendLlmTrace('Sending request to LLM…');
        await sleep(260);
        genPaint(steps, 1);
      } else if (ttsTake) {
        genPaint(steps, 0);
        showLlmTrace(true);
        appendLlmTrace('Corpus taken over by TTS Mock — dataset: ' + (testDataKey() || 'topic-matched'), 'tr-ok');
        appendLlmTrace('Importing dataset corpus to the material library…');
        await sleep(260);
        genPaint(steps, 1);
      } else {
        genPaint(steps, 0);            /* corpus step stays active while the LLM generates */
      }
      const art = await (replaceId && !mockMode() ? API.regenerateMaterial(replaceId, params) : API.generate(params, replaceId));
      if (llmDbg) {
        appendLlmTrace('LLM responded — ' + art.dialogue.length + ' segments · ' + art.vocabulary.length + ' vocab items · ' + art.listening_questions.length + ' questions', 'tr-ok');
        appendLlmTrace('Structure validated — dialogue / vocabulary / questions / patterns', 'tr-ok');
        appendLlmTrace('Material saved → ' + art.id, 'tr-ok');
      } else if (ttsTake) {
        appendLlmTrace('Dataset corpus imported → ' + art.id + ' · synthesize audio to listen', 'tr-ok');
      }
      steps.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
      art.meta.generated = true;
      setPhases(1);
      await sleep(260);
      state.generated = art;
      art.meta.audioReady = false;                      /* corpus only — TTS is a separate step */
      art.meta.saved = false;                           /* draft until Confirm & Save */
      if (replaceId) art.id = replaceId;                /* regenerate in place */
      /* 默认命名（结构化主名称）：领域 · 形态 · 主题。
         主题优先用 LLM 生成的 llm_title（带校验），不合格回退规则提取；
         refine 保留原素材名（用户可能已重命名）。 */
      if (replaceId) {
        const old = state.library.find(m => m.id === replaceId);
        if (old && old.meta && old.meta.title) art.meta.title = old.meta.title;
        if (old && old.meta && old.meta.locale) art.meta.locale = old.meta.locale;
      } else {
        const locale = localeOf(art.meta.context || params.context || '');
        art.meta.locale = locale;
        if (art.meta.llm_title == null && art.title) art.meta.llm_title = art.title;   /* LLM 链路透传兜底 */
        const nt = dedupeTitle(buildMainTitle(art.meta, locale));
        if (nt !== art.meta.title) {
          art.meta.title = nt;
          API.patchMaterial(art.id, { title: nt, meta: { locale: locale } }).catch(() => {});
        }
      }
      const idx = state.library.findIndex(m => m.id === art.id);
      if (idx >= 0) state.library[idx] = art; else state.library.unshift(art);
      $('gen-progress-box').classList.add('hidden');
      $('transcript-body').classList.remove('hidden');
      const switchedAway = !!(state.genNavGuard && state.genNavGuard.navigated && state.current && state.current.id !== art.id);
      state.genNavGuard = null;
      if (switchedAway) {
        renderLibrary();                                 /* refresh list so the new material appears; keep the user's current view */
        showToast((replaceId ? 'Regenerated — ' : 'Corpus generated — ') + art.meta.title + ' · it is now in the library');
      } else {
        showToast((replaceId ? 'Regenerated — ' : 'Corpus generated — ') + art.meta.title + ' · synthesize audio to listen');
        playArtifact(art);                               /* select in library + render material (no autoplay) */
      }
    } catch (err) {
      if (llmDbg) {
        /* Real unconnected result: show the actual error the LLM link returned. */
        appendLlmTrace('LLM call failed — ' + (err && err.message || err), 'tr-err');
        appendLlmTrace('No corpus produced (real failure reported)', 'tr-err');
      } else if (ttsTake) {
        /* Corpus take-over failed (e.g. backend missing the import endpoint). */
        appendLlmTrace('Corpus import failed — ' + (err && err.message || err), 'tr-err');
        appendLlmTrace('No material saved (backend /api/v1/materials/import unavailable)', 'tr-err');
      }
      $('gen-progress-box').classList.add('hidden');
      $('transcript-body').classList.remove('hidden');
      const offline = !mockMode() && /Failed to fetch|NetworkError|Load failed|ERR_/i.test(String(err && err.message || err));
      showToast(offline
        ? 'Cannot reach backend at ' + CONFIG.apiBase + ' — start FastAPI (uvicorn backend.main:app --reload) or enable Test Data in Developer settings'
        : 'Generation failed: ' + (err && err.message || err), 'error');
    } finally {
      state.generating = false;
      /* Re-enable every banner action now that the pipeline is idle. Without
         this the buttons stay disabled from the task-phase setSynthBanner()
         (the last render happened while generating was still true). */
      setSynthBanner();
    }
  })();
}
function paramsFromArt(art) {
  const m = art.meta;
  const segActive = id => { const el = document.getElementById(id); return el ? el.querySelector('.seg-item.active') : null; };
  const depthEl = segActive('refine-depth');
  const dirEl = document.querySelector('#refine-dir .seg-item.active');
  const roles = m.roles || {};
  const fmt = m.format || 'discussion';
  let structure = {};
  if (fmt === 'solo') {
    structure.roles = { speaker: roles.speaker || ((m.speakers || [])[0] || {}).role || '' };
  } else if (fmt === 'dialogue') {
    const sp = (m.speakers || []).map(x => x.role).filter(Boolean);
    structure.roles = { a: roles.a || sp[0] || '', b: roles.b || sp[1] || '' };
  } else {
    const sp = (m.speakers || []).map(x => x.role).filter(Boolean);
    structure.roleSelection = {
      candidates: Array.isArray(roles.candidates) ? roles.candidates : sp
    };
  }
  return {
    domain: m.domain, domainLabel: m.domain,
    format: fmt, context: m.context || m.scenario || '',
    ...structure,
    difficulty: parseInt(String(m.difficulty).replace(/\D/g, ''), 10) || 3,
    length: String(parseSec(m.length) || 120),
    llm: llmDisplayLabel(), tts: normalizeTTSProvider((readStoredCfg().tts || {}).provider) || 'edge-tts', voice: m.voice || 'en-US-GuyNeural + en-US-JennyNeural',
    llm_config: buildLLMConfig(),
    test_mode: buildTestMode(),
    advanced: {
      depth: depthEl ? +depthEl.dataset.syntax : (m.depth || 3),
      injections: $('refine-inject') ? $('refine-inject').value.trim() : (m.injections || ''),
      directions: dirEl && dirEl.dataset.dir !== 'rephrase' ? [dirEl.dataset.dir] : []
    }
  };
}
function updateRefineLabels() {
  const i18n = I18N[state.lang] || {};
  const wpm = state.lang === 'zh' ? '· 145 词/分' : '· 145 wpm';
  const seg = document.querySelector('#refine-len .seg-item.active');
  const ln = seg.dataset.length;
  $('refine-len-hint-name').textContent = seg.textContent.trim();
  const lenDesc = (i18n['gen.lenHints'] && i18n['gen.lenHints'][ln]) || CONFIG.lenHints[ln] || '';
  $('refine-len-hint').textContent = lenDesc ? '（' + lenDesc + ' ' + wpm + '）' : '';
  const lv = +document.querySelector('#refine-diff .seg-item.active').dataset.vocab;
  const vNames = i18n['gen.vocabNames'] || [], vDescs = i18n['gen.vocabDescs'] || [];
  $('refine-diff-hint-name').textContent = vNames[lv] || ('L' + lv);
  $('refine-diff-hint').textContent = vDescs[lv] ? '（' + vDescs[lv] + '）' : '';
  const dp = +document.querySelector('#refine-depth .seg-item.active').dataset.syntax;
  const sNames = i18n['gen.syntaxNames'] || [], sDescs = i18n['gen.syntaxDescs'] || [];
  $('refine-depth-hint-name').textContent = sNames[dp] || ('D' + dp);
  $('refine-depth-hint').textContent = sDescs[dp] ? '（' + sDescs[dp] + '）' : '';
  const dEl = document.querySelector('#refine-dir .seg-item.active');
  const dirKey = { rephrase:'dirRephrase', expand:'dirExpand', narrow:'dirNarrow', 're-angle':'dirAngle' }[dEl.dataset.dir] || 'dirRephrase';
  const dName = (i18n['refine.' + dirKey] || dEl.textContent.trim());
  const dDesc = i18n['refine.' + dirKey + 'Desc'] || '';
  $('refine-dir-hint-name').textContent = dName;
  $('refine-dir-hint').textContent = dDesc ? '（' + dDesc + '）' : '';
}
let adjustPanel = 'text';
function openAdjustModal(tab) {
  const art = state.current;
  if (!art) { showToast('No material selected', 'warn'); return; }
  if (state.playing) pause();          /* opening an edit modal suspends playback */
  adjustPanel = tab === 'voice' ? 'voice' : 'text';
  const lock = state.current;
  if (lock && lock.meta.saved === true) setPhases(3);   /* unlock — show edit progress */
  $('adjust-modal').classList.remove('hidden');
  $('ap-text').classList.toggle('hidden', adjustPanel !== 'text');
  $('ap-voice').classList.toggle('hidden', adjustPanel !== 'voice');
  const L = I18N[state.lang];
  $('adjust-title').textContent = L[adjustPanel === 'voice' ? 'adjust.titleVoice' : 'adjust.titleCorpus'];
  $('adjust-sub').textContent = L[adjustPanel === 'voice' ? 'adjust.subVoice' : 'adjust.subCorpus'];
  const ready = art && art.meta.audioReady === false;
  $('btn-adjust-apply').textContent = L[adjustPanel === 'voice' ? (ready ? 'tts.convert' : 'tts.reconvert') : 'refine.apply'];
  const st = $('tts-status');
  if (st) st.style.display = adjustPanel === 'voice' ? '' : 'none';
  setTimeout(() => { const f = adjustPanel === 'voice' ? $('adj-tts-provider') : $('refine-inject'); if (f) f.focus(); }, 60);
}
function closeAdjustModal() {
  stopAuditions();
  $('adjust-modal').classList.add('hidden');
  const lock = state.current;
  if (lock && lock.meta.saved === true) $('gen-phases').classList.add('hidden');
}
function closeRefineModal() { closeAdjustModal(); }
function closeTTSModal() { closeAdjustModal(); }
function openRefineModal() {
  const art = currentArtifact();
  $('refine-inject').value = art.meta.injections || '';
  const lv = parseInt(String(art.meta.difficulty).replace(/\D/g, ''), 10) || 3;
  const diffItem = document.querySelector('#refine-diff [data-vocab="' + lv + '"]');
  if (diffItem) setSeg($('refine-diff'), diffItem); else setSeg($('refine-diff'), $('refine-diff').querySelector('.seg-item'));
  const lenSeg = $('refine-len');
  const lenTarget = document.querySelector('#refine-len [data-length="' + (parseSec(art.meta.length) || 300) + '"]');
  if (lenTarget) setSeg(lenSeg, lenTarget); else setSeg(lenSeg, lenSeg.querySelector('.seg-item'));
  const depthItem = document.querySelector('#refine-depth [data-syntax="' + (art.meta.depth || 3) + '"]');
  if (depthItem) setSeg($('refine-depth'), depthItem); else setSeg($('refine-depth'), $('refine-depth').querySelector('.seg-item'));
  setSeg($('refine-dir'), document.querySelector('#refine-dir [data-dir="rephrase"]'));
  updateRefineLabels();
  openAdjustModal('text');
}
function refineGenerate() {
  const art = currentArtifact();
  if (!art) return;
  if (state.synthesizing) { showToast('Audio synthesis in progress — wait for it to finish', 'warn'); return; }
  const params = paramsFromArt(art);
  params.difficulty = +document.querySelector('#refine-diff .seg-item.active').dataset.vocab;
  const lenItem = document.querySelector('#refine-len .seg-item.active') || document.querySelector('#refine-len .seg-item');
  params.length = lenItem.dataset.length;
  const depthItem = document.querySelector('#refine-depth .seg-item.active') || document.querySelector('#refine-depth .seg-item');
  params.advanced.depth = +depthItem.dataset.syntax;
  params.advanced.injections = $('refine-inject').value.trim();
  const dirEl = document.querySelector('#refine-dir .seg-item.active');
  params.advanced.directions = dirEl && dirEl.dataset.dir !== 'rephrase' ? [dirEl.dataset.dir] : [];
  runGenerate(params, art.id);
}
const LLM_PRESETS = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  moonshot: { base: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  ark: { base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-2-1-pro-260628' },
  openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o' },
  qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  ollama: { base: 'http://localhost:11434/v1', model: 'llama3.1' }
};
const LLM_PRESET_LEGACY = {
  'DeepSeek (OpenAI-compatible)': 'deepseek', 'OpenAI': 'openai', 'Qwen': 'qwen', 'Ollama (Local)': 'ollama'
};
/* Wire the engine-status badge: hover shows the self-check summary, click
   forces a fresh re-check. Runs after $ and LLM_PRESETS are defined. */
(function initEngineBadge() {
  const es = $('engine-status');
  if (!es) return;
  const tip = $('eng-tip');
  es.addEventListener('mouseenter', e => {
    if (!tip || !tip.textContent) return;
    tip.classList.remove('hidden');
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 380) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
  es.addEventListener('mousemove', e => {
    if (!tip || tip.classList.contains('hidden')) return;
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 380) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
  es.addEventListener('mouseleave', () => { if (tip) tip.classList.add('hidden'); });
  es.addEventListener('click', () => selfCheck(true));
  setTimeout(() => selfCheck(false), 2500);
})();
function splitVoice(voice) {
  return String(voice || '').split('+').map(s => s.trim()).filter(Boolean);
}
function openTTSModal() {
  const art = currentArtifact();
  if (!art) { showToast('No material selected', 'warn'); return; }
  $('tts-material-title').textContent = art.meta.title;
  let st = {};
  try { st = JSON.parse(localStorage.getItem('telg-settings') || 'null') || {}; } catch (e) {}
  const tts = st.tts || {};
  const prov = normalizeTTSProvider(tts.provider || art.meta.tts_provider || 'edge-tts');
  $('adj-tts-provider').value = prov;
  $('adj-tts-rate').value = tts.speechRate || '1';
  $('adj-tts-style').value = art.meta.ttsStyle || tts.style || 'neutral';
  const cur = splitVoice(art.meta.voice);
  const roles = dialogueRoleNames(art);
  const saved = art.meta.voiceRoles;
  const hasCustom = Array.isArray(saved) && saved.some(r => r && r.name && !/^Speaker [A-Z]$/.test(String(r.name).trim()));
  const hint = $('adj-single-hint');
  if (hint) {
    hint.style.display = roles.length === 1 ? '' : 'none';
    hint.textContent = I18N[state.lang]['tts.singleHint'];
  }
  loadTTSVoices(prov).then(() => {
    if (roles.length && !hasCustom) {
      const defV = prov === 'kokoro' ? 'af_bella' : 'en-US-GuyNeural';
      const pool = ttsVoicePool(prov);
      const vs = cur.length ? cur : [defV];
      renderAdjustVoiceRoles(roles.map((r, i) => {
        let v = vs[i % vs.length];
        if (!pool.some(o => (typeof o === 'string' ? o : o.id) === v)) v = defV;
        return { name: r.role ? r.name + ' · ' + r.role : r.name, voice: v };
      }));
    } else {
      /* Saved voiceRoles carry name+voice and must win over the raw voice
         string list — rebuilding from cur alone collapses names back to
         "Speaker A/B". */
      const pre = (saved && saved.length) ? saved : (cur.length ? cur : null);
      renderAdjustVoiceRoles(sanitizeRolesForProvider(pre, prov));
    }
  });
  const ready = art.meta.audioReady === false;
  $('tts-status').textContent = I18N[state.lang][ready ? 'tts.statusReady' : 'tts.statusExist'];
  openAdjustModal('voice');
}
/* Extract unique speaker roles from the corpus dialogue (LLM-recommended
   names/roles) so the voice panel can pre-fill one row per role. */
function dialogueRoleNames(art) {
  const sps = (art.meta && Array.isArray(art.meta.speakers)) ? art.meta.speakers : [];
  const seen = [];
  (art.dialogue || []).forEach(d => {
    const raw = String(d.speakerId || d.speaker || '').trim();
    if (!raw) return;
    let name = raw;
    let role = String(d.role || '').trim();
    const m = sps.find(s => s && s.id === raw);
    if (m && m.role) {
      if (!role) role = m.role;
      name = m.role;
    }
    if (!seen.some(x => x.name === name)) seen.push({ name: name, role: role });
  });
  return seen;
}
function renderAdjustVoiceRoles(voices) {
  const box = $('adj-voice-roles'); if (!box) return;
  const p = adjTTSProvider();
  const list = sanitizeRolesForProvider((voices && voices.length) ? voices : null, p);
  box.innerHTML = list.map((r, i) => {
    if (typeof r === 'string') r = { name: 'Speaker ' + String.fromCharCode(65 + i), voice: r };
    return roleRowHTML(r, p);
  }).join('');
}
function currentAdjustVoiceRoles() {
  const box = $('adj-voice-roles'); if (!box) return [];
  return Array.from(box.querySelectorAll('.voice-role-row')).map(row => ({
    name: (row.querySelector('.role-name') || { value: '' }).value.trim(),
    voice: row.querySelector('select') ? row.querySelector('select').value : ''
  }));
}
function addAdjustRole() {
  const cur = currentAdjustVoiceRoles();
  const used = new Set(cur.map(x => x.voice));
  const pool = ttsVoicePool(adjTTSProvider());
  const found = pool.find(o => !used.has(typeof o === 'string' ? o : o.id));
  const next = typeof found === 'object' ? found.id : (found || 'af_bella');
  renderAdjustVoiceRoles(cur.concat([{ name: 'Speaker ' + String.fromCharCode(65 + cur.length), voice: next }]));
}
function delAdjustRole(btn) {
  const row = btn.closest('.voice-role-row'); if (!row) return;
  if (currentAdjustVoiceRoles().length <= 1) return;
  row.remove();
}
async function auditionAdjustRole(btn) {
  const row = btn.closest('.voice-role-row'); if (!row) return;
  const voice = row.querySelector('select') ? row.querySelector('select').value : '';
  const res = $('adj-tts-result'), aud = $('adj-audio');
  if (!res) return;
  res.className = 'test-output'; res.textContent = '…';
  document.querySelectorAll('#adj-voice-roles .btn-role-test.played').forEach(b => b.classList.remove('played'));
  btn.classList.add('loading');
  if (aud) { aud.pause(); aud.onended = null; aud.removeAttribute('src'); }
  const txt = $('adj-voice-text') ? $('adj-voice-text').value.trim() : '';
  try {
    const r = await API.testTTS({ provider: $('adj-tts-provider').value, voice, speech_rate: parseFloat($('adj-tts-rate').value), style: $('adj-tts-style').value, text: txt || undefined });
    if (r.ok) {
      res.className = 'test-output ok';
      res.textContent = I18N[state.lang]['settings.tts.ok'] + ' · ' + ttsVoiceLabel(voice, adjTTSProvider()) + (r.audio_url ? '' : ' · Mock');
      if (r.audio_url && aud) {
        aud.src = r.audio_url;
        aud.onended = () => btn.classList.remove('played');
        aud.play().then(() => btn.classList.add('played')).catch(() => {});
      }
      /* Pre-synthesize the other roles of this panel in the background. */
      prewarmTTS($('adj-tts-provider').value, txt, parseFloat($('adj-tts-rate').value), voice, '#adj-voice-roles').catch(() => {});
      prewarmAuditions($('adj-tts-provider').value, parseFloat($('adj-tts-rate').value), $('adj-tts-style').value, txt, voice, '#adj-voice-roles');
    } else { res.className = 'test-output err'; res.textContent = ttsFriendlyError(r.error_class, r.error); }
  } catch (e) { res.className = 'test-output err'; res.textContent = ttsFriendlyError('other', e.message); }
  btn.classList.remove('loading');
}
function applyTTS() {
  const art = currentArtifact();
  if (!art) return;
  if (state.synthesizing) { showToast('Audio synthesis in progress — wait for it to finish', 'warn'); return; }
  const roles = currentAdjustVoiceRoles();
  const voices = roles.map(r => r.voice).filter(Boolean);
  const prov = adjTTSProvider();
  if (!voices.length) voices.push(prov === 'kokoro' ? 'af_bella' : 'en-US-GuyNeural');
  art.meta.voice = voices.join(' + ');
  art.meta.voiceRoles = roles;
  art.meta.ttsStyle = $('adj-tts-style').value;
  art.meta.tts_provider = prov;
  /* 切换 TTS 引擎时，旁白音色也要跟着切换到对应引擎的默认女声 */
  const defaultNarr = prov === 'kokoro' ? 'af_heart' : 'en-US-JennyNeural';
  /* 如果当前旁白音色不在新引擎的音色列表里，就用新引擎的默认女声 */
  const pool = ttsVoicePool(prov);
  const narrInPool = pool.some(o => (typeof o === 'string' ? o : o.id) === (state.narrVoice || defaultNarr));
  art.meta.narrVoice = narrInPool ? (state.narrVoice || defaultNarr) : defaultNarr;
  try {
    const s = JSON.parse(localStorage.getItem('telg-settings') || 'null') || {};
    s.tts = s.tts || {};
    s.tts.voice = art.meta.voice; s.tts.speechRate = $('adj-tts-rate').value; s.tts.style = art.meta.ttsStyle;
    s.tts.provider = prov;
    s.narrVoice = art.meta.narrVoice;
    localStorage.setItem('telg-settings', JSON.stringify(s));
  } catch (e) {}
  art.meta.audioReady = false;          /* force (re-)conversion */
  art.meta.saved = false;               /* re-synthesis → republish */
  closeTTSModal();
  renderMaterial();
  synthesizeAudio();
}
function synthesizeAudio() {
  const art = currentArtifact();
  if (!art || art.meta.audioReady !== false || state.synthesizing) return;
  state.synthesizing = true;
  $('gen-progress-box').classList.remove('hidden');
  $('transcript-body').classList.add('hidden');
  setPhases(1, 1);
  setGenSteps('audio');
  $('gen-topic-label').textContent = I18N[state.lang]['gen.audioLabel'] + art.meta.title + ' · ' + art.meta.voice;
  const wn = $('gen-waiting-note'); if (wn) wn.textContent = I18N[state.lang]['gen.waiting'] || '';
  const steps = document.querySelectorAll('#gen-progress-steps .gen-progress-step');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    try {
      genPaint(steps, 0);            /* TTS step stays active while the backend synthesizes */
      let ttsCfg = {};
      try {
        const t = JSON.parse(localStorage.getItem('telg-settings') || '{}');
        /* 优先使用当前素材的音色（Adjust 面板设置），fallback 到全局设置 */
        let storedVoices = art.meta.voice || (t.tts && t.tts.voice) || (t.tts && t.tts.voices) || '';
        if (Array.isArray(storedVoices)) storedVoices = storedVoices.map(x => (x && x.voice) || x).filter(Boolean).join(' + ');
        ttsCfg = { voices: storedVoices, rate: parseFloat((t.tts && t.tts.speechRate) || 1) || 1,
                   provider: normalizeTTSProvider(art.meta.tts_provider || (t.tts && t.tts.provider) || 'edge-tts'),
                   narrator: state.narrVoice || (t.narrVoice) || 'en-US-JennyNeural' };
      } catch (e) {}
      const r = await API.synthesize(art.id, ttsCfg);
      if (r.audio_url) art.meta.audio_url = r.audio_url;
      if (r.total_duration_ms) art.meta.total_duration_ms = r.total_duration_ms;
      /* Pull the authoritative timeline the backend wrote to the DB (real TTS
         durations + 300ms gaps). Generation-time timestamps are only word-count
         estimates; keeping them here is what made highlight/seek drift. */
      const fresh = await API.getMaterial(art.id).catch(() => null);
      if (fresh && Array.isArray(fresh.dialogue) && fresh.dialogue.length) {
        art.dialogue = fresh.dialogue;
        if (fresh.meta && fresh.meta.audio_url) art.meta.audio_url = fresh.meta.audio_url;
        if (fresh.meta && fresh.meta.total_duration_ms) art.meta.total_duration_ms = fresh.meta.total_duration_ms;
        if (fresh.meta && fresh.meta.narration) art.meta.narration = fresh.meta.narration;
        else if (fresh.meta && !fresh.meta.narration) delete art.meta.narration;
      }
      hideSynthError();
      steps.forEach(s => { s.classList.remove('active'); s.classList.add('done'); });
      art.meta.generated = true;           /* synthesis implies a generation pipeline */
      art.meta.audioReady = true;
      art.meta.saved = false;              /* re-synthesis → republish */
      setPhases(2);
      await sleep(220);
      $('gen-progress-box').classList.add('hidden');
      $('transcript-body').classList.remove('hidden');
      state.synthesizing = false;
      const isCurrent = state.current && state.current.id === art.id;
      if (isCurrent) {
        renderMaterial();
        state.time = 0;
        /* force the <audio> element to drop its cached source: the file at the
           same URL was just replaced by re-synthesis, otherwise play() would
           reuse the stale buffer and the highlight/timeline would drift */
        const pb = document.getElementById('pb-audio');
        if (pb) { pb.dataset.src = ''; pb.removeAttribute('src'); pb.load(); }
        play();
        syncHighlight();
        showToast('Audio ready — playing from sentence 1');
      } else {
        /* the user switched to another material while this one was being
           synthesized — only refresh the library, never touch the current UI */
        renderLibrary();
        showToast('Audio ready — ' + art.meta.title);
      }
    } catch (err) {
      state.synthesizing = false;
      $('gen-progress-box').classList.add('hidden');
      $('transcript-body').classList.remove('hidden');
      const isCurrent = state.current && state.current.id === art.id;
      if (isCurrent) {
        renderMaterial();
        showSynthError(err);
      } else {
        renderLibrary();
        showToast('Synthesis failed for ' + (art.meta.title || art.id) + ' — ' + (err && err.message || err), 'error');
      }
    }
  })();
}
function exportMD(art) {
  if (!art) return;
  const L = [];
  L.push('# ' + art.meta.title, '',
    '> ' + art.meta.domain + ' · ' + art.meta.role + ' · ' + art.meta.scenario,
    '> ' + art.meta.difficulty + ' · ' + fmt(art.meta.total_duration_ms) + ' · ' + art.meta.voice, '',
    '## Technical Background', art.background.technical_background, '',
    '## Technical Principle', art.background.technical_principle, '',
    '## Engineering Scenario', art.background.engineering_scenario, '',
    '## Transcript');
  art.dialogue.forEach(s => L.push('**' + (s.speakerId || s.speaker) + '** (' + (s.start_ms != null && !Number.isNaN(Number(s.start_ms)) ? fmt(s.start_ms) + '–' + fmt(s.end_ms) : 'no timeline yet') + '): ' + s.text_en));
  L.push('', '## Vocabulary');
  art.vocabulary.forEach(v => L.push('- **' + v.en + '** (' + v.symbol + ') ' + v.zh + ' — ' + v.def));
  L.push('', '## Listening Questions');
  art.listening_questions.forEach((qt, i) => {
    L.push((i + 1) + '. ' + qt.q);
    qt.options.forEach((o, oi) => L.push('   ' + String.fromCharCode(65 + oi) + '. ' + o + (oi === quizAnswerIndex(qt) ? ' ✓' : '')));
    const _ai = quizAnswerIndex(qt);
    L.push('   Answer: ' + (_ai >= 0 ? String.fromCharCode(65 + _ai) : '?') + ' — ' + qt.explain);
  });
  L.push('', '## Sentence Patterns');
  art.core_sentence_patterns.forEach(p => L.push('- **' + p.title + '**: ' + p.pattern));
  const blob = new Blob([L.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'Scenear-' + art.meta.title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() + '.md';
  document.body.appendChild(a); a.click(); a.remove();
  showToast('Markdown handout exported');
}
function resetDefaults() {
  state.genScene.context = 'Tire burst stability control';
  renderGenScene();
  applyProfileToGenPanel();
  setSeg($('diff-seg'), document.querySelector('#diff-seg [data-vocab="3"]'));
  setSeg($('len-seg'), document.querySelector('#len-seg [data-length="300"]'));
  setSeg($('depth-seg'), document.querySelector('#depth-seg [data-syntax="3"]'));
  updateDiff(); updateLen(); updateDepth();
  $('adv-vocab').value = 28;
  $('adv-style').selectedIndex = 0;
  $('adv-inject').value = '';
  showToast('Defaults restored');
}
function setSeg(container, item) {
  container.querySelectorAll('.seg-item').forEach(b => b.classList.remove('active'));
  item.classList.add('active');
}
function updateDiff() {
  const lv = +document.querySelector('#diff-seg .seg-item.active').dataset.vocab;
  const i18n = I18N[state.lang] || {};
  const vNames = i18n['gen.vocabNames'] || i18n.vocabNames || [];
  const vDescs = i18n['gen.vocabDescs'] || i18n.vocabDescs || [];
  const name = vNames[lv] || ('L' + lv);
  const desc = vDescs[lv] || (CONFIG.diffHints[lv] || '');
  $('diff-hint-name').textContent = name;
  $('diff-hint').textContent = desc ? '（' + desc + '）' : '';
}
function updateLen() {
  const seg = document.querySelector('#len-seg .seg-item.active');
  const ln = seg.dataset.length;
  const name = seg.textContent.trim();
  const i18n = I18N[state.lang] || {};
  const desc = (i18n['gen.lenHints'] && i18n['gen.lenHints'][ln]) || CONFIG.lenHints[ln] || '';
  const wpm = state.lang === 'zh' ? '· 145 词/分' : '· 145 wpm';
  $('len-hint-name').textContent = name;
  $('len-hint').textContent = desc ? '（' + desc + ' ' + wpm + '）' : '';
}
function updateDepth() {
  const d = +document.querySelector('#depth-seg .seg-item.active').dataset.syntax;
  const i18n = I18N[state.lang] || {};
  const sNames = i18n['gen.syntaxNames'] || i18n.syntaxNames || [];
  const sDescs = i18n['gen.syntaxDescs'] || i18n.syntaxDescs || [];
  const name = sNames[d] || (CONFIG.depthLabels && CONFIG.depthLabels[d]) || ('D' + d);
  const desc = sDescs[d] || '';
  $('depth-label').textContent = name;
  $('depth-hint').textContent = desc ? '（' + desc + '）' : '';
}
function toggleAdvanced() {
  const hidden = $('advanced-panel').classList.toggle('hidden');
  $('advanced-icon').style.transform = hidden ? '' : 'rotate(180deg)';
}

/* ---------------- PLAYER ENGINE ---------------- */
/* A material is playable only when synthesis finished AND an audio file exists.
   Missing audioReady (e.g. legacy seed material) must NOT be treated as playable. */
function isPlayable(art) {
  return !!(art && art.meta && art.meta.audioReady === true && art.meta.audio_url);
}
function toastNeedSynth() { showToast('Synthesize audio first — click Set Voice & Synthesize', 'warn'); }
function playArtifact(art) {
  state.current = art;
  state.time = 0;
  state.narrOnly = false;   /* new material → back to the full timeline */
  hideSynthError();   /* a new material must not keep the previous failure banner */
  pause();
  renderMaterial();
}
function loadMaterial(id) {
  /* Local-first: play instantly from the in-memory library, then refresh in
     the background so the list and the detail stay consistent. */
  if (window.innerWidth <= 720) toggleSidebar(false);   /* close the drawer after picking */
  if (state.genNavGuard) state.genNavGuard.navigated = true;   /* user-initiated navigation */
  if (state.generating || state.synthesizing) {
    showToast(I18N[state.lang]['gen.switchHint'] || 'A material is being generated — it will appear in the library when ready.', 'info');
  }
  /* Auto-enter the owning playlist so continuous playback (queuePlay) works
     right after clicking a material — otherwise the queue has no context. */
  if (!state.activePlaylist && state.playlists.length) {
    const owner = state.playlists.find(p => p.materialIds.includes(id));
    if (owner) state.activePlaylist = owner.id;
  }
  const local = state.library.find(m => m.id === id);
  if (local) playArtifact(local);
  API.getMaterial(id).then(m => {
    const i = state.library.findIndex(x => x.id === id);
    if (i >= 0) state.library[i] = m; else state.library.unshift(m);
    if (state.current && state.current.id === id) { playArtifact(m); renderLibrary(); }
  }).catch(e => { if (!local) showToast('Load failed: ' + e.message, 'error'); });
}
function currentSegIndex() {
  const art = currentArtifact();
  let idx = -1;
  for (let i = 0; i < art.dialogue.length; i++) {
    const st = Number(art.dialogue[i].start_ms);
    if (art.dialogue[i].start_ms != null && !Number.isNaN(st) && state.time >= st) idx = i;
  }
  return idx;
}
function tick() {
  /* Real-audio mode: poll the <audio> element at 100ms so sentence highlight
     tracks the voice tightly (timeupdate alone fires only ~4Hz and visibly
     lags the spoken word). This timer also drives the mock/simulated path. */
  if (!mockMode()) {
    const art = currentArtifact();
    const audio = $('pb-audio');
    if (audio && audio.currentTime > 0) {
      state.time = Math.min(audio.currentTime * 1000, art.meta.total_duration_ms || 0);
    }
    syncHighlight();
    renderPlayerBar();
    return;
  }
  const art = currentArtifact(), total = art.meta.total_duration_ms;
  const dt = 100 * CONFIG.speeds[state.speedIdx];
  if (state.loop) {
    const idx = currentSegIndex();
    if (idx >= 0 && state.time + dt >= art.dialogue[idx].end_ms) state.time = art.dialogue[idx].start_ms;
    else state.time = Math.min(state.time + dt, total);
  } else {
    state.time = Math.min(state.time + dt, total);
  }
  /* 旁白单独播放（mock 路径）：旁白段播完即停，不接续正文 */
  if (state.narrOnly) {
    const nEnd = narrEndMs(art);
    if (nEnd > 0 && state.time >= nEnd) { state.narrOnly = false; state.time = nEnd; pause(); return; }
  }
  if (state.time >= total) { state.time = total; pause(); }
  syncHighlight();
  renderPlayerBar();
}
function startTimer() { if (!timer) timer = setInterval(tick, 100); }
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function setPlayIcon(playing) {
  $('pb-play-ic').style.opacity = playing ? 0 : 1;
  $('pb-pause-ic').style.opacity = playing ? 1 : 0;
}
(function initPbAudio() {
  const audio = document.getElementById('pb-audio');
  if (!audio) return;
  let lastT = null;
  audio.addEventListener('timeupdate', () => {
    /* today's listening stats: accumulate real playback seconds */
    if (state.playing && lastT != null && audio.currentTime > lastT && audio.currentTime - lastT < 2) {
      state.stats.playSec += audio.currentTime - lastT;
      if (state.stats.playSec > 86400) state.stats.playSec = 86400;
      saveStats();
    }
    lastT = state.playing ? audio.currentTime : null;
    if (!state.playing) return;
    const art = currentArtifact();
    state.time = Math.min(audio.currentTime * 1000, art.meta.total_duration_ms || 0);
    /* 旁白单独播放：旁白段播完即停，不接续正文 */
    if (state.narrOnly) {
      const nEnd = narrEndMs(art);
      if (nEnd > 0 && state.time >= nEnd) {
        state.narrOnly = false;
        state.time = nEnd;
        pause();
        return;
      }
    }
    if (state.loop) {
      const idx = currentSegIndex();
      if (idx >= 0 && state.time >= (art.dialogue[idx] ? art.dialogue[idx].end_ms : 0)) {
        audio.currentTime = (art.dialogue[idx].start_ms) / 1000;
        return;
      }
    }
    if (audio.ended || state.time >= (art.meta.total_duration_ms || 0)) { state.time = art.meta.total_duration_ms || 0; pause(); }
    syncHighlight();
    renderPlayerBar();
  });
  audio.addEventListener('ended', () => {
    if (mockMode()) return;
    const art = currentArtifact();
    state.time = art.meta.total_duration_ms || 0;
    pause();
    renderPlayerBar();   /* reset the play icon and progress to the end state */
    /* playlist queue: auto-advance to the next material in the active playlist */
    if (state.queuePlay && state.activePlaylist) {
      const pl = state.activePlaylist === '__all__'
        ? { materialIds: state.library.map(m => m.id) }
        : state.playlists.find(x => x.id === state.activePlaylist);
      if (pl && pl.materialIds.length > 1) {
        const i = pl.materialIds.indexOf(art.id);
        /* skip materials that are not synthesized yet — only playable ones */
        let nextId = null; let skipped = false;
        for (let step = 1; step <= pl.materialIds.length; step++) {
          const cand = pl.materialIds[(i + step) % pl.materialIds.length];
          const m = state.library.find(x => x.id === cand);
          if (m && isPlayable(m)) { nextId = cand; break; }
          if (m && !isPlayable(m)) skipped = true;
        }
        if (nextId && nextId !== art.id) {
          const next = state.library.find(m => m.id === nextId);
          const go = (m) => { playArtifact(m); play(); };
          if (next) go(next);
          else API.getMaterial(nextId).then(m => { const k = state.library.findIndex(x => x.id === nextId); if (k >= 0) state.library[k] = m; else state.library.unshift(m); go(m); }).catch(() => {});
        } else if (skipped) {
          showToast(I18N[state.lang]['pl.skipUnsynth'] || 'Skipped a material without audio', 'info');
        }
      }
    }
  });
})();
function play() {
  const art = currentArtifact();
  if (!art || art.meta.audioReady !== true) { showToast('Audio not synthesized yet — click Synthesize Audio', 'warn'); return; }
  if (state.time >= art.meta.total_duration_ms) state.time = 0;
  /* 自动旁白开关（关）：从头播放时跳过旁白段直接播正文；
     总时长/进度条仍含旁白时段。旁白单独播放（narrOnly）不受影响。 */
  if (!state.narrOnly && state.time === 0 && !state.autoNarr && hasNarration(art)) {
    const nEnd = narrEndMs(art);
    if (nEnd > 0 && nEnd < (art.meta.total_duration_ms || 0)) state.time = nEnd;
  }
  state.playing = true;
  setPlayIcon(true);
  /* Playback always uses the real <audio> element — Test Data mode only swaps
     the corpus generator, never the audio path. */
  const audio = $('pb-audio');
  const url = art.meta.audio_url;
  if (!url) { state.playing = false; setPlayIcon(false); showToast('No audio file for this material', 'warn'); return; }
  if (audio.dataset.src !== url) { const au = absUrl(url); audio.dataset.src = au; audio.src = au; audio.load(); }
  audio.playbackRate = CONFIG.speeds[state.speedIdx];
  audio.currentTime = state.time / 1000;
  audio.play().then(() => {}).catch(() => { state.playing = false; setPlayIcon(false); });
  syncHighlight();
}
function pause() {
  state.playing = false;
  setPlayIcon(false);
  try { $('pb-audio').pause(); } catch (e) {}
  stopTimer();
  syncHighlight();
}
function togglePlay() { state.playing ? pause() : play(); }
function seek(ms, autoplay) {
  const art = currentArtifact();
  state.narrOnly = false;   /* manual seek leaves narration-only mode */
  state.time = Math.max(0, Math.min(ms, art.meta.total_duration_ms));
  try { $('pb-audio').currentTime = state.time / 1000; } catch (e) {}
  syncHighlight();
  renderPlayerBar();
  if (autoplay && !state.playing) play();
}
function seekSentence(idx, autoplay) {
  const art = currentArtifact();
  if (!art.dialogue[idx]) return;
  const st = Number(art.dialogue[idx].start_ms);
  if (art.dialogue[idx].start_ms == null || Number.isNaN(st)) {
    /* no real timeline yet (not synthesized) — nothing to seek to */
    return;
  }
  seek(st, autoplay !== false);
}
function nextSentence() {
  const art = currentArtifact(), idx = currentSegIndex();
  seekSentence(Math.min(idx + 1, art.dialogue.length - 1));
}
function prevSentence() {
  const art = currentArtifact(), idx = currentSegIndex();
  if (idx > 0) {
    const cur = art.dialogue[idx];
    if (state.time > cur.start_ms + 300) seekSentence(idx);
    else seekSentence(idx - 1);
  } else if (idx === 0) {
    const cur = art.dialogue[0];
    if (state.time > cur.start_ms + 300) seekSentence(0);
    else if (hasNarration(art)) { seek(0, false); state.narrOnly = true; }   /* 句首再退 → 旁白段 */
    else seekSentence(0);
  } else {
    /* idx === -1（位于旁白段）：回到旁白段起点 */
    if (hasNarration(art)) { seek(0, false); state.narrOnly = true; }
    else seekSentence(0);
  }
}
function syncHighlight() {
  const art = currentArtifact(), idx = currentSegIndex();
  document.querySelectorAll('#transcript-list .trow').forEach((row, i) => {
    /* keep the focused sentence highlighted even when paused; only the status changes */
    row.classList.toggle('active', i === idx);
    const flag = row.querySelector('[data-flag]');
    if (flag) {
      if (i === idx) {
        flag.style.display = '';
        flag.className = 'playing-flag' + (state.playing ? '' : ' paused');
        flag.innerHTML = state.playing ? '<span class="dot"></span>Playing' : '<span class="dot warn"></span>Paused';
      } else {
        flag.style.display = 'none';
      }
    }
    const sloopBtn = row.querySelector('[data-act="sloop"]');
    if (sloopBtn) sloopBtn.classList.toggle('active', state.loop && i === idx);
  });
  const active = document.querySelector('#transcript-list .trow.active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function renderPlayerBar() {
  syncDetailBtn();
  const art = state.current;
  const ctrl = ['btn-pb-play','btn-pb-prev','btn-pb-back10','btn-pb-fwd10','btn-pb-next','btn-pb-bookmark','btn-pb-loop','btn-pb-subs'];
  const setCtrl = disabled => ctrl.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = disabled; el.classList.toggle('disabled', disabled); }
  });
  if (!art) {
    $('pb-title').textContent = '—'; $('pb-meta').textContent = '';
    $('pb-current').textContent = '00:00'; $('pb-total').textContent = '00:00';
    $('pb-fill').style.width = '0%'; $('pb-thumb').style.left = '0%';
    setCtrl(true);
    return;
  }
  const total = art.meta.total_duration_ms;
  $('pb-title').textContent = art.meta.title;
  $('pb-meta').textContent = art.meta.domain + ' · ' + art.meta.role;
  $('pb-current').textContent = fmt(state.time);
  $('pb-total').textContent = fmt(total);
  const pct = total ? (state.time / total * 100) : 0;
  $('pb-fill').style.width = pct + '%';
  $('pb-thumb').style.left = pct + '%';
  /* 旁白/正文分界标记：完整时间轴上标出旁白段结束点 */
  const nEnd = narrEndMs(art);
  const nm = $('pb-narr-mark');
  if (nm) {
    if (nEnd > 0 && total && nEnd < total) { nm.style.display = ''; nm.style.left = (nEnd / total * 100) + '%'; }
    else nm.style.display = 'none';
  }
  const nb = $('btn-narr-play');
  if (nb) nb.classList.toggle('playing', state.narrOnly && state.playing);
  const sp = CONFIG.speeds[state.speedIdx];
  $('pb-speed-label').textContent = sp === 1 ? '1.0x' : (sp + 'x');
  $('pb-back-num').textContent = state.seekStep;
  $('pb-fwd-num').textContent = state.seekStep;
  const playable = art.meta.audioReady === true;
  const ctrl2 = ['btn-pb-play','btn-pb-prev','btn-pb-back10','btn-pb-fwd10','btn-pb-next','btn-pb-bookmark','btn-pb-loop'];
  ctrl2.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = !playable; el.classList.toggle('disabled', !playable); }
  });
  $('btn-pb-subs').disabled = !art;
  $('btn-pb-subs').classList.toggle('disabled', !art);
  const q = $('btn-pb-queue');
  if (q) {
    q.disabled = !state.activePlaylist;
    q.classList.toggle('on', !!(state.activePlaylist && state.queuePlay));
  }
  const vf = $('vol-fill');
  if (vf) vf.style.width = (state.volume * 100) + '%';
}
function setSpeedMenu() {
  const m = $('speed-menu');
  m.querySelectorAll('button').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.speed) === CONFIG.speeds[state.speedIdx]));
}
function toggleSpeedMenu() {
  const m = $('speed-menu');
  const hidden = m.classList.toggle('hidden');
  if (!hidden) { setSpeedMenu(); if (window.Ui && Ui.slideIn) Ui.slideIn(m, { duration: Ui.getDur('fast') }); }
}
function closeSpeedMenu() { $('speed-menu').classList.add('hidden'); }
(function initVolDrag() {
  const track = document.getElementById('vol-track');
  if (!track) return;
  let dragging = false;
  const setVol = (clientX) => {
    const r = track.getBoundingClientRect();
    state.volume = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    document.getElementById('vol-fill').style.width = (state.volume * 100) + '%';
    try { document.getElementById('pb-audio').volume = state.volume; } catch (e) {}
    try { localStorage.setItem('telg-volume', String(state.volume)); } catch (e) {}
  };
  track.addEventListener('pointerdown', (e) => { dragging = true; e.preventDefault(); setVol(e.clientX); });
  window.addEventListener('pointermove', (e) => { if (dragging) setVol(e.clientX); });
  window.addEventListener('pointerup', () => { dragging = false; });
})();
/* --- seek bar: click to jump, drag the thumb for precise seeking --- */
(function initSeekDrag() {
  const bar = document.getElementById('pb-seek');
  if (!bar) return;
  let dragging = false, moved = false, downX = 0;
  const seekTo = (clientX, autoplay) => {
    const art = currentArtifact();
    if (!art || !art.meta.total_duration_ms) return;
    const r = bar.getBoundingClientRect();
    seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * art.meta.total_duration_ms, autoplay);
  };
  bar.addEventListener('pointerdown', (e) => {
    if (!state.current) return;
    dragging = true; moved = false; downX = e.clientX;
    e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    seekTo(e.clientX, false);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientX - downX) > 4) moved = true;
    seekTo(e.clientX, false);
  });
  const up = (e) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!moved) seekTo(e.clientX, true);   /* plain click keeps autoplay behaviour */
  };
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', () => { dragging = false; });
})();
function setSpeed(sp) {
  const i = CONFIG.speeds.indexOf(sp);
  if (i >= 0) {
    state.speedIdx = i; renderPlayerBar();
    try { $('pb-audio').playbackRate = CONFIG.speeds[state.speedIdx]; } catch (e) {}
  }
  closeSpeedMenu();
}

/* ---------------- QUESTIONS ---------------- */
/* v2 answer is the full option text; legacy artifacts may carry a numeric
   index. Resolve to the option index either way. */
function quizAnswerIndex(qt) {
  if (typeof qt.answer === 'number') return qt.answer;
  if (Array.isArray(qt.options)) return qt.options.indexOf(qt.answer);
  return -1;
}
function pickAnswer(opt) {
  const card = opt.closest('.q-card');
  const inPv = !!card.closest('#pv-questions');
  const art = inPv ? state.generated : currentArtifact();
  if (!art) return;
  const qt = art.listening_questions[+card.dataset.q], oi = +opt.dataset.opt;
  card.querySelectorAll('.q-opt').forEach(o => { o.classList.remove('correct', 'wrong'); o.style.color = ''; });
  card.querySelectorAll('input').forEach(r => r.checked = false);
  card.querySelectorAll('[data-ok]').forEach(el => el.style.display = 'none');
  card.querySelector('[data-expl]').style.display = 'none';
  opt.querySelector('input').checked = true;
  state.stats.quizTotal++;
  const ansIdx = quizAnswerIndex(qt);
  if (oi === ansIdx) {
    state.stats.quizCorrect++;
    opt.classList.add('correct');
    opt.querySelector('[data-ok]').style.display = '';
    card.querySelector('[data-expl]').style.display = '';
  } else {
    opt.classList.add('wrong');
    opt.style.color = 'var(--error)';
    const okOpt = (ansIdx >= 0) ? card.querySelectorAll('.q-opt')[ansIdx] : null;
    if (okOpt) {
      okOpt.classList.add('correct');
      okOpt.querySelector('[data-ok]').style.display = '';
    }
    card.querySelector('[data-expl]').style.display = '';
  }
  saveStats();
  renderToday();
}

/* ---------------- MODAL / TOAST ---------------- */
/* ---------- Generate panel (⌘K command palette) ---------- */
/* Display name of the LLM configured in Settings, e.g. "DeepSeek · deepseek-chat". */
function llmDisplayLabel() {
  const s = readStoredCfg();
  const llm = s.llm || {};
  const prov = LLM_PRESETS[llm.provider] ? llm.provider : 'custom';
  const label = PROVIDER_LABELS[prov] || prov;
  const model = (llm.model || '').trim();
  return model ? label + ' · ' + model : label;
}
function renderGenLlmTag() {
  const tag = $('gen-llm-tag'), val = $('gen-llm-val');
  if (!tag || !val) return;
  const s = readStoredCfg();
  const llm = s.llm || {};
  const prov = LLM_PRESETS[llm.provider] ? llm.provider : 'deepseek';
  const key = (llm.apiKey || '').trim();
  const ready = (llm.model || '').trim() && (key || prov === 'ollama');
  if (ready) {
    val.textContent = llmDisplayLabel();
    tag.classList.remove('na');
    tag.title = '';
  } else {
    val.textContent = I18N[state.lang]['gen.llmNa'];
    tag.classList.add('na');
    tag.title = I18N[state.lang]['gen.llmNaHint'];
  }
}
function openGenPanel() {
  $('gen-panel').classList.remove('hidden');
  closeSpeedMenu();
  applyProfileToGenPanel();
  renderGenLlmTag();
  updateDiff(); updateLen(); updateDepth();
  updateGenerateBtn();
  const input = $('gen-context');
  if (input) { input.focus(); }
  if (window.Ui && Ui.layoutSegThumbs) requestAnimationFrame(() => Ui.layoutSegThumbs());
}
function updateGenerateBtn() {
  const b = $('btn-generate');
  if (!b) return;
  const v = (state.genScene.context || '').trim();
  b.disabled = !v;
}
function closeGenPanel() { $('gen-panel').classList.add('hidden'); }
let usageGran = 'week';
let usageSel = -1;
let usageOffsetDays = 0;
let usageData = null;
let usageBuckets = [];

const pad2 = n => String(n).padStart(2, '0');
const rndOf = k => { let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return (h % 1000) / 1000; };
const dstr = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function usageWindowJS(gran, od) {
  const now = new Date();
  const anchor = addDays(now, -od);
  let start, end, label;
  if (gran === 'day') {
    start = end = anchor; label = dstr(start);
  } else if (gran === 'week') {
    const dow = (anchor.getDay() + 6) % 7; // Mon=0
    start = addDays(anchor, -dow); end = addDays(start, 6);
    label = dstr(start).slice(5) + ' – ' + dstr(end).slice(5);
  } else if (gran === 'month') {
    start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    label = dstr(start).slice(0, 7);
  } else {
    start = new Date(anchor.getFullYear(), 0, 1);
    end = new Date(start.getFullYear(), 11, 31);
    label = String(start.getFullYear());
  }
  return { start: dstr(start), end: dstr(end), label };
}

function mockUsage(gran, od) {
  const win = usageWindowJS(gran, od);
  const base = new Date(win.start + 'T00:00:00');
  const days = (new Date(win.end + 'T00:00:00') - base) / 86400000;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const buckets = [];
  const push = (key, label, v, calls) => buckets.push({ key, label, total_tokens: v, calls });
  const drift = od === 0 ? 1 : Math.max(0.15, 1 - od / 240); // 越早数据越稀疏
  if (gran === 'day') {
    for (let h = 0; h < 24; h++) {
      const v = od === 0 ? 400 + Math.round(2600 * Math.exp(-Math.pow(h - 11, 2) / 14)) : Math.round(1400 * rndOf(pad2(h) + win.start) * drift);
      push(pad2(h), pad2(h) + ':00', v, Math.max(1, Math.round(v / 900)));
    }
  } else if (gran === 'week') {
    for (let i = 0; i <= days; i++) {
      const d = addDays(base, i);
      const v = od === 0 ? 8000 + Math.round(26000 * Math.exp(-Math.pow(i - 3.5, 2) / 3)) : Math.round(22000 * rndOf(dstr(d)) * drift);
      push(dstr(d), dstr(d).slice(5), v, Math.max(1, Math.round(v / 8000)));
    }
  } else if (gran === 'month') {
    for (let i = 0; i <= days; i++) {
      const d = addDays(base, i);
      const v = od === 0 ? 6000 + Math.round(18000 * Math.exp(-Math.pow(i - 15, 2) / 60)) : Math.round(16000 * rndOf(dstr(d)) * drift);
      push(dstr(d), String(d.getDate()), v, Math.max(1, Math.round(v / 7000)));
    }
  } else {
    for (let i = 0; i < 12; i++) {
      const m = new Date(win.start.slice(0, 4), i, 1);
      const v = od === 0 ? 30000 + Math.round(90000 * Math.exp(-Math.pow(i - 6, 2) / 10)) : Math.round(90000 * rndOf(dstr(m).slice(0, 7)) * drift);
      push(dstr(m).slice(0, 7), months[i], v, Math.round(v / 9000));
    }
  }
  return {
    granularity: gran, offset_days: od, window: win, buckets,
    total: { calls: 32, prompt_tokens: 84211, completion_tokens: 120390, total_tokens: 204601 },
    today: { calls: 4, prompt_tokens: 8420, completion_tokens: 12039, total_tokens: 20459 },
    breakdown: { generate: 24, regenerate: 3, 'test-llm': 5 }
  };
}

function fillBuckets(d) {
  const win = d.window;
  const map = {};
  (d.buckets || []).forEach(b => { map[b.key] = b; });
  const base = new Date(win.start + 'T00:00:00');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const out = [];
  const push = (key, label) => {
    const b = map[key];
    out.push(b ? { key, label, total_tokens: b.total_tokens, calls: b.calls } : { key, label, total_tokens: 0, calls: 0 });
  };
  if (d.granularity === 'day') {
    for (let h = 0; h < 24; h++) push(pad2(h), pad2(h) + ':00');
  } else if (d.granularity === 'week') {
    for (let i = 0; i < 7; i++) { const k = dstr(addDays(base, i)); push(k, k.slice(5)); }
  } else if (d.granularity === 'month') {
    const n = new Date(win.end + 'T00:00:00').getDate();
    for (let i = 0; i < n; i++) { const k = dstr(addDays(base, i)); push(k, String(i + 1)); }
  } else {
    for (let i = 0; i < 12; i++) { const k = dstr(new Date(win.start.slice(0, 4), i, 1)).slice(0, 7); push(k, months[i]); }
  }
  return out;
}

function usageChartSVG(buckets, sel, w) {
  const H = 150, top = 10, bottom = 22;
  const n = buckets.length;
  if (!n) return '';
  const max = Math.max(...buckets.map(b => b.total_tokens)) || 1;
  const plotH = H - top - bottom;
  const bw = w / n;
  let bars = '', labels = '';
  buckets.forEach((b, i) => {
    const h = b.total_tokens > 0 ? Math.max(2, Math.round(b.total_tokens / max * plotH)) : 1;
    const x = Math.round(i * bw + bw * 0.14);
    const bw2 = Math.max(2, Math.round(bw * 0.72));
    const y = H - bottom - h;
    const on = i === sel;
    const fill = b.total_tokens > 0 ? (on ? 'var(--primary)' : 'var(--surface-highest)') : 'var(--line)';
    bars += '<rect class="usage-bar" data-idx="' + i + '" x="' + x + '" y="' + y + '" width="' + bw2 + '" height="' + h +
      '" rx="2" fill="' + fill + '">' +
      '<title>' + b.label + ' · ' + (b.total_tokens || 0).toLocaleString() + ' tokens · ' + b.calls + ' calls</title></rect>';
    const show = n <= 8 ? true : (i % Math.ceil(n / 8) === 0 || i === n - 1);
    if (show) labels += '<text x="' + (x + bw2 / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="9" fill="var(--outline)">' + b.label + '</text>';
  });
  return '<svg viewBox="0 0 ' + w + ' ' + H + '" style="overflow:visible">' +
    '<g id="usage-pan">' + bars + labels + '</g></svg>';
}

/* ---------------- STUDY STATS (daily listening time) ---------------- */
let studyGran = 'week', studyOffset = 0, studySel = -1;
function loadStudyDaily() {
  try { return JSON.parse(localStorage.getItem('telg-stats-daily') || '{}'); } catch (e) { return {}; }
}
function fmtMins(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m < 60) return m + 'm';
  return (m / 60).toFixed(1).replace(/\.0$/, '') + 'h';
}
function studyBucketLabel(k, gran) {
  if (gran === 'day') { const h = parseInt(k, 10); return pad2(h) + ':00'; }
  if (gran === 'week') {
    const d = new Date(k + 'T00:00:00');
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  if (gran === 'month') { const p = k.split('-'); return p[1] + '月'; }
  return k; /* year */
}
function studyBuckets(gran, offset) {
  const daily = loadStudyDaily();
  const now = new Date();
  const buckets = [];
  if (gran === 'day') {
    /* one day: current hour bars from today's hours map */
    const today = todayKey();
    const d = daily[today] || { hours: {} };
    const cur = new Date().getHours();
    for (let h = 0; h <= cur; h++) buckets.push({ key: pad2(h), sec: d.hours[pad2(h)] || 0 });
  } else if (gran === 'week') {
    /* window of 14 weeks, one bar per week (aggregate by ISO week) */
    const wk = (d) => { const t = new Date(d + 'T00:00:00'); const day = (t.getDay() + 6) % 7; t.setDate(t.getDate() - day); return t.toISOString().slice(0, 10); };
    const map = {};
    Object.keys(daily).forEach(k => { const w = wk(k); map[w] = (map[w] || 0) + daily[k].sec; });
    const endWk = new Date(now); endWk.setDate(endWk.getDate() - ((endWk.getDay() + 6) % 7) - offset * 7);
    for (let i = 13; i >= 0; i--) {
      const d = new Date(endWk); d.setDate(d.getDate() - i * 7);
      const key = d.toISOString().slice(0, 10);
      buckets.push({ key, sec: map[key] || 0 });
    }
  } else if (gran === 'month') {
    const map = {};
    Object.keys(daily).forEach(k => { const m = k.slice(0, 7); map[m] = (map[m] || 0) + daily[k].sec; });
    const base = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
      buckets.push({ key, sec: map[key] || 0 });
    }
  } else { /* year */
    const map = {};
    Object.keys(daily).forEach(k => { const y = k.slice(0, 4); map[y] = (map[y] || 0) + daily[k].sec; });
    const base = now.getFullYear() - offset;
    for (let i = 9; i >= 0; i--) {
      const y = base - i;
      buckets.push({ key: String(y), sec: map[String(y)] || 0 });
    }
  }
  return buckets.map((b, i) => ({ ...b, label: studyBucketLabel(b.key, gran), total_tokens: Math.round(b.sec / 60), calls: 0 }));
}
function renderStudyChart() {
  const chart = $('study-chart');
  if (!chart) return;
  const w = Math.max(320, chart.clientWidth);
  const buckets = studyBuckets(studyGran, studyOffset);
  chart.innerHTML = usageChartSVG(buckets, studySel, w);
  chart.querySelectorAll('.usage-bar').forEach(bar => {
    bar.addEventListener('click', () => {
      studySel = +bar.dataset.idx;
      renderStudyChart();
      const b = buckets[+bar.dataset.idx];
      const s = $('study-sel');
      if (s) s.textContent = b ? (studyGran === 'day' ? (parseInt(b.key, 10) + ':00–' + (parseInt(b.key, 10) + 1) + ':00') : b.key) + ' · ' + b.total_tokens + ' min' : '—';
    });
  });
  /* restore selection text if a bar is selected */
  if (studySel >= 0 && buckets[studySel]) {
    const b = buckets[studySel];
    const s = $('study-sel');
    if (s) s.textContent = (studyGran === 'day' ? (parseInt(b.key, 10) + ':00–' + (parseInt(b.key, 10) + 1) + ':00') : b.key) + ' · ' + b.total_tokens + ' min';
  }
}
function renderStudy() {
  const box = $('study-body');
  if (!box) return;
  const daily = loadStudyDaily();
  let totalSec = 0, todaySec = 0;
  Object.keys(daily).forEach(k => { totalSec += daily[k].sec || 0; if (k === todayKey()) todaySec = daily[k].sec || 0; });
  box.innerHTML = '<div class="usage-grid" id="study-cards"></div>' +
    '<div class="s-sec-title" data-i18n="settings.usage.trend">Trend</div>' +
    '<div class="usage-chart-head">' +
    '<div class="seg" id="study-gran" style="grid-template-columns:repeat(4,1fr);max-width:220px">' +
    '<button class="seg-item" data-gran="day" data-i18n="settings.usage.viewDay">Day</button>' +
    '<button class="seg-item" data-gran="week" data-i18n="settings.usage.viewWeek">Week</button>' +
    '<button class="seg-item" data-gran="month" data-i18n="settings.usage.viewMonth">Month</button>' +
    '<button class="seg-item" data-gran="year" data-i18n="settings.usage.viewYear">Year</button>' +
    '</div>' +
    '<span class="t-10 dim" id="study-sel" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>' +
    '<span style="display:flex;align-items:center;gap:4px;flex-shrink:0">' +
    '<button class="btn btn-ghost" id="study-now" style="display:none;padding:2px 8px;font-size:11px" data-i18n="settings.usage.now">Now</button>' +
    '<button class="icon-btn" id="study-prev" title="Earlier" style="width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center"><svg class="icon icon-sm"><use href="#i-chevron-left"/></svg></button>' +
    '<button class="icon-btn" id="study-next" title="Later" style="width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center"><svg class="icon icon-sm"><use href="#i-chevron-right"/></svg></button>' +
    '</span>' +
    '</div>' +
    '<div class="usage-chart" id="study-chart" title="Click a bar to inspect"></div>';
  applyLang();
  box.querySelectorAll('#study-gran .seg-item').forEach(b => b.classList.toggle('active', b.dataset.gran === studyGran));
  const cards = $('study-cards');
  if (cards) cards.innerHTML =
    '<div class="usage-cell"><span class="t-10 uc faint" data-i18n="settings.study.total">Total</span>' +
    '<span class="t-15 mono">' + fmtMins(totalSec) + '</span>' +
    '<span class="t-10 dim">' + Object.keys(daily).length + ' days</span></div>' +
    '<div class="usage-cell"><span class="t-10 uc faint" data-i18n="settings.usage.today">Today</span>' +
    '<span class="t-15 mono">' + fmtMins(todaySec) + '</span>' +
    '<span class="t-10 dim">' + fmtMins(state.goalMin * 60) + ' target</span></div>';
  box.addEventListener('click', e => {
    const g = e.target.closest('#study-gran .seg-item');
    if (g && g.dataset.gran !== studyGran) {
      studyGran = g.dataset.gran; studyOffset = 0; studySel = -1;
      box.querySelectorAll('#study-gran .seg-item').forEach(b => b.classList.toggle('active', b.dataset.gran === studyGran));
      renderStudyChart();
    }
    if (e.target.closest('#study-now')) { studyOffset = 0; studySel = -1; renderStudyChart(); }
    if (e.target.closest('#study-prev') || e.target.closest('#study-next')) {
      const dir = e.target.closest('#study-prev') ? 1 : -1;
      studyOffset = Math.max(0, studyOffset + dir);
      studySel = -1;
      const ns = $('study-sel'); if (ns) ns.textContent = '—';
      renderStudyChart();
    }
  });
  renderStudyChart();
}

async function renderUsage() {
  const box = $('usage-body');
  if (!box) return;
  box.innerHTML = '<div class="usage-grid" id="usage-cards"></div>' +
    '<div class="s-sec-title" data-i18n="settings.usage.trend">Trend</div>' +
    '<div class="usage-chart-head">' +
    '<div class="seg" id="usage-gran" style="grid-template-columns:repeat(4,1fr);max-width:220px">' +
    '<button class="seg-item" data-gran="day" data-i18n="settings.usage.viewDay">Day</button>' +
    '<button class="seg-item" data-gran="week" data-i18n="settings.usage.viewWeek">Week</button>' +
    '<button class="seg-item" data-gran="month" data-i18n="settings.usage.viewMonth">Month</button>' +
    '<button class="seg-item" data-gran="year" data-i18n="settings.usage.viewYear">Year</button>' +
    '</div>' +
    '<span class="t-10 dim" id="usage-sel" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</span>' +
    '<span style="display:flex;align-items:center;gap:4px;flex-shrink:0">' +
    '<button class="btn btn-ghost" id="usage-now" style="display:none;padding:2px 8px;font-size:11px" data-i18n="settings.usage.now">Now</button>' +
    '<button class="icon-btn" id="usage-prev" title="Earlier" style="width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center"><svg class="icon icon-sm"><use href="#i-chevron-left"/></svg></button>' +
    '<button class="icon-btn" id="usage-next" title="Later" style="width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center"><svg class="icon icon-sm"><use href="#i-chevron-right"/></svg></button>' +
    '</span>' +
    '</div>' +
    '<div class="usage-chart" id="usage-chart" title="Click a bar to inspect"></div>';
  applyLang();
  box.querySelectorAll('#usage-gran .seg-item').forEach(b => b.classList.toggle('active', b.dataset.gran === usageGran));
  box.addEventListener('click', e => {
    const g = e.target.closest('#usage-gran .seg-item');
    if (g && g.dataset.gran !== usageGran) {
      usageGran = g.dataset.gran; usageOffsetDays = 0; usageSel = -1;
      box.querySelectorAll('#usage-gran .seg-item').forEach(b => b.classList.toggle('active', b.dataset.gran === usageGran));
      loadUsage();
    }
    if (e.target.closest('#usage-now')) { usageOffsetDays = 0; usageSel = -1; loadUsage(); }
    if (e.target.closest('#usage-prev') || e.target.closest('#usage-next')) {
      const half = Math.max(1, Math.round(usageWinDays() / 2));
      const dir = e.target.closest('#usage-prev') ? 1 : -1;
      usageOffsetDays = Math.max(0, usageOffsetDays + dir * half);
      usageSel = -1; loadUsage();
    }
  });
  box.addEventListener('click', e => {
    const bar = e.target.closest('.usage-bar');
    if (bar) { usageSel = +bar.dataset.idx; renderUsageChart(); }
  });
  await loadUsage();
}

async function loadUsage() {
  const box = $('usage-body');
  if (!box) return;
  const fmt = n => (n || 0).toLocaleString();
  let d;
  try {
    d = llmMockOn() ? mockUsage(usageGran, usageOffsetDays) : await API.usage(usageGran, usageOffsetDays);
  } catch (e) {
    box.innerHTML = '<div class="t-11 dim" data-i18n="settings.usage.unavailable">Usage unavailable — backend not reachable.</div>';
    applyLang(); return;
  }
  usageData = d;
  usageBuckets = fillBuckets(d);
  const cards = $('usage-cards');
  if (cards) cards.innerHTML =
    '<div class="usage-cell"><span class="t-10 uc faint" data-i18n="settings.usage.total">Total</span>' +
    '<span class="t-15 mono">' + fmt(d.total.total_tokens) + '</span>' +
    '<span class="t-10 dim">' + d.total.calls + ' calls</span></div>' +
    '<div class="usage-cell"><span class="t-10 uc faint" data-i18n="settings.usage.today">Today</span>' +
    '<span class="t-15 mono">' + fmt(d.today.total_tokens) + '</span>' +
    '<span class="t-10 dim">' + d.today.calls + ' calls</span></div>';
  renderUsageChart();
}

function usageBucketText(b) {
  if (usageGran === 'day') {
    const h = parseInt(b.key, 10);
    return pad2(h) + ':00–' + pad2(h + 1) + ':00';
  }
  return b.key; // YYYY-MM-DD or YYYY-MM
}

function renderUsageChart() {
  const chart = $('usage-chart');
  const selEl = $('usage-sel');
  const nowBtn = $('usage-now');
  if (!chart || !usageData) return;
  const w = Math.max(280, chart.clientWidth || 460);
  usageSel = Math.min(usageSel, usageBuckets.length - 1);
  chart.innerHTML = usageChartSVG(usageBuckets, usageSel, w);
  nowBtn.style.display = usageOffsetDays > 0 ? '' : 'none';
  const selB = usageBuckets[usageSel];
  if (selB && selB.total_tokens > 0) {
    selEl.textContent = usageBucketText(selB) + ' · ' + (selB.total_tokens || 0).toLocaleString() + ' tokens · ' + selB.calls + ' calls';
  } else {
    const sum = usageBuckets.reduce((a, b) => a + (b.total_tokens || 0), 0);
    const calls = usageBuckets.reduce((a, b) => a + (b.calls || 0), 0);
    selEl.textContent = usageData.window.label + ' · ' + sum.toLocaleString() + ' tokens · ' + calls + ' calls';
  }
}

function usageWinDays() {
  if (!usageData || !usageData.window) return 7;
  return Math.max(1, Math.round((new Date(usageData.window.end + 'T00:00:00') - new Date(usageData.window.start + 'T00:00:00')) / 86400000) + 1);
}


function switchMTab(tab, smooth) {
  document.querySelectorAll('#engine-modal .s-nav-item').forEach(b => b.classList.toggle('active', b.dataset.mtab === tab));
  const sec = $('mp-' + tab);
  if (!sec) return;
  const m = document.querySelector('#engine-modal .modal-body');
  if (!m) return;
  const dy = (sec.getBoundingClientRect().top - m.getBoundingClientRect().top) - 12;
  if (smooth === false) m.scrollTop = m.scrollTop + dy;
  else m.scrollBy({ top: dy, behavior: 'smooth' });
}
function watchMTab() {
  const modal = document.querySelector('#engine-modal .modal-body');
  if (!modal) return;
  const secs = ['general', 'llm', 'tts', 'shortcuts', 'developer', 'study', 'usage', 'about'].map(t => $('mp-' + t)).filter(Boolean);
  modal.addEventListener('scroll', () => {
    const top = modal.getBoundingClientRect().top + modal.clientHeight * 0.5;
    let cur = 'general';
    for (const s of secs) { if (s.getBoundingClientRect().top <= top) cur = s.id.slice(3); }
    document.querySelectorAll('#engine-modal .s-nav-item').forEach(b => b.classList.toggle('active', b.dataset.mtab === cur));
    /* Leaving the audition section stops any role preview still playing. */
    if (cur !== 'tts') stopAuditions();
  }, { passive: true });
}
function openModal() {
  const overlay = $('engine-modal');
  overlay.classList.remove('hidden');
  overlay.querySelector('.modal-body').scrollTop = 0;
  renderUsage();
  renderStudy();
  refreshAboutAccount();
  updateEngineBadge();
  $('cfg-lang').value = state.lang;
  const seg = document.querySelector('#cfg-theme-seg [data-theme-opt="' + state.theme + '"]');
  if (seg) setSeg($('cfg-theme-seg'), seg);
  $('cfg-def-speed').value = String(CONFIG.speeds[state.speedIdx]);
  const ssk = $('cfg-seek-step'); if (ssk) ssk.value = String(state.seekStep);
  const gmS = $('cfg-goal-min'); if (gmS) gmS.value = String(state.goalMin);
  const zhSeg = document.querySelector('#cfg-zh-seg [data-zh-opt="' + (state.zhVisible ? 'on' : 'off') + '"]');
  if (zhSeg) setSeg($('cfg-zh-seg'), zhSeg);
  const narrSeg = document.querySelector('#cfg-narr-seg [data-narr-opt="' + (state.autoNarr ? 'on' : 'off') + '"]');
  if (narrSeg) setSeg($('cfg-narr-seg'), narrSeg);
  renderNarrVoiceSelect();
  try {
    const cfg = JSON.parse(localStorage.getItem('telg-settings') || 'null');
    if (cfg && cfg.tts) {
      const prov = normalizeTTSProvider(cfg.tts.provider);
      $('cfg-tts-provider').value = prov;
      const stored = cfg.tts.voices || (cfg.tts.voice ? String(cfg.tts.voice).split(' + ') : null);
      loadTTSVoices(prov).then(() => { renderVoiceRoles(sanitizeRolesForProvider(stored, prov)); renderNarrVoiceSelect(prov); });
    } else { renderVoiceRoles(null); loadTTSVoices(ttsProvider()).then(() => renderNarrVoiceSelect()); }
  } catch (e) { renderVoiceRoles(null); }
  applyDebugStates();
}
function closeModal() {
  stopAuditions();
  $('engine-modal').classList.add('hidden');
}
async function testLLM() {
  const btn = $('btn-test-llm'), res = $('llm-test-result');
  btn.disabled = true; btn.textContent = I18N[state.lang]['settings.llm.testing'];
  res.className = 'test-output'; res.textContent = '…';
  try {
    const r = await API.testLLM({ provider: $('cfg-llm-provider').value, base_url: $('cfg-llm-base').value, api_key: $('cfg-llm-key').value, model: $('cfg-llm-model').value, temperature: parseFloat($('cfg-llm-temp').value) });
    if (r.ok) res.className = 'test-output ok', res.textContent = I18N[state.lang]['settings.llm.ok'] + ' · ' + r.latency_ms + 'ms' + (r.model ? ' · ' + r.model : '') + (r.mock ? ' · Mock' : '');
    else res.className = 'test-output err', res.textContent = (r.error || I18N[state.lang]['settings.test.err']);
  } catch (e) { res.className = 'test-output err'; res.textContent = e.message; }
  btn.disabled = false; btn.textContent = I18N[state.lang]['settings.llm.testBtn'];
}
async function testGen() {
  const btn = $('btn-test-gen'), res = $('llm-gen-result');
  btn.disabled = true; res.className = 'test-output';
  res.textContent = I18N[state.lang]['settings.llm.genTesting'];
  try {
    const r = await API.testGenerate({ base_url: $('cfg-llm-base').value, api_key: $('cfg-llm-key').value, model: $('cfg-llm-model').value, temperature: parseFloat($('cfg-llm-temp').value) });
    const dd = $('llm-debug-detail');
    if (dd) {
      try {
        dd.style.display = 'block';
        dd.textContent = '-- REQUEST --\n' + JSON.stringify({ base_url: $('cfg-llm-base').value, api_key: $('cfg-llm-key').value ? '•••' : '', model: $('cfg-llm-model').value, temperature: $('cfg-llm-temp').value }, null, 2) + '\n\n-- RESPONSE --\n' + JSON.stringify(r, null, 2);
      } catch (e) { if (dd) dd.textContent = String(r); }
    }
    if (r.ok) {
      res.className = 'test-output ok';
      res.textContent = I18N[state.lang]['settings.llm.ok'] + ' · ' + r.latency_ms + 'ms · ' + r.segs + ' segs · ' + r.words + ' words · ' + Math.round(r.total_ms / 1000) + 's';
    } else {
      res.className = 'test-output err'; res.textContent = 'Failed: ' + (r.error || I18N[state.lang]['settings.test.err']);
    }
  } catch (e) { res.className = 'test-output err'; res.textContent = 'Failed: ' + e.message; }
  btn.disabled = false; btn.textContent = I18N[state.lang]['settings.llm.genTestBtn'];
}
async function promptPreview() {
  const btn = $('btn-prompt-preview'), out = $('prompt-preview-out');
  if (!btn || !out) return;
  btn.disabled = true;
  try {
    const params = collectParams();
    const r = await API.promptPreview(params);
    if (r && r.ok) {
      out.style.display = '';
      out.innerHTML = '<div class="pp-block-title">System · static</div>'
        + '<pre class="debug-pre">' + escapeHtml(r.system) + '</pre>'
        + '<div class="pp-block-title">User · this request</div>'
        + '<pre class="debug-pre">' + escapeHtml(r.user) + '</pre>';
    } else {
      out.style.display = '';
      out.textContent = 'Prompt preview failed: ' + ((r && r.error) || 'unknown error');
    }
  } catch (e) {
    out.style.display = '';
    out.textContent = 'Prompt preview failed: ' + e.message;
  }
  btn.disabled = false;
}
function readStoredCfg() {
  try { return JSON.parse(localStorage.getItem('telg-settings') || 'null') || {}; } catch (e) { return {}; }
}
function devModeOn() {
  /* Master dev switch: ON by default in dev builds, OFF in release builds. */
  const v = localStorage.getItem('telg-dev-mode');
  if (CONFIG.devMode) return v !== '0';
  return v === '1';
}
function applyDebugStates() {
  const on = devModeOn();
  const m = $('cfg-dev-mode'); if (m) m.checked = on;
  const lm = $('cfg-llm-mock'); if (lm) lm.checked = llmMockOn();
  const tm = $('cfg-tts-mock'); if (tm) tm.checked = ttsMockOn();
  const ds = $('dev-tools-section'); if (ds) ds.style.display = on ? '' : 'none';
  const ls = $('llm-debug-section'); if (ls) ls.style.display = (on && llmMockOn()) ? '' : 'none';
  const ts = $('tts-mock-section'); if (ts) ts.style.display = (on && ttsMockOn()) ? '' : 'none';
}
/* ---------- TTS Mock corpus library ---------- */
/* Dataset → corpus template mapping (used by TTS Mock corpus take-over). */
const TEST_DATA_MATERIAL = {
  tire: MOCK_MATERIALS[0],
  canbus: MOCK_MATERIALS[1],
  tv: MOCK_MATERIALS[2]
};
function testDataKey() {
  const k = String(localStorage.getItem('telg-test-data') || '').trim();
  return (k === 'tire' || k === 'canbus' || k === 'tv') ? k : '';
}
function selectTestData(key) {
  localStorage.setItem('telg-test-data', key);
  updateEngineBadge();
  bootLive();
}
async function toggleDevMode() {
  const cb = $('cfg-dev-mode');
  const want = cb.checked;
  if (want && !CONFIG.devMode) {
    /* Release build: turning the master switch ON requires the unlock key. */
    const key = prompt(I18N[state.lang]['settings.llm.unlockPh']);
    if (!key) { cb.checked = false; return; }
    try {
      const r = await API.unlockDev(key.trim());
      if (!r.ok) { cb.checked = false; alert('Failed: ' + (r.error || 'invalid')); return; }
    } catch (e) { cb.checked = false; alert('Failed: ' + e.message); return; }
  }
  localStorage.setItem('telg-dev-mode', want ? '1' : '0');
  if (want) {
    /* Sub-switches always start OFF when the master switch is enabled. */
    localStorage.setItem('telg-llm-mock', '0');
    localStorage.setItem('telg-tts-mock', '0');
  }
  applyDebugStates();
}
function toggleLlmMock() {
  const cb = $('cfg-llm-mock'); if (!cb) return;
  localStorage.setItem('telg-llm-mock', cb.checked ? '1' : '0');
  applyDebugStates(); updateEngineBadge();
}
function toggleTtsMock() {
  const cb = $('cfg-tts-mock'); if (!cb) return;
  localStorage.setItem('telg-tts-mock', cb.checked ? '1' : '0');
  applyDebugStates(); updateEngineBadge();
}
function toggleKeyVisible() {
  const inp = $('cfg-llm-key'), btn = $('btn-key-eye');
  if (!inp || !btn) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
}
function saveModal() {
  const cfg = {
    lang: $('cfg-lang').value,
    theme: document.querySelector('#cfg-theme-seg .seg-item.active').dataset.themeOpt,
    defSpeed: $('cfg-def-speed').value,
    seekStep: $('cfg-seek-step').value,
    goalMin: $('cfg-goal-min').value,
    zhDefault: (document.querySelector('#cfg-zh-seg .seg-item.active') || {}).dataset.zhOpt || 'on',
    autoNarr: (document.querySelector('#cfg-narr-seg .seg-item.active') || {}).dataset.narrOpt || 'on',
    narrVoice: (document.querySelector('#cfg-narr-voice') || {}).value || 'en-US-JennyNeural',
    llm: { provider: $('cfg-llm-provider').value, model: $('cfg-llm-model').value, baseUrl: $('cfg-llm-base').value, apiKey: $('cfg-llm-key').value, temperature: $('cfg-llm-temp').value },
    tts: { provider: $('cfg-tts-provider').value, voices: currentVoiceRoles(), voice: currentVoiceRoles().map(x => x.voice).filter(Boolean).join(' + '), speechRate: $('cfg-tts-rate').value }
  };
  try { const prev = JSON.parse(localStorage.getItem('telg-settings') || 'null') || {}; if (prev.profile) cfg.profile = prev.profile; if (prev.domains && prev.domains.length) cfg.domains = prev.domains; } catch (e) {}
  try { localStorage.setItem('telg-settings', JSON.stringify(cfg)); } catch (e) {}
  try { localStorage.setItem('telg-theme', cfg.theme); } catch (e) {}
  try { localStorage.setItem('telg-lang', cfg.lang); } catch (e) {}
  state.lang = cfg.lang;
  state.theme = cfg.theme;
  const si = CONFIG.speeds.indexOf(parseFloat(cfg.defSpeed));
  if (si >= 0) state.speedIdx = si;
  const ss = parseInt(cfg.seekStep, 10);
  if ([5, 10, 15, 30].includes(ss)) state.seekStep = ss;
  const gm = parseInt(cfg.goalMin, 10);
  if ([15, 30, 45, 60, 90].includes(gm)) state.goalMin = gm;
  state.zhVisible = cfg.zhDefault !== 'off';
  state.autoNarr = cfg.autoNarr !== 'off';
  state.narrVoice = cfg.narrVoice || 'en-US-JennyNeural';
  updateSeekStep();
  applyLang();
  applyTheme();
  renderPlayerBar();
  applyTranscriptLang();
  renderToday();
  updateEngineBadge();
  renderGenLlmTag();
  showToast(I18N[state.lang]['settings.saved']);
  closeModal();
  /* Settings changed — the badge must reflect the NEW config's real state. */
  setTimeout(() => selfCheck(true), 400);
}
let toastTimer = null;
/* ---------- TTS failure handling: friendly reason + retry ---------- */
function ttsFriendlyError(cls, raw) {
  const L = I18N[state.lang];
  const map = { timeout: L['err.tts.timeout'], unreachable: L['err.tts.unreachable'], auth: L['err.tts.auth'], other: L['err.tts.other'], audio: L['err.audio'], model_missing: L['err.tts.modelMissing'] };
  const head = map[cls] || map.other;
  const detail = raw ? String(raw).replace(/\s+/g, ' ').slice(0, 240) : '';
  return detail ? head + ' — ' + detail : head;
}
function showSynthError(err) {
  const box = $('synth-error');
  if (!box) { showToast('Synthesis failed: ' + (err && err.message || err), 'error'); return; }
  const msg = err && err.message || String(err);
  let cls = 'other', raw = msg;
  const m = msg.match(/^TTS synthesis failed \[(\w+)\]: ([\s\S]*)$/);
  if (m) { cls = m[1]; raw = m[2]; }
  else if (msg.indexOf('Audio file unavailable') >= 0) cls = 'audio';
  else if (msg.indexOf('Cannot reach backend') >= 0 || /Failed to fetch|NetworkError|ERR_/.test(msg)) cls = 'unreachable';
  const L = I18N[state.lang];
  $('synth-error-title').textContent = (L['err.tts.' + cls] || L['err.' + cls] || L['err.tts.other']);
  $('synth-error-class').textContent = '[' + cls + ']';
  $('synth-error-detail').textContent = String(raw).replace(/\s+/g, ' ').slice(0, 300);
  box.classList.remove('hidden');
}
function hideSynthError() { const b = $('synth-error'); if (b) b.classList.add('hidden'); }
const TOAST_IC = { success: '#i-check-circle', error: '#i-x-circle', warn: '#i-alert-triangle', info: '#i-info-circle' };
const TOAST_MS = 2600;   /* uniform dwell time; hover pauses the countdown */
function showToast(msg, type) {
  type = TOAST_IC[type] ? type : 'success';
  const t = $('toast');
  const ic = $('toast-ic');
  if (ic) ic.setAttribute('href', TOAST_IC[type]);
  t.classList.remove('success', 'error', 'warn', 'info');
  t.classList.add(type);
  $('toast-msg').textContent = humanToast(msg, state.lang);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), TOAST_MS);
  t.onmouseenter = () => clearTimeout(toastTimer);
  t.onmouseleave = () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), TOAST_MS); };
}
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['grounding', 'vocab', 'questions', 'patterns'].forEach(t => $('panel-' + t).classList.toggle('active', t === tab));
}
function toggleFilter(f, btn) {
  const i = state.filters.indexOf(f);
  if (i >= 0) state.filters.splice(i, 1); else state.filters.push(f);
  btn.classList.toggle('active-filter', i < 0);
  renderLibrary();
}
function clearFiltersFromClick() { clearFilters(); }

/* ---------------- GLOBAL DELEGATED CLICK ---------------- */
function onClick(e) {
  if (e.target.closest && e.target.closest('#btn-sidebar')) { toggleSidebar(); return; }
  if (e.target.closest('#sidebar-backdrop')) { toggleSidebar(false); return; }
  if (e.target.closest('#btn-clear-filter')) { clearFilters(); return; }
  if (e.target.closest('#btn-rename')) { startRenameHead(); return; }
  if (e.target.closest('#adj-role-add')) { addAdjustRole(); return; }
  if (e.target.closest('#adj-voice-roles .btn-role-del')) { delAdjustRole(e.target.closest('.btn-role-del')); return; }
  if (e.target.closest('#adj-voice-roles .btn-role-test')) { auditionAdjustRole(e.target.closest('.btn-role-test')); return; }
  if (e.target.closest('#btn-role-add')) { addVoiceRole(); return; }
  if (e.target.closest('.btn-role-del')) { delVoiceRole(e.target.closest('.btn-role-del')); return; }
  if (e.target.closest('.btn-role-test')) { auditionRole(e.target.closest('.btn-role-test')); return; }
  if (!e.target.closest('#speed-menu') && !e.target.closest('#btn-pb-speed')) closeSpeedMenu();
  if (!e.target.closest('#font-menu') && !e.target.closest('#btn-font')) closeFontMenu();
  if (e.target.closest('#gen-llm-tag')) { openModal(); switchMTab('llm', false); return; }
  if (e.target.closest('#btn-cancel-gen')) { closeGenPanel(); return; }
  if (e.target.id === 'gen-backdrop') { closeGenPanel(); return; }
  if (e.target.closest('#btn-theme')) { toggleTheme(); return; }
  if (e.target.closest('#btn-engine-config')) { openModal(); return; }
  const mTab = e.target.closest('#engine-modal .s-nav-item');
  if (mTab) { switchMTab(mTab.dataset.mtab); return; }
  const thOpt = e.target.closest('#cfg-theme-seg .seg-item');
  if (thOpt) { setSeg($('cfg-theme-seg'), thOpt); return; }
  if (e.target.closest('#btn-modal-close') || e.target.closest('#btn-modal-cancel')) { closeModal(); return; }
  if (e.target.closest('#btn-modal-save')) { saveModal(); return; }
  if (e.target.closest('#btn-test-llm')) { testLLM(); return; }
  if (e.target.closest('#btn-test-gen')) { testGen(); return; }
  if (e.target.closest('#btn-prompt-preview')) { promptPreview(); return; }
  if (e.target.closest && e.target.closest('#btn-key-eye')) { toggleKeyVisible(); return; }
  if (e.target.id === 'cfg-dev-mode') { toggleDevMode(); return; }
  if (e.target.id === 'cfg-llm-mock') { toggleLlmMock(); return; }
  if (e.target.id === 'cfg-tts-mock') { toggleTtsMock(); return; }
  if (e.target.closest('#cfg-zh-seg .seg-item')) { const opt = e.target.closest('#cfg-zh-seg .seg-item'); setSeg($('cfg-zh-seg'), opt); return; }
  if (e.target.closest('#cfg-narr-seg .seg-item')) { const opt = e.target.closest('#cfg-narr-seg .seg-item'); setSeg($('cfg-narr-seg'), opt); return; }
  if (e.target.closest('#btn-narr-play')) { toggleNarration(); return; }
  if (e.target.closest('.q-expl')) { seekToExplain(Number(e.target.closest('.q-expl').dataset.qidx)); return; }
  if (e.target.id === 'cfg-llm-temp') { const tv = $('cfg-temp-val'); if (tv) tv.textContent = e.target.value; return; }
  if (e.target.id === 'cfg-test-data') { selectTestData(e.target.value); return; }
  if (e.target.id === 'engine-modal') { closeModal(); return; }
  if (e.target.closest('#btn-adjust-close') || e.target.closest('#btn-adjust-cancel')) { closeAdjustModal(); return; }
  if (e.target.closest('#btn-adjust-apply')) {
    if (adjustPanel === 'voice') applyTTS(); else refineGenerate();
    return;
  }
  if (e.target.id === 'adjust-modal') { closeAdjustModal(); return; }
  if (e.target.closest('#btn-refine')) { openRefineModal(); return; }
  if (e.target.closest('#btn-voice')) { openPublishReadyView(); return; }
  if (e.target.closest('#btn-edit-audio')) { openTTSModal(); return; }
  if (e.target.closest('#btn-synth')) { openTTSModal(); return; }
  if (e.target.closest('#btn-retry-synth')) { hideSynthError(); synthesizeAudio(); return; }
  if (e.target.closest('#btn-generate')) { runGenerate(); return; }
  if (e.target.closest('#toggle-advanced')) { toggleAdvanced(); return; }
  const diffItem = e.target.closest('#diff-seg .seg-item');
  if (diffItem) { setSeg($('diff-seg'), diffItem); updateDiff(); return; }
  const lenItem = e.target.closest('#len-seg .seg-item');
  if (lenItem) { setSeg($('len-seg'), lenItem); updateLen(); return; }
  const depthItem = e.target.closest('#depth-seg .seg-item');
  if (depthItem) { setSeg($('depth-seg'), depthItem); updateDepth(); return; }
  const chip = e.target.closest('#breadth-chips .chip');
  if (chip) { chip.classList.toggle('active'); return; }
  const rDiffItem = e.target.closest('#refine-diff .seg-item');
  if (rDiffItem) { setSeg($('refine-diff'), rDiffItem); updateRefineLabels(); return; }
  const rLenItem = e.target.closest('#refine-len .seg-item');
  if (rLenItem) { setSeg($('refine-len'), rLenItem); updateRefineLabels(); return; }
  const rDepthItem = e.target.closest('#refine-depth .seg-item');
  if (rDepthItem) { setSeg($('refine-depth'), rDepthItem); updateRefineLabels(); return; }
  const rDirItem = e.target.closest('#refine-dir .seg-item');
  if (rDirItem) { setSeg($('refine-dir'), rDirItem); updateRefineLabels(); return; }
  const modeBtn = e.target.closest('.seg-item[data-mode]');
  if (modeBtn) { setListenMode(modeBtn.dataset.mode); return; }
  if (e.target.closest('#btn-font')) { toggleFontMenu(); return; }
  const fsItem = e.target.closest('#font-menu [data-fs]');
  if (fsItem) { applyFontSize(fsItem.dataset.fs); closeFontMenu(); return; }
  if (e.target.closest('#btn-md-export')) { exportMD(currentArtifact()); return; }
  const phDone = e.target.closest('.gen-phase.done');
  if (phDone) {
    const phIdx = +phDone.dataset.phase;
    if (phIdx === 0) openRefineModal();
    else if (phIdx === 1) openTTSModal();
    else openPublishModal();
    return;
  }
  if (e.target.closest('#btn-zh-toggle')) { state.zhVisible = !state.zhVisible; applyTranscriptLang(); return; }
  if (e.target.closest('#btn-publish') || e.target.closest('#btn-publish-banner')) { openPublishModal(); return; }
  if (e.target.closest('#btn-pub-close') || e.target.closest('#btn-pub-cancel')) { closePublishModal(); return; }
  if (e.target.closest('#btn-pub-ok')) { publishCurrent(); return; }
  if (e.target.id === 'publish-modal') { closePublishModal(); return; }
  if (e.target.closest('#btn-bm-close') || e.target.closest('#btn-bm-done')) { closeBookmarkModal(); return; }
  if (e.target.closest('#btn-bm-clear')) { clearBookmarks(); return; }
  if (e.target.id === 'bookmark-modal') { closeBookmarkModal(); return; }
  const bmRow = e.target.closest('.bm-row');
  if (bmRow) {
    const delBtn = e.target.closest('[data-bm-del]');
    if (delBtn) { removeBookmark(+delBtn.dataset.bmDel); return; }
    jumpToBookmark(bmRow.dataset.mid, +bmRow.dataset.idx);
    closeBookmarkModal();
    return;
  }
  if (e.target.closest('#btn-lib-gen') || e.target.closest('#btn-empty-gen')) { openGenPanel(); return; }
  if (e.target.closest('#btn-pl-close') || e.target.closest('#btn-pl-done')) { closePlModal(); return; }
  if (e.target.id === 'pl-modal') { closePlModal(); return; }
  if (e.target.closest('#btn-confirm-cancel')) { closeConfirmModal(); return; }
  if (e.target.closest('#btn-confirm-ok')) { confirmDelete(); return; }
  if (e.target.id === 'confirm-modal') { closeConfirmModal(); return; }
  if (e.target.closest('#btn-pl-new')) { startPlCreate(); return; }
  if (e.target.closest('.pl-row')) {
    const row = e.target.closest('.pl-row');
    if (e.target.closest('.pl-rename-input')) return;
    togglePlMaterial(row.dataset.plid);
    return;
  }
  if (e.target.closest('.pl-rename-input')) return;
  const libAct = e.target.closest('.lib-item .lib-act');
  if (libAct) {
    const id = libAct.closest('.lib-item').dataset.id;
    if (libAct.dataset.act === 'rename') renameLibItem(id);
    else if (libAct.dataset.act === 'delete') deleteLibItem(id);
    else if (libAct.dataset.act === 'pl-remove' && state.activePlaylist) removeFromActivePlaylist(id);
    else if (libAct.dataset.act === 'pl-add') openPlModalFor(id);
    return;
  }
  if (e.target.closest('.lib-rename-input')) return;
  const libItem = e.target.closest('.lib-item');
  if (libItem) { loadMaterial(libItem.dataset.id); return; }
  const plAct = e.target.closest('.playlist-row .lib-act');
  if (plAct) {
    const id = plAct.closest('.playlist-row').dataset.plid;
    if (plAct.dataset.act === 'pl-rename') renamePl(id);
    else if (plAct.dataset.act === 'pl-delete') deletePl(id);
    return;
  }
  if (e.target.closest('.pl-rename-input')) return;
  const plRow = e.target.closest('.playlist-row');
  if (plRow) { setActivePlaylist(plRow.dataset.plid); return; }
  if (e.target.closest('#btn-new-playlist')) { startPlCreate(); return; }
  const tabBtn = e.target.closest('.tab-btn');
  if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }
  const qaBtn = e.target.closest('.quick-add');
  if (qaBtn) { openQuickAdd(qaBtn.dataset.key, qaBtn); return; }
  const filter = e.target.closest('[data-filter]');
  if (filter) { toggleFilter(filter.dataset.filter, filter); return; }
  if (e.target.closest('#btn-pb-play')) { togglePlay(); return; }
  if (e.target.closest('#btn-pb-prev')) { if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; } prevSentence(); return; }
  if (e.target.closest('#btn-pb-next')) { if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; } nextSentence(); return; }
  if (e.target.closest('#btn-pb-back10')) { if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; } seek(state.time - state.seekStep * 1000, true); return; }
  if (e.target.closest('#btn-pb-fwd10')) { if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; } seek(state.time + state.seekStep * 1000, true); return; }
  if (e.target.closest('#btn-pb-loop')) { toggleLoop(); return; }
  if (e.target.closest('#btn-pb-bookmark')) { if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; } openBookmarkModal(); return; }
  /* ---- v2 scene simulation (generator panel) ---- */
  const mgrDomains = e.target.closest('#btn-mgr-domains');
  if (mgrDomains) { state.genScene.manageDomains = !state.genScene.manageDomains; renderGenScene(); return; }
  const mgrRoles = e.target.closest('#btn-mgr-roles');
  if (mgrRoles) { state.genScene.manageRoles = !state.genScene.manageRoles; renderGenScene(); return; }
  const delDom = e.target.closest('#gen-domains .chip-x');
  if (delDom) { removeCustomDomain(delDom.dataset.delDomain); return; }
  const delRole = e.target.closest('#gen-roles-wrap .chip-x');
  if (delRole) { removeCustomRole(delRole.dataset.delRole); return; }
  const fmtItem = e.target.closest('#fmt-seg .seg-item');
  if (fmtItem) { state.genScene.format = fmtItem.dataset.fmt; renderGenScene(); return; }
  const domChip = e.target.closest('#gen-domains .chip[data-domain]');
  if (domChip) {
    const name = domChip.dataset.domain;
    const m = genDomainCandidates().find(d => d.name === name);
    if (m) { state.genScene.domain = { id: m.id, name: m.name }; renderGenScene(); }
    return;
  }
  const roleChip = e.target.closest('#gen-roles-wrap .chip[data-role]');
  if (roleChip) { toggleGenRole(roleChip.dataset.role); return; }
  const addDomChip = e.target.closest('#gen-domains .chip-add[data-key="domains"]');
  if (addDomChip) { openQuickAdd('domains', addDomChip); return; }
  const addRoleChip = e.target.closest('#gen-roles-wrap .chip-add[data-key="roles"]');
  if (addRoleChip) { openQuickAdd('roles', addRoleChip); return; }
  if (e.type === 'input' && e.target.id === 'gen-context') { state.genScene.context = e.target.value; updateGenerateBtn(); return; }
  if (e.target.closest('#ob-skip-llm')) { obIdx = 1; obSub = 0; renderObStep(); return; }
  if (e.target.closest('#ob-gen-profile')) { obGenProfile(); return; }
  if (e.type === 'change' && e.target.id === 'ob-llm-provider') {
    const pr = LLM_PRESETS[$('ob-llm-provider').value];
    if (pr) { $('ob-llm-base').value = pr.base; $('ob-llm-model').value = pr.model; }
  }
  if (obIdx === 0 && (e.target.id === 'ob-llm-provider' || e.target.id === 'ob-llm-model' || e.target.id === 'ob-llm-base' || e.target.id === 'ob-llm-key') && state.obLlmOk) {
    state.obLlmOk = false; const nx = $('ob-next'); if (nx) nx.disabled = true;
    const rr = $('ob-llm-result'); if (rr) { rr.className = 'test-output'; rr.textContent = ''; }
    return;
  }
  const obChip = e.target.closest('#onboard-modal .ob-chip-row .chip');
  if (obChip) {
    const row = obChip.closest('.ob-chip-row'); const q = row.dataset.q; const val = obChip.dataset.val;
    if (row.dataset.seg) { obSurvey[q] = val; row.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === obChip)); }
    else if (row.dataset.multi) { const arr = obSurvey[q] || []; const i = arr.indexOf(val); if (i >= 0) arr.splice(i, 1); else arr.push(val); obSurvey[q] = arr; obChip.classList.toggle('active'); }
    return;
  }
  if (e.target.closest('#btn-account-login')) { location.href = 'onboarding.html'; return; }
  if (e.target.closest('#btn-account-logout')) { AuthAPI.logout(); state.user = null; refreshAboutAccount(); $('engine-modal').classList.add('hidden'); location.href = 'onboarding.html'; return; }
  if (e.target.closest('#pf-lang .seg-item')) { const b = e.target.closest('#pf-lang .seg-item'); document.querySelectorAll('#pf-lang .seg-item').forEach(x => x.classList.remove('active')); b.classList.add('active'); return; }
  if (e.target.closest('#btn-pb-queue')) { toggleQueuePlay(); return; }
  const spItem = e.target.closest('#speed-menu [data-speed]');
  if (spItem) { setSpeed(parseFloat(spItem.dataset.speed)); return; }
  if (e.target.closest('#btn-pb-speed')) { toggleSpeedMenu(); return; }
  if (e.target.closest('#btn-pb-subs')) { toggleInspector(); return; }
  const vt = e.target.closest('#vol-track');
  if (vt) {
    const r = vt.getBoundingClientRect();
    state.volume = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    $('vol-fill').style.width = (state.volume * 100) + '%';
    try { $('pb-audio').volume = state.volume; } catch (e) {}
    return;
  }
  const act = e.target.closest('[data-act]');
  if (act) {
    const row = act.closest('.trow'), idx = +row.dataset.idx;
    if (act.dataset.act === 'sloop') {
      if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; }
      /* enable single-sentence loop and jump to that sentence */
      state.loop = true;
      syncLoopUI();
      seekSentence(idx, true);
      return;
    }
    if (act.dataset.act === 'bookmark') { toggleBookmark(idx); return; }
    if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; }
    seekSentence(idx, true);
    return;
  }
  const row = e.target.closest('.trow');
  if (row) {
    if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; }
    seekSentence(+row.dataset.idx, true);
    return;
  }
  const opt = e.target.closest('[data-opt]');
  if (opt) { pickAnswer(opt); return; }
}

/* ---------------- KEYBOARD ---------------- */
function onKey(e) {
  if (e.key === 'Escape') {
    if (state.renamingId) { state.renamingId = null; renderLibrary(); return; }
    if (state.plRenamingId) { state.plRenamingId = null; renderPlaylists(); return; }
    if (state.plCreating) { state.plCreating = false; renderPlaylists(); if (state.plModalTarget) renderPlList(); return; }
  }
  if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('lib-rename-input')) {
    e.target.dataset.done = '1';
    commitRename(e.target.dataset.rid, e.target.value);
    return;
  }
  if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('pl-rename-input')) {
    e.target.dataset.done = '1';
    if (e.target.dataset.rid) commitPlRename(e.target.dataset.rid, e.target.value);
    else if (e.target.dataset.plCreate) commitPlCreate(e.target.value);
    return;
  }
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openGenPanel(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); openGenPanel(); return; }
  if (mod && e.key === 'Enter') { e.preventDefault(); if (!$('gen-panel').classList.contains('hidden')) runGenerate(); return; }
  if (!$('gen-panel').classList.contains('hidden')) {
    if (e.key === 'Escape') closeGenPanel();
    return;
  }
  if (!$('confirm-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeConfirmModal();
    return;
  }
  if (!$('adjust-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closeAdjustModal();
    return;
  }
  if (!$('pl-modal').classList.contains('hidden')) {
    if (e.key === 'Escape') closePlModal();
    else if (e.key === 'Enter' && e.target && e.target.classList && e.target.classList.contains('pl-rename-input')) {
      commitPlCreate(e.target.value);
    }
    return;
  }
  if (typing || !$('engine-modal').classList.contains('hidden')) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key.toLowerCase() === 'j' || e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'r') {
    if (!isPlayable(currentArtifact())) { toastNeedSynth(); return; }
    if (e.key.toLowerCase() === 'j') prevSentence();
    else if (e.key.toLowerCase() === 'k') nextSentence();
    else { const i = currentSegIndex(); if (i >= 0) seekSentence(i, true); }
  }
  else if (e.key === 'Escape') { closeSpeedMenu(); closeAdjustModal(); closePublishModal(); }
}

/* ---------------- INIT ---------------- */
function init() {
  /* first-run gate: welcome -> local account -> onboarding -> main UI */
  initGate();
  /* fold legacy settings.domains into recommendations once (idempotent) */
  migrateLegacyDomains();
  /* restore persisted volume, phrase bookmarks and today's stats */
  try {
    const sv = parseFloat(localStorage.getItem('telg-volume'));
    if (sv >= 0 && sv <= 1) state.volume = sv;
    const sb = JSON.parse(localStorage.getItem('telg-bookmarks') || '[]');
    if (Array.isArray(sb)) state.bookmarks = sb;
    state.stats = loadStats();
  } catch (e) {}
  renderToday();
  const pbAudio = document.getElementById('pb-audio');
  if (pbAudio) {
    pbAudio.addEventListener('error', () => {
      if (state.playing) {
        state.playing = false; setPlayIcon(false);
        showSynthError(new Error('Audio file unavailable (missing or corrupted) — re-synthesize to restore playback.'));
      }
    });
  }
  const extra = document.createElement('style');
  extra.textContent = '.preset-tag.active-filter{background:var(--surface-high);color:var(--on-surface);border:1px solid var(--line-strong)}' +
    '.pb-loop-btn.on{background:color-mix(in srgb, var(--primary) 12%, transparent)}' +
    '.pb-seek:hover #pb-thumb{opacity:1}' +
    '.trow.active .trow-en{color:var(--on-surface)}' +
    '.q-opt.correct{outline:1px solid var(--primary-dim)}';
  document.head.appendChild(extra);
  try {
    const cfg = JSON.parse(localStorage.getItem('telg-settings') || 'null');
    $('cfg-llm-provider').innerHTML = Object.keys(PROVIDER_LABELS).map(k =>
      '<option value="' + k + '">' + escapeHtml(PROVIDER_LABELS[k]) + '</option>').join('');
    if (cfg && cfg.llm) {
      let llmProvider = cfg.llm.provider;
      if (LLM_PRESET_LEGACY[llmProvider]) llmProvider = LLM_PRESET_LEGACY[llmProvider];
      if (!(llmProvider in LLM_PRESETS)) llmProvider = 'custom';
      $('cfg-llm-provider').value = llmProvider;
      $('cfg-llm-model').value = cfg.llm.model; $('cfg-llm-base').value = cfg.llm.baseUrl; $('cfg-llm-key').value = cfg.llm.apiKey;
      const ttsProv = normalizeTTSProvider(cfg.tts.provider);
      $('cfg-tts-provider').value = ttsProv;
      loadTTSVoices(ttsProv).then(() => renderVoiceRoles(sanitizeRolesForProvider(cfg.tts.voices || (cfg.tts.voice ? String(cfg.tts.voice).split(' + ') : null), ttsProv)));
      if (cfg.llm.temperature) { $('cfg-llm-temp').value = cfg.llm.temperature; const tv = $('cfg-temp-val'); if (tv) tv.textContent = cfg.llm.temperature; }
      if (cfg.tts.speechRate) $('cfg-tts-rate').value = cfg.tts.speechRate;
    }
  } catch (e) {}
  state.current = state.library[0];
  loadSettings();
  applyDebugStates();
  applyTheme();
  applyLang();
  updateEngineBadge();
  updateSeekStep();
  renderMaterial();
  renderPlaylists();
  renderPlayerBar();
  updateDiff();
  updateLen();
  initFold();
  initResize();
  updateDepth();
  watchMTab();
  const cfgTTS = $('cfg-tts-provider');
  if (cfgTTS) cfgTTS.addEventListener('change', () => onProviderChange('cfg'));
  const adjTTS = $('adj-tts-provider');
  if (adjTTS) adjTTS.addEventListener('change', () => onProviderChange('adj'));
  $('cfg-llm-provider').addEventListener('change', () => {
    const sel = $('cfg-llm-provider').value;
    const pr = LLM_PRESETS[sel];
    if (pr) { $('cfg-llm-base').value = pr.base; $('cfg-llm-model').value = pr.model; }
    else if (sel === 'custom') { $('cfg-llm-base').value = ''; $('cfg-llm-model').value = ''; }
  });

  const _ctxInp = $('gen-context');
  if (_ctxInp) _ctxInp.addEventListener('input', updateGenerateBtn);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onClick);
  document.addEventListener('input', onClick);
  document.addEventListener('keydown', onKey);
  document.addEventListener('focusout', (e) => {
    const t = e.target;
    if (!t || !t.classList || !t.dataset) return;
    if (t.classList.contains('lib-rename-input')) {
      if (t.dataset.done) return;
      t.dataset.done = '1';
      commitRename(t.dataset.rid, t.value);
      return;
    }
    if (t.classList.contains('pl-rename-input')) {
      if (t.dataset.done) return;
      t.dataset.done = '1';
      if (t.dataset.rid) commitPlRename(t.dataset.rid, t.value);
      else if (t.dataset.plCreate) commitPlCreate(t.value);
    }
  });
  document.querySelector('.inspector').classList.add('hidden');
  syncDetailBtn();
  decorateTips();
  bootLive();
}
async function bootLive() {
  try {
    const mats = await API.listMaterials();
    if (mats && mats.length) {
      /* Never hijack a library the user has already populated (e.g. a material
         generated while this async boot is still in flight) — seed only on first load. */
      if (!state.library || !state.library.length) state.library = mats;
      if (!state.current) state.current = mats[0];
    }
    try {
      const pls = await API.listPlaylists();
      if (pls && pls.length) state.playlists = pls;
    } catch (e) {}
    renderMaterial(); renderLibrary(); renderPlaylists(); renderPlayerBar(); renderToday();
  } catch (err) {
    console.warn('TELG live backend unavailable:', err);
    showToast('Backend unavailable at ' + CONFIG.apiBase + ' — start uvicorn and reload, or enable Test Data in Developer settings', 'error');
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

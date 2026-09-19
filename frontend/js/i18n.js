function applyLang() {
  document.documentElement.lang = state.lang;
  const dict = I18N[state.lang] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const t = dict[el.dataset.i18n];
    if (t !== undefined) el.textContent = t;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const t = dict[el.dataset.i18nPh];
    if (t !== undefined) el.placeholder = t;
  });
  /* JS-rendered texts (level descriptors) must follow the language too */
  try { if (typeof updateDiff === 'function') updateDiff(); if (typeof updateLen === 'function') updateLen(); if (typeof updateDepth === 'function') updateDepth(); } catch (e) {}
  try { decorateTips(); } catch (e) {}
}

/* ---------------- SETTINGS persistence ---------------- */
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('telg-settings') || 'null');
    if (!s) return;
    if (s.lang === 'zh' || s.lang === 'en') state.lang = s.lang;
    if (s.theme === 'dark' || s.theme === 'light') state.theme = s.theme;
    const si = CONFIG.speeds.indexOf(parseFloat(s.defSpeed));
    if (si >= 0) state.speedIdx = si;
    const ss = parseInt(s.seekStep, 10);
    if ([5, 10, 15, 30].includes(ss)) state.seekStep = ss;
    const gm = parseInt(s.goalMin, 10);
    if ([15, 30, 45, 60, 90].includes(gm)) state.goalMin = gm;
    state.zhVisible = s.zhDefault !== 'off';
    state.narrVoice = s.narrVoice || 'en-US-JennyNeural';
  } catch (e) {}
}
function updateSeekStep() {
  const s = state.seekStep;
  const b = $('pb-back-num'), f = $('pb-fwd-num');
  if (b) b.textContent = s;
  if (f) f.textContent = s;
  const bb = $('btn-pb-back10'); if (bb) bb.title = 'Rewind ' + s + 's';
  const ff = $('btn-pb-fwd10'); if (ff) ff.title = 'Forward ' + s + 's';
}
function applyTranscriptLang() {
  const blind = state.listenMode === 'blind';
  document.querySelectorAll('#transcript-list .trow-zh').forEach(el => {
    /* In blind mode the zh row keeps its layout slot (opacity-driven via
       .blind-mode.zh-on), so display must stay '' there; otherwise the CN
       toggle controls visibility through display:none as before. */
    el.style.display = blind ? '' : (state.zhVisible ? '' : 'none');
  });
  /* 剧情引子卡：跟随翻译按键（zh 开→中英两行；关→仅英文），豁免盲听（不模糊不隐藏） */
  const ov = $('overview-card');
  if (ov) {
    const zh = ov.querySelector('.ov-zh');
    if (zh) zh.style.display = state.zhVisible ? '' : 'none';
  }
  /* 词汇卡片：跟随翻译按键（zh 开→显示中文术语和中文释义；关→只显示英文术语和英文释义） */
  document.querySelectorAll('.vocab-card .vocab-zh, .vocab-card .vocab-def-zh').forEach(el => {
    el.style.display = state.zhVisible ? '' : 'none';
  });
  const pane = $('transcript-pane'); if (pane) pane.classList.toggle('zh-on', state.zhVisible);
  const ins = $('inspector'); if (ins) ins.classList.toggle('zh-off', !state.zhVisible);
  $('btn-zh-toggle').classList.toggle('on', state.zhVisible);
}

/* ---------------- RENDER: theme ---------------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('btn-theme').innerHTML = '<svg class="icon"><use href="#i-' + (state.theme === 'dark' ? 'moon' : 'sun') + '"/></svg>';
}
function setTheme(t) {
  if (t === 'dark' || t === 'light') { state.theme = t; applyTheme(); }
}
/* ---------- sidebar / inspector fold & resize ---------- */
function readUI() { try { return JSON.parse(localStorage.getItem('telg-ui') || '{}'); } catch (e) { return {}; } }
function saveUI(patch) { try { const u = readUI(); Object.assign(u, patch); localStorage.setItem('telg-ui', JSON.stringify(u)); } catch (e) {} }
function toggleLibCollapsed() {
  const el = $('lib-sidebar');
  if (!el) return;
  const collapsed = el.classList.toggle('collapsed');
  saveUI({ libCollapsed: collapsed });
}
function initFold() {
  const ui = readUI();
  const lib = $('lib-sidebar'), ins = $('inspector');
  if (ui.libCollapsed) lib.classList.add('collapsed');
  if (ui.libW) lib.style.width = ui.libW + 'px';
  if (ui.insW) ins.style.width = ui.insW + 'px';
}
function initResize() {
  const bind = (handleId, targetId, dir) => {
    const h = $(handleId); if (!h) return;
    h.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const target = $(targetId);
      const startX = e.clientX, startW = target.offsetWidth;
      document.body.classList.add('resizing');
      const onMove = (ev) => {
        let w = dir === 'l' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX);
        w = Math.max(220, Math.min(520, Math.round(w)));
        target.style.width = w + 'px';
        saveUI(targetId === 'lib-sidebar' ? { libW: w } : { insW: w });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('resizing');
      };
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    });
  };
  bind('lib-resize', 'lib-sidebar', 'l');
  bind('ins-resize', 'inspector', 'r');
}
/* ---------- rename current material ---------- */
function startRenameHead() {
  const art = currentArtifact(); if (!art) return;
  openRenameModal(
    state.lang==="zh" ? "重命名素材" : "Rename material",
    art.meta.title,
    (v) => {
      if (!v || v === art.meta.title) return;
      if (titleTaken(art.id, v)) { showToast(I18N[state.lang]["lib.nameExists"], "warn"); return; }
      art.meta.title = v;
      const m = state.library.find(x => x.id === art.id);
      if (m) m.meta.title = v;
      API.patchMaterial(art.id, { title: v }).catch(() => {});
      showToast(I18N[state.lang]["lib.renamed"] + v);
      renderMaterial(); renderLibrary(); renderPlayerBar();
    }
  );
}

function startRenameHeadOld() {
  const art = currentArtifact(); if (!art) return;
  const titleEl = $('m-title'); if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'title-edit'; input.value = art.meta.title;
  titleEl.style.display = 'none';
  titleEl.parentElement.insertBefore(input, titleEl.nextSibling);
  input.focus(); input.select();
  let done = false;
  const restore = () => { titleEl.style.display = ''; if (input.parentElement) input.remove(); };
  const commit = () => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (v && v !== art.meta.title) {
      if (titleTaken(art.id, v)) {
        showToast(I18N[state.lang]['lib.nameExists'], 'warn');
        restore();                         /* 重名：不提交，还原原标题 */
        return;
      }
      art.meta.title = v;
      const m = state.library.find(x => x.id === art.id);
      if (m) m.meta.title = v;
      API.patchMaterial(art.id, { title: v }).catch(() => {});
      showToast(I18N[state.lang]['lib.renamed'] + v);
      restore();
      renderMaterial(); renderLibrary(); renderPlayerBar();
    } else {
      restore();
      renderMaterial();
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { done = true; restore(); } });
  input.addEventListener('blur', commit);
}
/* ---------- TTS voice roles ---------- */
const TTS_VOICES = ['en-US-GuyNeural','en-US-JennyNeural','en-US-ChristopherNeural','en-US-EricNeural','en-US-AriaNeural','en-US-MichelleNeural','en-US-RogerNeural','en-US-SteffanNeural','en-US-AnaNeural','en-US-BrianNeural','en-GB-SoniaNeural','en-GB-RyanNeural','en-AU-NatashaNeural','en-AU-WilliamNeural'];
const KOKORO_VOICES_FALLBACK = [
  { id: 'af_bella', label: 'Bella', lang: 'en-us' }, { id: 'af_heart', label: 'Heart', lang: 'en-us' },
  { id: 'af_nova', label: 'Nova', lang: 'en-us' }, { id: 'af_sarah', label: 'Sarah', lang: 'en-us' },
  { id: 'af_nicole', label: 'Nicole', lang: 'en-us' }, { id: 'am_michael', label: 'Michael', lang: 'en-us' },
  { id: 'am_fenrir', label: 'Fenrir', lang: 'en-us' }, { id: 'am_onyx', label: 'Onyx', lang: 'en-us' },
  { id: 'bf_emma', label: 'Emma', lang: 'en-gb' }, { id: 'bm_george', label: 'George', lang: 'en-gb' },
  { id: 'zf_xiaobei', label: 'Xiaobei', lang: 'zh' }, { id: 'zf_xiaoni', label: 'Xiaoni', lang: 'zh' },
  { id: 'zf_xiaoxiao', label: 'Xiaoxiao', lang: 'zh' }, { id: 'zf_xiaoyi', label: 'Xiaoyi', lang: 'zh' },
  { id: 'zf_xiaomo', label: 'Xiaomo', lang: 'zh' }
];
function normalizeTTSProvider(v) {
  v = String(v || 'edge-tts');
  if (/kokoro/i.test(v)) return 'kokoro';
  if (/cosyvoice/i.test(v)) return 'cosyvoice';
  return 'edge-tts';
}
function ttsProvider() {
  const el = $('cfg-tts-provider');
  return normalizeTTSProvider(el ? el.value : 'edge-tts');
}
function ttsVoicePool(provider) {
  const p = normalizeTTSProvider(provider || ttsProvider());
  const cached = state.ttsVoicesByProvider[p];
  if (cached && cached.length) return cached;
  return p === 'kokoro' ? KOKORO_VOICES_FALLBACK : TTS_VOICES;
}
function ttsDefaultRoles(provider) {
  const p = normalizeTTSProvider(provider || ttsProvider());
  if (p === 'kokoro') return [{ name: 'Speaker A', voice: 'af_bella' }, { name: 'Speaker B', voice: 'af_heart' }];
  return [{ name: 'Speaker A', voice: 'en-US-GuyNeural' }, { name: 'Speaker B', voice: 'en-US-JennyNeural' }];
}
function ttsVoiceLabel(id, provider) {
  const pool = ttsVoicePool(provider);
  for (const o of pool) {
    const oid = typeof o === 'string' ? o : o.id;
    if (oid === id) return typeof o === 'string' ? o : o.label;
  }
  return id;
}
function adjTTSProvider() {
  const el = $('adj-tts-provider');
  return normalizeTTSProvider(el ? el.value : ttsProvider());
}
async function onProviderChange(kind) {
  const el = kind === 'adj' ? $('adj-tts-provider') : $('cfg-tts-provider');
  const p = normalizeTTSProvider(el ? el.value : 'edge-tts');
  /* render immediately with the fallback pool so the UI never lags the switch,
     then refresh roles once the live voice list arrives */
  if (kind === 'adj') renderAdjustVoiceRoles(sanitizeRolesForProvider(currentAdjustVoiceRoles(), p));
  else { renderVoiceRoles(sanitizeRolesForProvider(currentVoiceRoles(), p)); renderNarrVoiceSelect(p); }
  await loadTTSVoices(p, () => {
    if (kind === 'adj') renderAdjustVoiceRoles(sanitizeRolesForProvider(currentAdjustVoiceRoles(), p));
    else { renderVoiceRoles(sanitizeRolesForProvider(currentVoiceRoles(), p)); renderNarrVoiceSelect(p); }
  });
}
async function loadTTSVoices(provider, thenApply) {
  const p = normalizeTTSProvider(provider);
  try {
    const r = await API.voices(p);
    if (r && r.ok && Array.isArray(r.voices) && r.voices.length) state.ttsVoicesByProvider[p] = r.voices;
  } catch (e) {}
  if (thenApply) thenApply();
}
function sanitizeRolesForProvider(roles, provider) {
  const pool = ttsVoicePool(provider);
  const defs = ttsDefaultRoles(provider);
  return (Array.isArray(roles) && roles.length ? roles : defs).map((r, i) => {
    const name = (r && typeof r === 'object' ? r.name : '') || defs[i % defs.length].name;
    const v = typeof r === 'string' ? r : (r && r.voice);
    const ok = pool.some(o => (typeof o === 'string' ? o : o.id) === v);
    return { name: name, voice: ok ? v : defs[i % defs.length].voice };
  });
}
function roleRowHTML(r, provider) {
  const p = normalizeTTSProvider(provider || ttsProvider());
  const name = (r && typeof r === 'object') ? String(r.name || '') : '';
  const v = (r && typeof r === 'object') ? r.voice : r;
  const opts = ttsVoicePool(p).map(o => {
    const oid = typeof o === 'string' ? o : o.id;
    const label = typeof o === 'string' ? o : (o.label + (o.lang && o.lang !== 'en-us' ? ' · ' + o.lang : ''));
    return '<option value="' + oid + '"' + (oid === v ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');
  return '<div class="voice-role-row">' +
    '<input class="role-name" value="' + escapeHtml(name) + '" placeholder="' + I18N[state.lang]['settings.tts.roleName'] + '"/>' +
    '<div class="select-wrap"><select class="select">' + opts + '</select><svg class="icon icon-sm select-arrow"><use href="#i-chevron-down"/></svg></div>' +
    '<button class="btn-role-test" title="' + I18N[state.lang]['settings.tts.audition'] + '"><svg class="icon"><use href="#i-play"/></svg></button>' +
    '<button class="btn-role-del" title="' + I18N[state.lang]['settings.tts.delRole'] + '"><svg class="icon"><use href="#i-close"/></svg></button>' +
  '</div>';
}
function currentVoiceRoles() {
  const box = $('voice-roles');
  if (!box) return [];
  return Array.from(box.querySelectorAll('.voice-role-row')).map(row => ({
    name: (row.querySelector('.role-name') || { value: '' }).value.trim(),
    voice: row.querySelector('select') ? row.querySelector('select').value : ''
  }));
}
function renderVoiceRoles(voices) {
  const box = $('voice-roles'); if (!box) return;
  const p = ttsProvider();
  const list = sanitizeRolesForProvider((voices && voices.length) ? voices : null, p);
  box.innerHTML = list.map((r, i) => {
    if (typeof r === 'string') r = { name: 'Speaker ' + String.fromCharCode(65 + i), voice: r };
    return roleRowHTML(r, p);
  }).join('');
}
function renderNarrVoiceSelect(provider) {
  const sel = $('cfg-narr-voice');
  if (!sel) return;
  const p = normalizeTTSProvider(provider || ttsProvider());
  const pool = ttsVoicePool(p);
  const cur = state.narrVoice || 'en-US-JennyNeural';
  sel.innerHTML = pool.map(v => {
    const id = typeof v === 'string' ? v : (v && v.id);
    if (!id) return '';
    const label = ttsVoiceLabel(id, p);
    return '<option value="' + escapeHtml(id) + '"' + (id === cur ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }).join('');
  if (!sel.value && pool.length) sel.value = (typeof pool[0] === 'string' ? pool[0] : pool[0].id);
}
function addVoiceRole() {
  const cur = currentVoiceRoles();
  const used = new Set(cur.map(x => x.voice));
  const pool = ttsVoicePool();
  const found = pool.find(o => !used.has(typeof o === 'string' ? o : o.id));
  const next = typeof found === 'object' ? found.id : (found || 'af_bella');
  const idx = cur.length;
  renderVoiceRoles(cur.concat([{ name: 'Speaker ' + String.fromCharCode(65 + idx), voice: next }]));
}
function delVoiceRole(btn) {
  const row = btn.closest('.voice-role-row'); if (!row) return;
  if (currentVoiceRoles().length <= 1) return;
  row.remove();
}
async function prewarmTTS(provider, text, rate, exclude, boxSel) {
  const box = document.querySelector(boxSel); if (!box) return;
  const voices = [...box.querySelectorAll('.voice-role-row')]
    .map(r => r.querySelector('select') ? r.querySelector('select').value : '')
    .filter(v => v && v !== exclude);
  for (const v of voices.slice(0, 2)) {
    try { await API.testTTS({ provider, voice: v, speech_rate: rate, style: '', text: text || undefined }); } catch (e) {}
  }
}
async function auditionRole(btn) {
  const row = btn.closest('.voice-role-row'); if (!row) return;
  const voice = row.querySelector('select') ? row.querySelector('select').value : '';
  const res = $('tts-test-result'), aud = $('tts-audio');
  if (!res) return;
  res.className = 'test-output'; res.textContent = '…';
  document.querySelectorAll('.btn-role-test.played').forEach(b => b.classList.remove('played'));
  btn.classList.add('loading');
  if (aud) { aud.pause(); aud.onended = null; aud.removeAttribute('src'); }
  const txt = $('cfg-tts-test-text') ? $('cfg-tts-test-text').value.trim() : '';
  try {
    const r = await API.testTTS({ provider: $('cfg-tts-provider').value, voice, speech_rate: parseFloat($('cfg-tts-rate').value), style: '', text: txt || undefined });
    if (r.ok) {
      res.className = 'test-output ok';
      res.textContent = I18N[state.lang]['settings.tts.ok'] + ' · ' + ttsVoiceLabel(voice) + (r.audio_url ? '' : ' · Mock');
      if (r.audio_url && aud) {
        aud.src = r.audio_url;
        aud.onended = () => btn.classList.remove('played');
        aud.play().then(() => btn.classList.add('played')).catch(() => {});
      }
      /* Pre-synthesize the other roles of this panel in the background so
         switching roles plays instantly (backend cache serves the repeat). */
      prewarmTTS($('cfg-tts-provider').value, txt, parseFloat($('cfg-tts-rate').value), voice, '#voice-roles').catch(() => {});
      prewarmAuditions($('cfg-tts-provider').value, parseFloat($('cfg-tts-rate').value), '', txt, voice, '#voice-roles');
    } else { res.className = 'test-output err'; res.textContent = ttsFriendlyError(r.error_class, r.error); }
  } catch (e) { res.className = 'test-output err'; res.textContent = ttsFriendlyError('other', e.message); }
  btn.classList.remove('loading');
}
/* After one role finishes, silently pre-synthesise the same text for the
   other roles (Kokoro only — local & free) so switching roles feels instant:
   each follow-up audition hits the backend cache instead of re-synthesising. */
function prewarmAuditions(provider, rate, style, text, skipVoice, rowsSelector) {
  if (normalizeTTSProvider(provider) !== 'kokoro') return;
  const rows = Array.from(document.querySelectorAll(rowsSelector + ' .voice-role-row'));
  const seen = new Set(), voices = [];
  rows.forEach(r => {
    const s = r.querySelector('select'); if (!s) return;
    const v = s.value;
    if (v && v !== skipVoice && !seen.has(v)) { seen.add(v); voices.push(v); }
  });
  if (!voices.length) return;
  let i = 0;
  (function next() {
    if (i >= voices.length) return;
    const v = voices[i++];
    API.testTTS({ provider, voice: v, speech_rate: rate || 1.0, style, text: text || undefined })
      .catch(() => {})
      .finally(next);
  })();
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('telg-theme', state.theme); } catch (e) {}
  applyTheme();
}

/* ---------------- LOCAL ACCOUNT (AuthAPI) & WELCOME / ONBOARDING ---------------- */
const AuthAPI = {
  _key: 'telg-auth',
  _read() { try { return JSON.parse(localStorage.getItem(this._key) || 'null') || null; } catch (e) { return null; } },
  _write(a) { try { localStorage.setItem(this._key, JSON.stringify(a)); } catch (e) {} },
  async _hash(salt, pw) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '::' + pw));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      let h = 0; const t = salt + '::' + pw;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      return 'f' + h.toString(16);
    }
  },
  async register(_a) {
    const username = (_a && _a.username || '').trim();
    const password = _a && _a.password || '';
    if (!username) return { ok: false, error: I18N[state.lang]['welcome.needUser'] };
    if (password.length < 4) return { ok: false, error: I18N[state.lang]['welcome.pwShort'] };
    if (this._read()) return { ok: false, error: I18N[state.lang]['welcome.hasAccount'] };
    const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const acc = { username, salt, passHash: await this._hash(salt, password), created_at: Date.now(), session: true };
    this._write(acc);
    return { ok: true, user: { username } };
  },
  async login(_a) {
    const username = (_a && _a.username || '').trim();
    const password = _a && _a.password || '';
    const acc = this._read();
    if (!acc) return { ok: false, error: I18N[state.lang]['welcome.noAccount'] };
    if (acc.username !== username) return { ok: false, error: I18N[state.lang]['welcome.wrongUser'] };
    if ((await this._hash(acc.salt, password)) !== acc.passHash) return { ok: false, error: I18N[state.lang]['welcome.wrongPw'] };
    acc.session = true; this._write(acc);
    return { ok: true, user: { username: acc.username } };
  },
  async logout() { const a = this._read(); if (a) { a.session = false; this._write(a); } return { ok: true }; },
  current() { const a = this._read(); return (a && a.session) ? { username: a.username } : null; },
  exists() { return !!this._read(); }
};
let wlMode = 'register';
function showWelcome() {
  wlMode = AuthAPI.exists() ? 'login' : 'register';
  renderWelcome();
  $('welcome-modal').classList.remove('hidden');
  $('wl-username').focus();
}
function renderWelcome() {
  const L = I18N[state.lang];
  const isReg = wlMode === 'register';
  $('welcome-title').textContent = 'Technical Listening';
  $('welcome-sub').textContent = isReg ? L['welcome.sub'] : L['welcome.subLogin'];
  $('wl-pass2-label').style.display = isReg ? '' : 'none';
  $('wl-pass2').style.display = isReg ? '' : 'none';
  $('btn-wl-primary').textContent = isReg ? L['welcome.create'] : L['welcome.login'];
  $('btn-wl-switch').textContent = isReg ? L['welcome.switch'] : L['welcome.switchLogin'];
  $('wl-err').textContent = '';
  $('wl-password').value = ''; $('wl-pass2').value = '';
}
async function welcomePrimary() {
  const u = $('wl-username').value.trim(), p = $('wl-password').value, p2 = $('wl-pass2').value;
  if (wlMode === 'register' && p !== p2) { $('wl-err').textContent = I18N[state.lang]['welcome.pwMismatch']; return; }
  const r = wlMode === 'register' ? await AuthAPI.register({ username: u, password: p }) : await AuthAPI.login({ username: u, password: p });
  if (!r.ok) { $('wl-err').textContent = r.error; return; }
  state.user = r.user;
  $('welcome-modal').classList.add('hidden');
  refreshAboutAccount();
  const ob = readOnboarding();
  if (!ob.done) enterOnboarding();
}
function welcomeGuest() {
  state.user = null;
  $('welcome-modal').classList.add('hidden');
  refreshAboutAccount();
  const ob = readOnboarding();
  if (!ob.done) enterOnboarding();
}
function readOnboarding() { try { return JSON.parse(localStorage.getItem('telg-onboarding') || 'null') || {}; } catch (e) { return {}; } }
function writeOnboarding(o) { try { localStorage.setItem('telg-onboarding', JSON.stringify(o)); } catch (e) {} }
/* ---- onboarding state machine: [llm] -> [survey x5] -> [profile] ---- */
const OB_STEPS = ['llm', 'survey', 'profile'];
let obIdx = 0, obSub = 0;
let obSurvey = { role: '', domain: '', language: 'en-zh', minutes: 30 };
function enterOnboarding() {
  obIdx = 0; obSub = 0;
  obSurvey = { role: '', domain: '', language: 'en-zh', minutes: 30 };
  $('onboard-modal').classList.remove('hidden');
  renderObStep();
}
function closeOnboarding(done) {
  $('onboard-modal').classList.add('hidden');
  if (done) { writeOnboarding({ done: true, at: Date.now() }); showToast(I18N[state.lang]['welcome.ready']); }
}
function renderObStep() {
  $('ob-step-dots').innerHTML = OB_STEPS.map((_, i) => '<div class="dot' + (i <= obIdx ? ' on' : '') + '"></div>').join('');
  $('ob-back').classList.toggle('hidden', obIdx === 0 && obSub === 0);
  if (obIdx === 0) renderObLLM();
  else if (obIdx === 1) renderObSurvey();
  else renderObProfile();
}
function llmReadyState() {
  const s = readStoredCfg().llm || {};
  const base = (s.baseUrl || '').trim(), key = (s.apiKey || '').trim();
  return { ready: !!(base && key), label: (s.provider || 'LLM') + ' · ' + (s.model || '') };
}
function obLlmStored() {
  const s = readStoredCfg().llm || {};
  return { provider: s.provider || 'deepseek', base_url: s.baseUrl || '', api_key: s.apiKey || '', model: s.model || '' };
}

function renderObLLM() {
  const L = I18N[state.lang];
  state.obLlmOk = false;
  $('ob-title').textContent = L['ob.llmTitle'];
  $('ob-sub').textContent = L['ob.llmSub'];
  const llm = obLlmStored();
  const pr = LLM_PRESETS[llm.provider] || {};
  const baseVal = llm.base_url || pr.base || '', modelVal = llm.model || pr.model || '';
  const opts = Object.keys(PROVIDER_LABELS).map(k => '<option value="' + k + '"' + (k === llm.provider ? ' selected' : '') + '>' + escapeHtml(PROVIDER_LABELS[k] || k) + '</option>').join('');
  $('ob-body').innerHTML =
    '<div class="ob-llm-form">' +
      '<div class="s-row"><div class="s-info"><div class="s-name">' + L['ob.llmProvider'] + '</div></div>' +
        '<div class="s-ctrl"><div class="select-wrap"><select class="select" id="ob-llm-provider">' + opts + '</select><svg class="icon icon-sm select-arrow"><use href="#i-chevron-down"/></svg></div></div></div>' +
      '<div class="s-row"><div class="s-info"><div class="s-name">' + L['ob.llmModel'] + '</div></div>' +
        '<div class="s-ctrl"><input class="input" id="ob-llm-model" value="' + escapeHtml(modelVal) + '" placeholder="model"/></div></div>' +
      '<div class="s-row"><div class="s-info"><div class="s-name">' + L['ob.llmBase'] + '</div></div>' +
        '<div class="s-ctrl"><input class="input" id="ob-llm-base" value="' + escapeHtml(baseVal) + '" placeholder="base_url"/></div></div>' +
      '<div class="s-row"><div class="s-info"><div class="s-name">' + L['ob.llmKey'] + '</div></div>' +
        '<div class="s-ctrl"><div class="input-group"><input class="input" id="ob-llm-key" type="password" value="' + escapeHtml(llm.api_key || '') + '" placeholder="api_key"/><button type="button" class="eye-btn" id="ob-key-eye"><svg class="icon icon-sm"><use href="#i-eye"/></svg></button></div></div></div>' +
      '<div class="s-row"><div class="s-info"><div class="s-name">' + L['ob.llmTest'] + '</div></div>' +
        '<div class="s-ctrl"><button class="btn btn-sm" id="ob-test-llm">' + L['ob.llmTest'] + '</button></div></div>' +
      '<div class="test-output" id="ob-llm-result"></div>' +
      '<div class="t-10 dim" style="line-height:1.6">' + L['ob.llmNextHint'] + '</div>' +
    '</div>' +
    '<div style="margin-top:12px;text-align:center"><button class="btn btn-ghost btn-sm" id="ob-skip-llm">' + L['ob.llmSkip'] + '</button></div>';
  $('ob-next').disabled = true;
  $('ob-next').classList.remove('hidden');
}
async function obTestLlm() {
  const L = I18N[state.lang];
  const btn = $('ob-test-llm'), res = $('ob-llm-result');
  btn.disabled = true; btn.textContent = L['ob.llmTesting'];
  res.className = 'test-output'; res.textContent = '…';
  let cfg = { provider: $('ob-llm-provider').value, base_url: $('ob-llm-base').value.trim(), api_key: $('ob-llm-key').value, model: $('ob-llm-model').value.trim(), temperature: 0.7 };
  const prf = LLM_PRESETS[cfg.provider] || {};
  if (!cfg.base_url) { cfg.base_url = prf.base || ''; $('ob-llm-base').value = cfg.base_url; }
  if (!cfg.model) { cfg.model = prf.model || ''; $('ob-llm-model').value = cfg.model; }
  try {
    const r = await API.testLLM(cfg);
    if (!r || r.ok !== true) throw new Error((r && r.error) || L['ob.llmTestFail']);
    state.obLlmOk = true;
    try { const st = JSON.parse(localStorage.getItem('telg-settings') || 'null') || {}; st.llm = { provider: cfg.provider, baseUrl: cfg.base_url, apiKey: cfg.api_key, model: cfg.model, temperature: 0.7 }; localStorage.setItem('telg-settings', JSON.stringify(st)); } catch (e) {}
    res.className = 'test-output ok'; res.textContent = L['ob.llmTestOk'];
    $('ob-next').disabled = false;
    updateEngineBadge();
    showToast(L['ob.llmTestOk'], 'ok');
  } catch (e) {
    state.obLlmOk = false;
    res.className = 'test-output err'; res.textContent = L['ob.llmTestFail'] + ': ' + e.message;
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = L['ob.llmTest'];
  }
}
const OB_CHIP_DEFS = {
  language: [['en-zh', 'ob.chipEnZh', ''], ['ja-zh', 'ob.chipJaZh', '1'], ['de-zh', 'ob.chipDeZh', '1'], ['fr-zh', 'ob.chipFrZh', '1']]
};
const OB_QS = [
  { key: 'role', label: 'ob.qRole', hint: 'ob.qRoleHint', id: 'ob-role' },
  { key: 'domain', label: 'ob.qDomain', hint: 'ob.qDomainHint', id: 'ob-domain' },
  { key: 'language', label: 'ob.qLang', hint: 'ob.qLangHint', seg: true },
  { key: 'minutes', label: 'ob.qMin', hint: 'ob.qMinHint', id: 'ob-min', min: true }
];
function renderObSurvey() {
  const L = I18N[state.lang];
  $('ob-title').textContent = L['ob.surveyTitle'];
  $('ob-sub').textContent = L['ob.surveySub'];
  const langDefs = OB_CHIP_DEFS.language || [];
  const chips = langDefs.map(d => {
    const val = d[0], wip = d[2];
    const active = obSurvey.language === val;
    const label = escapeHtml(L[d[1]] || d[1]) + (wip ? ' · ' + escapeHtml(L['ob.langWip']) : '');
    return '<button class="chip' + (active ? ' active' : '') + '"' + (wip ? ' disabled' : '') + ' data-val="' + escapeHtml(val) + '"' + (wip ? ' title="' + escapeHtml(L['ob.langWip']) + '"' : '') + '>' + label + '</button>';
  }).join('');
  $('ob-body').innerHTML = '<div class="ob-q">' +
    '<div class="ob-row"><div class="ob-lbl"><div class="ob-name">' + L['ob.qRole'] + '</div><div class="ob-desc">' + escapeHtml(L['ob.qRoleHint']) + '</div></div>' +
      '<div class="ob-ctrl"><input class="input" id="ob-role" placeholder="' + escapeHtml(L['ob.qRoleHint']) + '" value="' + escapeHtml(obSurvey.role || '') + '"/></div></div>' +
    '<div class="ob-row"><div class="ob-lbl"><div class="ob-name">' + L['ob.qDomain'] + '</div><div class="ob-desc">' + escapeHtml(L['ob.qDomainHint']) + '</div></div>' +
      '<div class="ob-ctrl"><input class="input" id="ob-domain" placeholder="' + escapeHtml(L['ob.qDomainHint']) + '" value="' + escapeHtml(obSurvey.domain || '') + '"/></div></div>' +
    '<div class="ob-row"><div class="ob-lbl"><div class="ob-name">' + L['ob.qLang'] + '</div><div class="ob-desc">' + escapeHtml(L['ob.qLangHint']) + '</div></div>' +
      '<div class="ob-ctrl"><div class="ob-chip-row" data-q="language" data-seg="1">' + chips + '</div></div></div>' +
    '<div class="ob-row"><div class="ob-lbl"><div class="ob-name">' + L['ob.qMin'] + '</div><div class="ob-desc">' + escapeHtml(L['ob.qMinHint']) + '</div></div>' +
      '<div class="ob-ctrl"><input class="input" id="ob-min" type="number" min="5" max="480" step="5" style="width:140px" placeholder="min" value="' + (obSurvey.minutes || '') + '"/></div></div>' +
    '</div>';
  $('ob-next').disabled = false;
  $('ob-next').classList.remove('hidden');
  $('ob-next').textContent = L['ob.confirm'];
  $('ob-back').classList.toggle('hidden', obIdx === 0);
  $('ob-back').textContent = L['welcome.back'];
}
function renderObProfile() {
  const L = I18N[state.lang];
  $('ob-title').textContent = L['ob.profileTitle'];
  $('ob-sub').textContent = L['ob.profileSub'];
  const s = obSurvey;
  const langLabel = { 'en-zh': L['ob.chipEnZh'], 'ja-zh': L['ob.chipJaZh'], 'de-zh': L['ob.chipDeZh'], 'fr-zh': L['ob.chipFrZh'] }[s.language] || s.language;
  $('ob-body').innerHTML = '<div class="ob-q">' +
    '<div class="t-12" style="line-height:1.7">' +
      '<b>' + L['ob.role'] + ':</b> ' + escapeHtml(s.role || '—') + '<br/>' +
      '<b>' + L['ob.domain'] + ':</b> ' + escapeHtml(s.domain || '—') + '<br/>' +
      '<b>' + L['ob.lang'] + ':</b> ' + escapeHtml(langLabel) + ' · <b>' + L['ob.min'] + ':</b> ' + s.minutes + ' min' +
    '</div>' +
    '<div class="t-11 dim">' + L['ob.profileHint'] + '</div>' +
    '<div id="ob-gen-result"></div>' +
    '<div class="t-10 dim" id="ob-gen-status" style="min-height:16px"></div>' +
    '<div style="display:flex;gap:8px">' +
      '<button class="btn btn-ghost btn-sm" id="ob-gen-profile">' + L['ob.genProfile'] + '</button>' +
    '</div></div>';
  $('ob-next').textContent = L['ob.finish'];
  $('ob-next').classList.add('hidden');
}
async function obGenProfile() {
  const L = I18N[state.lang];
  const st = $('ob-gen-status'); if (st) st.textContent = L['settings.profile.generating'];
  const payload = { role: obSurvey.role, domain: obSurvey.domain, language: obSurvey.language, scenarios: obSurvey.scenarios, focus: '', llm_config: buildLLMConfig() };
  try {
    const r = await apiFetch('/config/profile/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 120000);
    const box = $('ob-gen-result');
    box.innerHTML = '<div class="m-panel" style="padding:10px;margin-top:6px">' +
      '<div class="flabel" style="margin-bottom:4px">' + L['settings.profile.rolePortrait'] + '</div><textarea class="inp" id="ob-out-role" rows="2" style="width:100%">' + escapeHtml(r.role_portrait || '') + '</textarea>' +
      '<div class="flabel" style="margin:8px 0 4px">' + L['settings.profile.domainProfile'] + '</div><textarea class="inp" id="ob-out-domain" rows="3" style="width:100%">' + escapeHtml(r.domain_profile || '') + '</textarea>' +
      '<div class="flabel" style="margin:8px 0 4px">' + L['settings.profile.focusTone'] + '</div><textarea class="inp" id="ob-out-focus" rows="2" style="width:100%">' + escapeHtml(r.focus_tone || '') + '</textarea></div>';
    if (st) st.textContent = '';
    $('ob-next').classList.remove('hidden');
    $('ob-gen-profile').classList.add('hidden');
  } catch (e) {
    if (st) st.textContent = e.message;
    showToast(e.message, 'error');
  }
}
function obFinish() {
  const L = I18N[state.lang];
  /* persist survey answers */
  try { localStorage.setItem('telg-profile-answers', JSON.stringify(obSurvey)); } catch (e) {}
  /* daily minutes -> single source cfg-goal-min */
  try {
    const cfg = JSON.parse(localStorage.getItem('telg-settings') || 'null') || {};
    cfg.goalMin = String(obSurvey.minutes);
    localStorage.setItem('telg-settings', JSON.stringify(cfg));
    state.goalMin = parseInt(obSurvey.minutes, 10);
  } catch (e) {}
  /* profile */
  const genShown = !!(document.querySelector('#ob-out-role') || {}).value || false;
  const profile = {
    role: obSurvey.role, primaryDomain: obSurvey.domain, language: obSurvey.language,
    scenarios: [], focus: '',
    generated: genShown, rolePortrait: (document.querySelector('#ob-out-role') || {}).value || '',
    domainProfile: (document.querySelector('#ob-out-domain') || {}).value || '',
    focusTone: (document.querySelector('#ob-out-focus') || {}).value || ''
  };
  writeProfile(profile);
  renderToday(); updateEngineBadge();
  closeOnboarding(true);
  showToast(L['welcome.ready']);
  autoGenRecs();
}
function autoGenRecs() {
  try {
    const cfg = readStoredCfg() || {};
    const llm = cfg.llm || {};
    if (!(llm.apiKey || '').trim() || !(cfg.profile || {}).role) return;
    genRecs(true);
  } catch (e) {}
}
function obNext() {
  const L = I18N[state.lang];
  if (obIdx === 0) { if (state.obLlmOk) { obIdx = 1; obSub = 0; renderObStep(); } return; }
  if (obIdx === 1) {
    const role = $('ob-role').value.trim(), domain = $('ob-domain').value.trim(), minutes = parseInt($('ob-min').value, 10);
    if (!domain) { showToast(L['ob.needDomain'], 'warn'); return; }
    if (!(minutes > 0)) { showToast(L['ob.needMin'], 'warn'); return; }
    obSurvey.role = role; obSurvey.domain = domain; obSurvey.minutes = minutes;
    obIdx = 2; renderObProfile();
    return;
  }
  if (obIdx === 2) { obFinish(); }
}
function obBack() {
  if (obIdx === 2) { obIdx = 1; renderObSurvey(); return; }
  if (obIdx === 1) { obIdx = 0; renderObStep(); return; }
}
function refreshAboutAccount() {
  const desc = $('about-account-desc'), lg = $('btn-account-login'), lo = $('btn-account-logout');
  if (!desc) return;
  const u = AuthAPI.current();
  if (u) { desc.textContent = u.username + ' · signed in'; lg.classList.add('hidden'); lo.classList.remove('hidden'); }
  else if (AuthAPI.exists()) { desc.textContent = I18N[state.lang]['settings.about.signedOut']; lg.classList.remove('hidden'); lo.classList.add('hidden'); }
  else { desc.textContent = I18N[state.lang]['settings.about.guest']; lg.classList.remove('hidden'); lo.classList.add('hidden'); }
}
function initGate() {
  state.user = AuthAPI.current();
  refreshAboutAccount();
  const ob = readOnboarding();
  if (!ob.done) {
    /* Onboarding (welcome + setup) lives in its own file — same localStorage. */
    try { location.replace('onboarding.html'); } catch (e) {}
    return;
  }
}
/* ---------------- LEARNING PROFILE & DOMAIN PROFILES ---------------- */
const BUILTIN_DOMAINS = [
  { id: 'automotive', name: 'Automotive', builtin: true, desc: 'Vehicle dynamics · chassis control · ADAS / 车辆动力学、底盘控制、智能驾驶', inject: 'Terms: yaw rate, ESC, HIL bench, calibration…; Scenes: design review, failure analysis, road-test sign-off; Roles: System Lead, Controls, Calibration' },
  { id: 'semiconductor', name: 'Semiconductor', builtin: true, desc: 'Wafer fab · yield · process & equipment / 晶圆制造、良率、工艺与设备', inject: 'Terms: lithography, yield, etch, CMP, OOC…; Scenes: process review, failure analysis, equipment acceptance; Roles: Process Engineer, Yield Engineer, Equipment Vendor' },
  { id: 'energy', name: 'New Energy', builtin: true, desc: 'PV · storage · battery · power electronics / 光伏、储能、电池、电力电子', inject: 'Terms: SOC, BMS, inverter, DER, thermal runaway…; Scenes: grid interconnection review, battery testing, O&M; Roles: System Engineer, BMS Engineer, Grid Operator' },
  { id: 'ai-software', name: 'AI / Software', builtin: true, desc: 'Algorithms · architecture · MLOps / 算法、系统架构、MLOps', inject: 'Terms: inference, latency, drift, CI/CD, A/B test…; Scenes: code review, architecture discussion, incident response; Roles: Backend, MLE, SRE' },
  { id: 'medical', name: 'Medical Devices', builtin: true, desc: 'Active device R&D · validation · regulation / 有源医疗器械研发、验证与法规', inject: 'Terms: 510(k), ISO 14971, biocompatibility, sterilization…; Scenes: design validation, audit, compliance meeting; Roles: R&D Engineer, QA/RA, Clinical' },
  { id: 'fintech', name: 'FinTech', builtin: true, desc: 'Payments · risk · quant · core systems / 支付、风控、量化、金融系统', inject: 'Terms: settlement, fraud, VaR, reconciliation, clearing…; Scenes: risk review, go-live, audit; Roles: Platform Engineer, Risk Analyst, Quant' },
  { id: 'aerospace', name: 'Aerospace', builtin: true, desc: 'Flight control · avionics · airworthiness / 飞控、航电、适航与测试', inject: 'Terms: FCC, DO-178C, actuator, flight envelope…; Scenes: airworthiness review, flight test, integration; Roles: FCS Engineer, Avionics, Test Pilot' },
  { id: 'general', name: 'General Engineering', builtin: true, desc: 'Generic technical discussion / 通用工程与技术沟通', inject: '' }
];
/* Generate-panel options follow the learner profile (domain profiles,
   profile role, scenario preferences) instead of hard-coded defaults. */
const DOMAIN_SCENARIOS = {
  automotive: ['Technical Discussion & Trade-off', 'Root-Cause Failure RCA Meeting', 'Staff Systems Technical Interview'],
  semiconductor: ['Process Review Meeting', 'Yield Failure RCA', 'Equipment Acceptance & Sign-off'],
  energy: ['Grid Interconnection Review', 'Battery Testing & Validation', 'O&M Troubleshooting'],
  'ai-software': ['Architecture & Code Review', 'Incident Response Discussion', 'Technical Interview Loop'],
  medical: ['Design Validation Meeting', 'Regulatory Compliance Audit', 'Non-Conformance Review'],
  fintech: ['Risk Review & Go-live', 'Incident & Fraud Analysis', 'Architecture Audit'],
  aerospace: ['Airworthiness Review', 'Flight Test Debrief', 'Integration Meeting'],
  general: ['Technical Discussion & Trade-off', 'Root-Cause Analysis', 'Peer Review']
};
const SCENARIO_TAG_MAP = { interview: 'Staff Technical Interview', meeting: 'Technical Meeting & Discussion', collab: 'Cross-team Collaboration', supplier: 'Supplier Technical Review', class: 'Technical Class / Tutorial' };
function profileDomains() { return BUILTIN_DOMAINS; }

/* ================= v2 scene simulation (generator panel) ================= */
function genDomainCandidates() {
  const pf = readProfile() || {};
  const recs = recsOrEmpty();
  const out = [];
  const add = d => {
    if (!d) return;
    let id, name;
    if (typeof d === 'string') {
      /* normalize to a built-in entry when the string is a built-in id or name */
      const b = BUILTIN_DOMAINS.find(x => x.id === d || x.name === d);
      if (b) { id = b.id; name = b.name; }
      else { id = d; name = d; }
    } else { name = d.name || ''; id = d.id || name; }
    if (!name) return;
    if (!out.some(x => x.id === id || x.name === name)) out.push({ id: id, name: name });
  };
  (pf.domains || []).forEach(add);
  if (pf.primaryDomain) add(pf.primaryDomain);
  (recs && recs.domains ? recs.domains : []).forEach(add);
  /* no built-in presets — the pool is only what the user picked or added;
     built-ins stay available through the onboarding flow and name mapping */
  return out;
}
function genRoleCandidates() {
  const pf = readProfile() || {};
  const recs = recsOrEmpty();
  const out = [];
  const add = r => { if (r && String(r).trim() && !out.includes(r)) out.push(String(r).trim()); };
  /* only the user's own roles — no built-in presets; first-time users add
     their own speakers via the + Custom chip */
  (pf.roles || []).forEach(add);
  if (pf.role) add(pf.role);
  (recs && recs.roles ? recs.roles : []).forEach(add);
  return out;
}
function contextSuggestions(fmt, domain) {
  const L = I18N[state.lang];
  const key = fmt === 'solo' ? 'ctxSolo' : (fmt === 'dialogue' ? 'ctxDialogue' : 'ctxDiscussion');
  return ((L[key] || []).slice(0, 3));
}
function applyProfileToGenPanel() {
  const pf = readProfile() || {};
  const ds = genDomainCandidates();
  const want = (pf.domains && pf.domains.length) ? pf.domains[0] : (pf.primaryDomain || '');
  let sel = null;
  if (want) sel = ds.find(d => d.id === want || d.name === want) || null;
  if (!sel) sel = ds[0] || { id: 'general', name: 'General' };
  state.genScene.domain = { id: sel.id, name: sel.name };
  /* default roles from learning preferences — top up from the candidate pool
     so an untouched panel always submits a structurally valid request */
  const pfRoles = (pf.roles || []).filter(Boolean);
  const pool = genRoleCandidates();
  const fillRoles = n => { const arr = pfRoles.slice(); pool.forEach(r => { if (arr.length < n && !arr.includes(r)) arr.push(r); }); return arr.slice(0, n); };
  const fmt = state.genScene.format;
  if (fmt === 'solo') {
    state.genScene.roles = fillRoles(1);
  } else if (fmt === 'dialogue') {
    state.genScene.roles = fillRoles(2);
  } else {
    state.genScene.roles = fillRoles(state.genScene.speakerCount);
  }
  renderGenScene();
}

/* =========================================================
   V2 hover tooltips (field labels with data-tip)
   ========================================================= */
const tipEl = (() => {
  const d = document.createElement('div');
  d.id = 'telg-tip';
  d.className = 'tooltip';
  document.body.appendChild(d);
  return d;
})();
let tipAnchor = null;
function tipText(key) {
  const L = I18N[state.lang] || {};
  return (key && L[key]) || key || '';
}
function positionTip(anchor) {
  const r  = anchor.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));
  let top = r.bottom + 10;
  let above = false;
  if (top + th > window.innerHeight - 12) { top = r.top - th - 10; above = true; }
  tipEl.style.left = left + 'px';
  tipEl.style.top  = top + 'px';
  tipEl.classList.toggle('above', above);
  const ax = r.left + r.width / 2 - left;
  tipEl.style.setProperty('--arrow-x', Math.max(14, Math.min(tw - 14, ax)) + 'px');
}
function showTip(anchor) {
  tipAnchor = anchor;
  tipEl.textContent = tipText(anchor.dataset.tip);
  tipEl.classList.add('show');
  positionTip(anchor);
}
function hideTip() {
  tipAnchor = null;
  tipEl.classList.remove('show');
}
document.addEventListener('mouseover', e => {
  const t = e.target.closest('#gen-panel [data-tip], #adjust-modal [data-tip]');
  if (!t || t === tipAnchor) return;
  showTip(t);
});
document.addEventListener('mouseout', e => {
  const t = e.target.closest('#gen-panel [data-tip], #adjust-modal [data-tip]');
  if (!t) return;
  const to = e.relatedTarget;
  if (to && t.contains(to)) return;
  if (tipAnchor === t) hideTip();
});
document.addEventListener('mousedown', hideTip);
const HINT_SVG =
  '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.2" stroke-linecap="round">' +
  '<circle cx="6" cy="6" r="4.75"/>' +
  '<path d="M6 5.5v2.9"/>' +
  '<circle cx="6" cy="3.85" r="0.62" fill="currentColor" stroke="none"/>' +
  '</svg>';
function decorateTips() {
  document.querySelectorAll('#gen-panel [data-tip], #adjust-modal [data-tip]').forEach(el => {
    if (el.querySelector('.hint-ico')) return;
    const ico = document.createElement('span');
    ico.className = 'hint-ico';
    ico.innerHTML = HINT_SVG;
    el.appendChild(ico);
  });
}
function renderGenScene() {
  const L = I18N[state.lang];
  const sc = state.genScene;
  if (!$('fmt-seg')) return;
  document.querySelectorAll('#fmt-seg .seg-item').forEach(b => b.classList.toggle('active', b.dataset.fmt === sc.format));
  const hintEl = $('fmt-hint');
  if (hintEl) hintEl.textContent = L['gen.fmtHint' + ({ solo: 'Solo', dialogue: 'Dialogue', discussion: 'Discussion' }[sc.format])] || '';
  /* domain chips (single-select); delete badges are CSS-controlled, +Custom always at row end */
  const domMgr = $('btn-mgr-domains');
  if (domMgr) domMgr.classList.toggle('active', sc.manageDomains);
  const ds = genDomainCandidates();
  const customDom = '<button type="button" class="chip-add" data-key="domains"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 1.5v7M1.5 5h7"/></svg><span>' + escapeHtml(L['gen.custom'] || 'Custom') + '</span></button>';
  $('gen-domains').innerHTML = '<div class="chip-row' + (sc.manageDomains ? ' managing' : '') + '">' + ds.map(d => {
    const act = sc.domain && (d.id === sc.domain.id || d.name === sc.domain.name);
    return '<button type="button" class="chip' + (act ? ' active' : '') + '" data-domain="' + escapeHtml(d.name) + '">' + escapeHtml(d.name) +
      '<span class="chip-x" data-del-domain="' + escapeHtml(d.id) + '"><svg viewBox="0 0 8 8" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.9 1.9l4.2 4.2M6.1 1.9L1.9 6.1"/></svg></span></button>';
  }).join('') + customDom + '</div>';
  renderGenRoles();
  /* context input + suggestion chips */
  const ctxEl = $('gen-context');
  if (ctxEl && document.activeElement !== ctxEl) ctxEl.value = sc.context || '';
  const sugs = contextSuggestions(sc.format, sc.domain);
  updateGenerateBtn();
}
function renderGenRoles() {
  const wrap = $('gen-roles-wrap'); if (!wrap) return;
  const L = I18N[state.lang];
  const sc = state.genScene;
  const pool = genRoleCandidates();
  const customChip = '<button type="button" class="chip-add" data-key="roles"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 1.5v7M1.5 5h7"/></svg><span>' + escapeHtml(L['gen.custom'] || 'Custom') + '</span></button>';
  /* the +Custom chip is always visible at the end of the row */
  const customRow = customChip;
  /* in manage mode every chip gets a delete badge (CSS-controlled visibility) */
  const chipHTML = r => {
    return '<button type="button" class="chip' + (sc.roles.includes(r) ? ' active' : '') + '" data-role="' + escapeHtml(r) + '">' + escapeHtml(r) +
      '<span class="chip-x" data-del-role="' + escapeHtml(r) + '"><svg viewBox="0 0 8 8" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1.9 1.9l4.2 4.2M6.1 1.9L1.9 6.1"/></svg></span></button>';
  };
  let h = '<div class="chip-row' + (sc.manageRoles ? ' managing' : '') + '">' + pool.map(chipHTML).join('') + customRow + '</div>';
  wrap.innerHTML = h;
  const mgr = $('btn-mgr-roles');
  if (mgr) mgr.classList.toggle('active', sc.manageRoles);
  const hint = $('gen-role-hint');
  if (hint) {
    const key = { solo: 'gen.roleHintSolo', dialogue: 'gen.roleHintDialogue', discussion: 'gen.roleHint' }[sc.format] || 'gen.roleHint';
    hint.textContent = L[key] || '';
    hint.classList.add('show');
  }
}

function toggleGenRole(name) {
  const sc = state.genScene;
  if (sc.format === 'solo') {
    sc.roles = [name];
  } else if (sc.format === 'dialogue') {
    if (sc.roles.includes(name)) sc.roles = sc.roles.filter(r => r !== name);
    else if (sc.roles.length < 2) sc.roles.push(name);
    else sc.roles = [sc.roles[1], name];
  } else {
    /* discussion: candidates are a preference — multi-select, model picks the cast */
    if (sc.roles.includes(name)) sc.roles = sc.roles.filter(r => r !== name);
    else sc.roles.push(name);
  }
  renderGenScene();
}
function removeCustomDomain(id) {
  const recs = readRecs() || {};
  if (Array.isArray(recs.domains)) recs.domains = recs.domains.filter(d => !(d && String(d.id) === String(id)));
  writeRecs(recs);
  /* also drop from the onboarding profile if it lives there */
  const pf = readProfile() || {};
  if (Array.isArray(pf.domains)) pf.domains = pf.domains.filter(d => String(d) !== String(id));
  if (pf.primaryDomain && String(pf.primaryDomain) === String(id)) pf.primaryDomain = '';
  writeProfile(pf);
  if (state.genScene.domain && String(state.genScene.domain.id) === String(id)) {
    const ds = genDomainCandidates();
    const first = ds[0] || { id: 'general', name: 'General' };
    state.genScene.domain = { id: first.id, name: first.name };
  }
  renderGenScene();
  showToast(I18N[state.lang]['gen.removedRec'] || 'Removed', 'ok');
}
function removeCustomRole(name) {
  const recs = readRecs() || {};
  if (Array.isArray(recs.roles)) recs.roles = recs.roles.filter(r => r !== name);
  writeRecs(recs);
  const pf = readProfile() || {};
  if (Array.isArray(pf.roles)) pf.roles = pf.roles.filter(r => r !== name);
  if (pf.role && pf.role === name) pf.role = '';
  writeProfile(pf);
  state.genScene.roles = (state.genScene.roles || []).filter(r => r !== name);
  renderGenScene();
  showToast(I18N[state.lang]['gen.removedRec'] || 'Removed', 'ok');
}

/* ---------- quick add: custom domain / role / scenario ---------- */
let _qapCloseHandler = null;
function openQuickAdd(key, anchor) {
  closeQuickAdd();
  const L = I18N[state.lang];
  const wrap = document.createElement('div');
  wrap.className = 'quick-add-pop';
  wrap.innerHTML = '<div class="qap-title">' + escapeHtml(L['gen.addCustom']) + '</div>' +
    '<input type="text" maxlength="60" placeholder="' + escapeHtml(key === 'domains' ? 'e.g. Robotics Systems' : key === 'roles' ? 'e.g. Firmware Lead' : 'e.g. Factory Acceptance Test') + '"/>' +
    '<div class="qap-row"><button class="btn btn-sm qap-cancel">' + escapeHtml(L['settings.cancel'] || 'Cancel') + '</button><button class="btn btn-sm btn-primary qap-ok">' + escapeHtml(L['gen.add'] || 'Add') + '</button></div>';
  const r = anchor.getBoundingClientRect();
  wrap.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 140)) + 'px';
  wrap.style.left = Math.min(Math.max(8, r.left), window.innerWidth - 290) + 'px';
  document.body.appendChild(wrap);
  const inp = wrap.querySelector('input');
  const ok = wrap.querySelector('.qap-ok');
  const cancel = wrap.querySelector('.qap-cancel');
  const submit = () => { const v = inp.value.trim(); if (!v) { inp.focus(); return; } quickAddItem(key, v); closeQuickAdd(); };
  ok.textContent = L['gen.add'] || 'Add';
  ok.addEventListener('click', submit);
  cancel.addEventListener('click', closeQuickAdd);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') closeQuickAdd(); });
  setTimeout(() => { inp.focus(); _qapCloseHandler = (ev) => { if (!ev.target.closest('.quick-add-pop') && !ev.target.closest('.quick-add')) closeQuickAdd(); }; document.addEventListener('click', _qapCloseHandler); }, 0);
}
function closeQuickAdd() {
  if (_qapCloseHandler) { document.removeEventListener('click', _qapCloseHandler); _qapCloseHandler = null; }
  const p = document.querySelector('.quick-add-pop');
  if (p) p.remove();
}
function quickAddItem(key, name) {
  name = String(name || '').trim();
  if (!name) return;
  const L = I18N[state.lang];
  const recs = readRecs() || { domains: [], roles: [], scenarios: [] };
  if (!Array.isArray(recs.domains)) recs.domains = [];
  if (!Array.isArray(recs.roles)) recs.roles = [];
  if (!Array.isArray(recs.scenarios)) recs.scenarios = [];
  let dup = false;
  if (key === 'domains') {
    dup = recs.domains.some(d => d && d.name === name);
    if (!dup) {
      const nid = 'custom-' + Date.now();
      recs.domains.push({ id: nid, name: name, desc: '' });
      state.genScene.domain = { id: nid, name: name };
    }
  }
  else if (key === 'roles') { dup = recs.roles.includes(name); if (!dup) recs.roles.push(name); }
  else { dup = recs.scenarios.includes(name); if (!dup) recs.scenarios.push(name); }
  if (dup) { showToast(L['gen.dupRec'], 'warn'); return; }
  writeRecs(recs);
  if (key === 'domains') renderGenScene();
  if (key === 'roles') toggleGenRole(name);
  showToast(L['gen.addedRec'] + ' · ' + name, 'ok');
}

/* Legacy migration: user-customized domains from the old "Domain Profiles"
   panel are folded into recommendations.domains once, then removed. */
function migrateLegacyDomains() {
  try {
    const s = readStoredCfg();
    const custom = (s && Array.isArray(s.domains)) ? s.domains.filter(d => d && !d.builtin) : [];
    if (!custom.length) return;
    const recs = s.recommendations || {};
    const recD = (Array.isArray(recs.domains) ? recs.domains : []).map(d => ({ id: d.id || '', name: d.name || '', desc: d.desc || '' }));
    const seen = new Set(recD.map(d => d.id).filter(Boolean));
    custom.forEach(d => { if (d.id && !seen.has(d.id)) { seen.add(d.id); recD.push({ id: d.id, name: d.name, desc: d.desc || '' }); } });
    if (recD.length) s.recommendations = Object.assign({}, recs, { domains: recD });
    delete s.domains;
    localStorage.setItem('telg-settings', JSON.stringify(s));
  } catch (e) {}
}
function readRecs() {
  migrateLegacyDomains();
  try { const s = readStoredCfg(); return (s && s.recommendations) || null; } catch (e) { return null; }
}
function writeRecs(r) {
  try {
    const s = JSON.parse(localStorage.getItem('telg-settings') || 'null') || {};
    if (r && (r.domains || r.roles || r.scenarios)) s.recommendations = r; else delete s.recommendations;
    localStorage.setItem('telg-settings', JSON.stringify(s));
  } catch (e) {}
}
function recsOrEmpty() {
  const r = readRecs();
  if (!r) return null;
  const o = { domains: Array.isArray(r.domains) ? r.domains.filter(d => d && d.id && d.name) : [], roles: Array.isArray(r.roles) ? r.roles.filter(x => x && String(x).trim()) : [], scenarios: Array.isArray(r.scenarios) ? r.scenarios.filter(x => x && String(x).trim()) : [] };
  return (o.domains.length || o.roles.length || o.scenarios.length) ? o : null;
}
function normProfile(p) {
  p = p || {};
  /* legacy migration: old single-value fields -> v2 arrays */
  if (!Array.isArray(p.domains) && p.primaryDomain) p.domains = [p.primaryDomain];
  if (!Array.isArray(p.roles) && p.role) p.roles = [p.role];
  if (!Array.isArray(p.domains)) p.domains = [];
  if (!Array.isArray(p.roles)) p.roles = [];
  if (!p.language) p.language = 'en-zh';
  if (!p.minutes) p.minutes = parseInt((readStoredCfg() || {}).goalMin || '30', 10) || 30;
  return p;
}
function readProfile() { const s = readStoredCfg(); return normProfile((s && s.profile) || {}); }
function writeProfile(p) {
  try { const s = JSON.parse(localStorage.getItem('telg-settings') || 'null') || {}; if (p) s.profile = p; else delete s.profile; localStorage.setItem('telg-settings', JSON.stringify(s)); } catch (e) {}
}
function langLabelShort(v) {
  const m = { 'en-zh': '中英', 'ja-zh': '中日', 'de-zh': '中德', 'fr-zh': '中法', 'other': '其他' };
  return m[v] || v;
}
async function genRecs(silent) {
  const L = I18N[state.lang];
  const cfg = readStoredCfg() || {};
  const llm = cfg.llm || {};
  if (!(llm.apiKey || '').trim()) { if (!silent) showToast(L['settings.rec.noKey'], 'warn'); return; }
  const pf = cfg.profile || {};
  const btn = $('btn-recs-gen');
  if (btn && !silent) { btn.disabled = true; btn.textContent = L['settings.rec.genBusy']; }
  try {
    const r = await apiFetch('/config/recommendations/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      role: pf.role || '', domain: pf.primaryDomain || '', language: pf.language || 'en-zh', focus: pf.focus || '',
      role_portrait: pf.rolePortrait || '', domain_profile: pf.domainProfile || '', focus_tone: pf.focusTone || '',
      llm_config: buildLLMConfig()
    }) });
    writeRecs({ domains: r.domains || [], roles: r.roles || [], scenarios: r.scenarios || [], generatedAt: Date.now(), model: (llm.model || '') });
    if (!$('gen-panel').classList.contains('hidden')) applyProfileToGenPanel();
    if (!silent) showToast(L['settings.rec.generated']);
    return true;
  } catch (e) {
    if (!silent) showToast(L['settings.rec.genFail'] + ' — ' + e.message, 'error');
    return false;
  } finally {
    if (btn && !silent) { btn.disabled = false; btn.textContent = L['settings.rec.gen']; }
  }
}
/* ---------------- CONFIRM MODAL (delete) ---------------- */
function openConfirmModal(type, id, title, text) {
  state.confirm = { type: type, id: id };
  $('confirm-title').textContent = I18N[state.lang][type === 'material' ? 'del.mTitle' : 'del.pTitle'];
  $('confirm-name').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-modal').classList.remove('hidden');
}
function closeConfirmModal() {
  $('confirm-modal').classList.add('hidden');
  state.confirm = null;
}
function confirmDelete() {
  const c = state.confirm;
  if (!c) return;
  closeConfirmModal();
  if (c.type === 'material') doDeleteMaterial(c.id);
  else if (c.type === 'playlist') doDeletePlaylist(c.id);
}

/* ---------------- SIDEBAR STATS / FILTERS / DRAWER ---------------- */
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function loadStats() {
  try {
    const s = JSON.parse(localStorage.getItem('telg-stats') || 'null');
    if (s && s.date === todayKey()) return { date: s.date, playSec: +s.playSec || 0, quizTotal: +s.quizTotal || 0, quizCorrect: +s.quizCorrect || 0 };
  } catch (e) {}
  return { date: todayKey(), playSec: 0, quizTotal: 0, quizCorrect: 0 };
}
function saveStats() {
  try { localStorage.setItem('telg-stats', JSON.stringify(state.stats)); } catch (e) {}
  /* daily history: telg-stats-daily = { 'YYYY-MM-DD': { sec, hours: {'HH': sec} } } */
  try {
    const d = JSON.parse(localStorage.getItem('telg-stats-daily') || '{}');
    const k = todayKey();
    const h = String(new Date().getHours()).padStart(2, '0');
    d[k] = d[k] || { sec: 0, hours: {} };
    const total = Math.min(86400, Math.round(state.stats.playSec));
    d[k].sec = total;
    /* current hour = total minus other hours, so it self-corrects across saves */
    const others = Object.keys(d[k].hours).filter(x => x !== h).reduce((a, x) => a + (d[k].hours[x] || 0), 0);
    d[k].hours[h] = Math.max(0, total - others);
    localStorage.setItem('telg-stats-daily', JSON.stringify(d));
  } catch (e) {}
}
function renderToday() {
  const w = document.querySelector('.widget');
  if (!w) return;
  const s = state.stats;
  const t = w.querySelector('.today-time'), f = w.querySelector('.progress-fill');
  const mins = Math.floor(s.playSec / 60);
  if (t) t.textContent = mins + 'm / ' + state.goalMin + 'm';
  if (f) f.style.width = Math.min(100, s.playSec / (state.goalMin * 60) * 100) + '%';
}
function renderFilters() {
  const box = $('filter-tags');
  if (!box) return;
  const domains = [];
  state.library.forEach(m => {
    const d = m.meta.domain;
    if (d && !domains.includes(d)) domains.push(d);
  });
  box.innerHTML = domains.map(d =>
    '<button class="preset-tag' + (state.filters.includes(d) ? ' active-filter' : '') + '" data-filter="' + escapeHtml(d) + '">' + escapeHtml(d) + '</button>'
  ).join('');
}
function toggleSidebar(force) {
  const lib = $('lib-sidebar'), bd = $('sidebar-backdrop');
  const open = force !== undefined ? force : !lib.classList.contains('open');
  lib.classList.toggle('open', open);
  if (bd) bd.classList.toggle('show', open);
}

/* ---------------- BOOKMARKS ---------------- */
function persistBookmarks() {
  try { localStorage.setItem('telg-bookmarks', JSON.stringify(state.bookmarks)); } catch (e) {}
}
function isBookmarked(mid, idx) {
  return state.bookmarks.some(b => b.mid === mid && b.idx === idx);
}
function toggleBookmark(idx) {
  const art = currentArtifact();
  if (!art || !art.dialogue[idx]) return;
  const s = art.dialogue[idx];
  if (s.start_ms == null || Number.isNaN(Number(s.start_ms))) {
    showToast('Synthesize audio first — bookmarks need real timestamps', 'warn');
    return;
  }
  const found = state.bookmarks.findIndex(b => b.mid === art.id && b.idx === idx);
  const btn = document.querySelector('#transcript-list .trow[data-idx="' + idx + '"] [data-act="bookmark"]');
  if (found >= 0) {
    state.bookmarks.splice(found, 1);
    persistBookmarks();
    if (btn) { btn.classList.remove('active'); const u = btn.querySelector('use'); if (u) u.setAttribute('href', '#i-bookmark'); }
    showToast(I18N[state.lang]['bm.removed']);
  } else {
    state.bookmarks.unshift({ mid: art.id, title: art.meta.title, idx: idx, speaker: s.speakerId || s.speaker, text: s.text_en, text_zh: s.text_zh || '', time: s.start_ms, ts: Date.now() });
    persistBookmarks();
    if (btn) { btn.classList.add('active'); const u = btn.querySelector('use'); if (u) u.setAttribute('href', '#i-bookmark-fill'); }
    showToast(I18N[state.lang]['bm.added'] + (s.speakerId || s.speaker || ''));
  }
}
function removeBookmark(ts) {
  state.bookmarks = state.bookmarks.filter(x => x.ts !== ts);
  persistBookmarks();
  renderBookmarks();
}
function clearBookmarks() {
  state.bookmarks = [];
  persistBookmarks();
  renderBookmarks();
  showToast(I18N[state.lang]['bm.cleared']);
}
function renderBookmarks() {
  const L = I18N[state.lang];
  const box = $('bm-list');
  if (!box) return;
  if (!state.bookmarks.length) {
    box.innerHTML = '<div class="t-11 dim" style="padding:24px 10px;text-align:center">' + (L['bm.empty'] || 'No bookmarks yet') + '</div>';
    return;
  }
  box.innerHTML = state.bookmarks.map(b => {
    const on = state.current && state.current.id === b.mid && currentSegIndex() === b.idx;
    return '<div class="bm-row" data-ts="' + b.ts + '" data-mid="' + b.mid + '" data-idx="' + b.idx + '" style="' + (on ? 'border-color:var(--primary)' : '') + '">' +
      '<div style="min-width:0;flex:1">' +
        '<div style="display:flex;align-items:center;gap:8px;min-width:0">' +
          '<span class="speaker-dot" style="background:var(--primary)"></span>' +
          '<span class="t-11 bold" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(b.speaker || '') + '</span>' +
          '<span class="t-10 faint" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(b.title || '') + '</span>' +
          '<span class="mono t-10 faint" style="flex-shrink:0">' + fmt(b.time) + '</span>' +
        '</div>' +
        '<div class="t-11 dim" style="margin-top:3px;line-height:16px">' + escapeHtml(b.text) + '</div>' +
        (b.text_zh ? '<div class="i-zh t-11" style="margin-top:2px;line-height:16px">' + escapeHtml(b.text_zh) + '</div>' : '') +
      '</div>' +
      '<button class="btn-icon" data-bm-del="' + b.ts + '" title="Remove"><svg class="icon" style="width:13px;height:13px"><use href="#i-trash"/></svg></button>' +
    '</div>';
  }).join('');
}
function openBookmarkModal() {
  renderBookmarks();
  $('bookmark-modal').classList.remove('hidden');
}
function closeBookmarkModal() { $('bookmark-modal').classList.add('hidden'); }
function jumpToBookmark(mid, idx) {
  if (state.genNavGuard) state.genNavGuard.navigated = true;   /* bookmark jump is also user-initiated navigation */
  const local = state.library.find(m => m.id === mid);
  const go = (m) => { playArtifact(m); seekSentence(idx, true); };
  if (local) go(local);
  else API.getMaterial(mid).then(m => { const i = state.library.findIndex(x => x.id === mid); if (i >= 0) state.library[i] = m; else state.library.unshift(m); go(m); }).catch(() => showToast('Load failed', 'error'));
}

/* ---------------- PLAYLIST QUEUE / REMOVE ---------------- */
function toggleQueuePlay() {
  state.queuePlay = !state.queuePlay;
  renderPlayerBar();
  showToast(state.queuePlay ? I18N[state.lang]['pl.queueOn'] : I18N[state.lang]['pl.queueOff'], 'info');
  toggleLibCollapsed();   /* sidebar open/close is bound to the Queue control */
}
function removeFromActivePlaylist(id) {
  const pl = state.playlists.find(x => x.id === state.activePlaylist);
  if (!pl) return;
  const i = pl.materialIds.indexOf(id);
  if (i >= 0) pl.materialIds.splice(i, 1);
  API.removeFromPlaylist(pl.id, id).catch(() => {});
  renderPlaylists(); renderLibrary();
  showToast(I18N[state.lang]['pl.removed'] + pl.name);
}

/* ---------------- RENDER: library ---------------- */
function openPublishModal() {
  const art = currentArtifact();
  if (!art) return;
  $('pub-title').textContent = art.meta.title;
  $('pub-meta').textContent = art.meta.domain + ' · ' + art.meta.difficulty + ' · ' + fmt(art.meta.total_duration_ms);
  $('pub-name').value = art.meta.fileName || art.meta.title;
  $('publish-modal').classList.remove('hidden');
  setTimeout(() => $('pub-name').focus(), 60);
}
function closePublishModal() { $('publish-modal').classList.add('hidden'); }
function publishCurrent() {
  const art = currentArtifact();
  if (!art) return;
  const name = $('pub-name').value.trim() || art.meta.title;
  if (name !== art.meta.title && titleTaken(art.id, name)) {
    showToast(I18N[state.lang]['lib.nameExists'], 'warn');
    const inp = $('pub-name'); if (inp) { inp.focus(); inp.select(); }
    return;   /* 重名：保持弹窗打开，不发布 */
  }
  art.meta.fileName = name;
  art.meta.title = name;
  art.meta.saved = true;
  API.patchMaterial(art.id, { saved: true, title: name }).catch(() => {});
  closePublishModal();
  renderMaterial(); renderLibrary();
  showToast(I18N[state.lang]['pub.done'] + name);
}
function renameLibItem(id) {
  const m = state.library.find(x => x.id === id);
  if (!m) return;
  openRenameModal(
    state.lang==="zh" ? "重命名素材" : "Rename material",
    m.meta.title || "",
    (v) => {
      if (!v || v === m.meta.title) return;
      if (titleTaken(id, v)) { showToast(I18N[state.lang]["lib.nameExists"], "warn"); return; }
      m.meta.title = v;
      if (currentArtifact() && currentArtifact().id === id) { currentArtifact().meta.title = v; renderMaterial(); renderPlayerBar(); }
      API.patchMaterial(id, { title: v }).catch(() => {});
      showToast(I18N[state.lang]["lib.renamed"] + v);
      renderLibrary();
    }
  );
}

function renameLibItemOld(id) {
  if (state.renamingId) return;
  state.renamingId = id;
  renderLibrary();
  const inp = document.querySelector('.lib-item.renaming .lib-rename-input');
  if (inp) { inp.focus(); inp.select(); }
}
/* 重名检查：素材标题（排除自身）、播放列表名称（排除自身）——大小写不敏感 */
function titleTaken(id, name) {
  const low = String(name || '').trim().toLowerCase();
  if (!low) return false;
  return state.library.some(m => m.id !== id && String(m.meta && m.meta.title || '').trim().toLowerCase() === low);
}
function plNameTaken(id, name) {
  const low = String(name || '').trim().toLowerCase();
  if (!low) return false;
  return state.playlists.some(p => p.id !== id && String(p.name || '').trim().toLowerCase() === low);
}
function commitRenameOld(id, val) {
  const m = state.library.find(x => x.id === id);
  const v = (val || '').trim();
  if (m && v) {
    if (titleTaken(id, v)) {
      showToast(I18N[state.lang]['lib.nameExists'], 'warn');
      const inp = document.querySelector('.lib-item.renaming .lib-rename-input');
      if (inp) { inp.dataset.done = ''; inp.focus(); inp.select(); }
      return;   /* 保留输入框与重命名状态，让用户改完再提交 */
    }
    m.meta.title = v;
    API.patchMaterial(id, { title: m.meta.title }).catch(() => {});
    showToast(I18N[state.lang]['lib.renamed'] + m.meta.title);
  }
  state.renamingId = null;
  renderLibrary();
  if (state.current && state.current.id === id) renderMaterial();
}
function deleteLibItem(id) {
  const m = state.library.find(x => x.id === id);
  if (!m) return;
  const inPl = state.activePlaylist ? I18N[state.lang]['del.materialInPl'] : I18N[state.lang]['del.materialText'];
  openConfirmModal('material', id, m.meta.title, inPl);
}
function doDeleteMaterial(id) {
  const m = state.library.find(x => x.id === id);
  if (!m) return;
  const wasCurrent = state.current && state.current.id === id;
  const name = m.meta.title;
  state.library = state.library.filter(x => x.id !== id);
  state.playlists.forEach(p => { const i = p.materialIds.indexOf(id); if (i >= 0) p.materialIds.splice(i, 1); });
  API.deleteMaterial(id).catch(() => {});
  if (state.generated && state.generated.id === id) state.generated = null;
  if (wasCurrent) {
    state.time = 0; state.playing = false;
    const next = state.library[0] || null;
    if (next) playArtifact(next);
    else {
      state.current = null;
      renderMaterial();   /* shows the empty-state card and disables all content actions */
    }
  }
  renderLibrary(); renderPlaylists(); renderPlayerBar();
  syncPhases();
  showToast(I18N[state.lang]['lib.deleted'] + name);
}
/* All materials now live inside the "All Materials" accordion in
   renderPlaylists; this wrapper keeps every existing call site valid. */
function materialRowHTML(m, inPlaylist) {
  const active = state.current && state.current.id === m.id;
  const cls = 'lib-item' + (active ? ' active' : '') + (state.renamingId === m.id ? ' renaming' : '');
  const nameCell = state.renamingId === m.id
    ? '<input class="lib-rename-input" value="' + escapeHtml(m.meta.title) + '" data-rid="' + m.id + '"/>'
    : '<span class="lib-item-name">' + escapeHtml(m.meta.title) + '</span>' + (m.meta.saved === false ? '<span class="lib-draft">' + I18N[state.lang]['lib.draft'] + '</span>' : '') + (m.meta.generated && m.meta.audioReady === false ? '<span class="lib-draft unsynth">' + I18N[state.lang]['lib.unsynth'] + '</span>' : '');
  const acts = inPlaylist
    ? '<span class="lib-act del" data-act="pl-remove" title="' + escapeHtml(I18N[state.lang]['pl.remove']) + '"><svg class="icon" style="width:13px;height:13px"><use href="#i-minus"/></svg></span>'
    : '<span class="lib-act" data-act="pl-add" title="' + escapeHtml(I18N[state.lang]['pl.addTo']) + '"><svg class="icon" style="width:13px;height:13px"><use href="#i-folder"/></svg></span>' +
      '<span class="lib-act" data-act="rename" title="Rename"><svg class="icon" style="width:13px;height:13px"><use href="#i-edit"/></svg></span>' +
      '<span class="lib-act del" data-act="delete" title="Delete"><svg class="icon" style="width:13px;height:13px"><use href="#i-trash"/></svg></span>';
  const psLocale = m.meta.locale || localeOf(m.meta.context || m.meta.topic || '');
  const ps = paramsStr(m.meta, psLocale, window.innerWidth <= 720);
  return '<div class="' + cls + '" data-id="' + m.id + '" title="' + escapeHtml(m.meta.title) + '">' +
    '<div class="lib-ic"><svg class="icon"><use href="#i-waveform"/></svg></div>' +
    '<div class="lib-item-body">' +
      '<div class="lib-item-title">' + nameCell + '<span class="lib-item-dur">' + fmt(m.meta.total_duration_ms) + '</span></div>' +
      '<div class="lib-item-meta"><span class="nowrap">' + escapeHtml(ps) + '</span></div>' +
    '</div>' +
    '<div class="lib-item-actions">' + acts + '</div></div>';
}
function renderLibrary() {
  renderPlaylists();   /* materials + playlists all render in the sidebar accordion */
}
function clearFilters() {
  state.query = '';
  state.filters = [];
  renderFilters(); renderLibrary();
}
function setActivePlaylist(id) {
  state.activePlaylist = state.activePlaylist === id ? null : id;
  state.plRenamingId = null;
  renderPlaylists(); renderLibrary(); renderPlayerBar();
}
function startPlCreate() {
  if (state.plCreating) return;
  state.plCreating = true;
  state.plRenamingId = null;
  if (state.plModalTarget) { renderPlList(); return; }
  renderPlaylists();
  const ci = $('pl-create-input');
  if (ci) { ci.focus(); }
}
async function commitPlCreate(name) {
  name = (name || '').trim();
  if (plNameTaken('', name)) {
    showToast(I18N[state.lang]['pl.nameExists'], 'warn');
    const ci = $('pl-create-input');
    if (ci) { ci.focus(); ci.select(); }
    return;   /* 保留创建输入框，不退出创建状态 */
  }
  state.plCreating = false;
  if (name) {
    let p = { id: 'pl-' + Date.now(), name: name, materialIds: [] };
    try {
      const r = await API.createPlaylist(name);
      p = { id: r.id, name: r.name, materialIds: [] };
    } catch (e) {}
    state.playlists.push(p);
    if (state.plModalTarget) {
      p.materialIds.push(state.plModalTarget.id);
      API.addToPlaylist(p.id, state.plModalTarget.id).catch(() => {});
    }
    showToast(I18N[state.lang]['pl.created'] + name);
  }
  renderPlaylists();
  if (state.plModalTarget) renderPlList();
}
function renamePl(id) {
  const p = state.playlists.find(x => x.id === id);
  if (!p) return;
  openRenameModal(
    state.lang==="zh" ? "重命名播放列表" : "Rename playlist",
    p.name,
    (v) => {
      if (!v || v === p.name) return;
      if (plNameTaken(id, v)) { showToast(I18N[state.lang]["pl.nameExists"], "warn"); return; }
      p.name = v;
      API.renamePlaylist(id, p.name).catch(() => {});
      showToast(I18N[state.lang]["pl.renamed"] + p.name);
      renderPlaylists();
    }
  );
}

function renamePlOld(id) {
  state.plRenamingId = id;
  renderPlaylists();
  const inp = document.querySelector('.playlist-row[data-plid="' + id + '"] .pl-rename-input');
  if (inp) { inp.focus(); inp.select(); }
}
function commitPlRenameOld(id, val) {
  const p = state.playlists.find(x => x.id === id);
  const v = (val || '').trim();
  if (p && v) {
    if (plNameTaken(id, v)) {
      showToast(I18N[state.lang]['pl.nameExists'], 'warn');
      const inp = document.querySelector('.playlist-row[data-plid="' + id + '"] .pl-rename-input');
      if (inp) { inp.dataset.done = ''; inp.focus(); inp.select(); }
      return;   /* 保留输入框与重命名状态 */
    }
    p.name = v;
    API.renamePlaylist(id, p.name).catch(() => {});
    showToast(I18N[state.lang]['pl.renamed'] + p.name);
  }
  state.plRenamingId = null;
  renderPlaylists();
}
function deletePl(id) {
  const p = state.playlists.find(x => x.id === id);
  if (!p) return;
  openConfirmModal('playlist', id, p.name, I18N[state.lang]['del.playlistText']);
}
function doDeletePlaylist(id) {
  const p = state.playlists.find(x => x.id === id);
  if (!p) return;
  const name = p.name;
  state.playlists = state.playlists.filter(x => x.id !== id);
  if (state.activePlaylist === id) state.activePlaylist = null;
  API.deletePlaylist(id).catch(() => {});
  renderPlaylists(); renderLibrary();
  if (state.plModalTarget) renderPlList();
  showToast(I18N[state.lang]['pl.deleted'] + name);
}
function openPlModal() { openPlModalFor(currentArtifact() ? currentArtifact().id : null); }
function openPlModalFor(id) {
  const art = state.library.find(x => x.id === id) || (state.current && state.current.id === id ? state.current : null);
  if (!art) return;
  state.plModalTarget = art;
  $('pl-material-name').textContent = art.meta.title;
  renderPlList();
  $('pl-modal').classList.remove('hidden');
}
function closePlModal() {
  $('pl-modal').classList.add('hidden');
  state.plModalTarget = null;
  state.plCreating = false;
  renderPlaylists();
}
function renderPlList() {
  const art = state.plModalTarget;
  if (!art) return;
  let html = state.playlists.map(p => {
    const on = p.materialIds.includes(art.id);
    return '<div class="pl-row ' + (on ? 'on' : '') + '" data-plid="' + p.id + '">' +
      '<span class="pl-check"><svg class="icon" style="width:10px;height:10px"><use href="#i-check"/></svg></span>' +
      '<span class="pl-row-name">' + escapeHtml(p.name) + '</span>' +
      '<span class="pl-row-count">' + p.materialIds.length + '</span>' +
      '</div>';
  }).join('');
  if (!html) html = '<div class="pl-list-empty">' + escapeHtml(I18N[state.lang]['pl.empty']) + '</div>';
  if (state.plCreating) {
    html += '<div style="margin-top:8px"><input class="pl-rename-input" id="pl-create-input" data-pl-create="1" placeholder="' + escapeHtml(I18N[state.lang]['pl.createPh']) + '" style="width:100%"/></div>';
  }
  $('pl-list').innerHTML = html;
  const ci = $('pl-create-input');
  if (ci) { ci.focus(); }
}
function togglePlMaterial(plid) {
  const art = state.plModalTarget;
  if (!art) return;
  const p = state.playlists.find(x => x.id === plid);
  if (!p) return;
  const idx = p.materialIds.indexOf(art.id);
  if (idx >= 0) {
    p.materialIds.splice(idx, 1);
    API.removeFromPlaylist(plid, art.id).catch(() => {});
    showToast(I18N[state.lang]['pl.removed'] + p.name);
  } else {
    p.materialIds.push(art.id);
    API.addToPlaylist(plid, art.id).catch(() => {});
    showToast(I18N[state.lang]['pl.added'] + p.name);
  }
  renderPlList(); renderPlaylists();
}
function renderPlaylists() {
  renderFilters();
  const rows = [];
  if (state.plCreating) {
    rows.push('<div class="playlist-row" style="cursor:default">' +
      '<div class="pl-row-input-wrap"><input class="pl-rename-input" id="pl-create-input" placeholder="' + escapeHtml(I18N[state.lang]['pl.createPh']) + '" data-pl-create="1"/></div>' +
      '</div>');
  }
  /* "All Materials" accordion — every material, no playlist wrapper */
  const allActive = state.activePlaylist === '__all__';
  const filtered = state.library.filter(m => {
    const psLocale = m.meta.locale || localeOf(m.meta.context || m.meta.topic || '');
    const hay = (m.meta.title + ' ' + m.meta.domain + ' ' + (m.meta.tag || '') + ' ' + m.meta.role + ' ' + paramsStr(m.meta, psLocale, false) + ' ' + paramsStr(m.meta, psLocale, true)).toLowerCase();
    return state.filters.length === 0 || state.filters.some(f => hay.includes(f.toLowerCase()));
  });
  const allExp = filtered.length
    ? filtered.map(m => materialRowHTML(m, false)).join('')
    : '<div class="pl-item-empty">' + escapeHtml(I18N[state.lang]['lib.empty']) + '</div>' +
      (state.filters.length ? '<button class="btn btn-sm" id="btn-clear-filter" style="margin:6px 0 2px 4px">' + escapeHtml(I18N[state.lang]['lib.clearFilters']) + '</button>' : '');
  rows.push(
    '<div class="pl-wrap">' +
      '<div class="playlist-row' + (allActive ? ' active' : '') + '" data-plid="__all__" title="' + escapeHtml(I18N[state.lang]['pl.all']) + '">' +
        '<div class="ic" style="min-width:0"><svg class="icon" style="width:18px;height:18px"><use href="#i-waveform"/></svg><span class="t-12" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(I18N[state.lang]['pl.all']) + '</span></div>' +
        '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0"><span class="pill mono">' + filtered.length + '</span></div>' +
      '</div>' +
      '<div class="pl-expand" data-plid="__all__">' + allExp + '</div>' +
    '</div>');
  state.playlists.forEach(p => {
    const active = state.activePlaylist === p.id;
    const cls = 'playlist-row' + (active ? ' active' : '') + (state.plRenamingId === p.id ? ' renaming' : '');
    const nameCell = state.plRenamingId === p.id
      ? '<div class="pl-row-input-wrap"><input class="pl-rename-input" value="' + escapeHtml(p.name) + '" data-rid="' + p.id + '"/></div>'
      : '<div class="ic" style="min-width:0"><svg class="icon" style="width:18px;height:18px"><use href="#i-folder"/></svg><span class="t-12" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(p.name) + '</span></div>';
    const members = p.materialIds.filter(id => state.library.some(m => m.id === id));
    const exp = members.length
      ? members.map(id => {
          const m = state.library.find(x => x.id === id);
          return m ? materialRowHTML(m, true) : '';
        }).join('')
      : '<div class="pl-item-empty">' + escapeHtml(I18N[state.lang]['pl.empty']) + '</div>';
    rows.push(
      '<div class="pl-wrap">' +
        '<div class="' + cls + '" data-plid="' + p.id + '" title="' + escapeHtml(p.name) + '">' +
          nameCell +
          '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">' +
            '<span class="pill mono">' + members.length + '</span>' +
            '<div class="pl-acts">' +
              '<span class="lib-act" data-act="pl-rename" title="Rename"><svg class="icon" style="width:13px;height:13px"><use href="#i-edit"/></svg></span>' +
              '<span class="lib-act del" data-act="pl-delete" title="Delete"><svg class="icon" style="width:13px;height:13px"><use href="#i-trash"/></svg></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pl-expand" data-plid="' + p.id + '">' + exp + '</div>' +
      '</div>');
  });
  $('playlist-list').innerHTML = rows.join('');
  const ci = $('pl-create-input');
  if (ci) { ci.focus(); }
}

/* ---------------- RENDER: shared artifact blocks ---------------- */
function speakerDisplay(art, sid) {
  /* v2: dialogue lines carry stable speakerId; resolve to the display role
     from meta.speakers. Legacy materials (speaker = name) pass through. */
  if (!sid) return '';
  if (art && art.meta && Array.isArray(art.meta.speakers) && art.meta.speakers.length) {
    const m = art.meta.speakers.find(s => s && s.id === sid);
    if (m && m.role) return m.role;
  }
  return sid;
}
function transcriptHTML(art) {
  const fs = CONFIG.fontSizes[state.fontIdx];
  const playable = isPlayable(art);
  return '<div class="transcript">' + art.dialogue.map((s, i) => {
    const c = i % 2 === 0 ? 'var(--primary)' : 'var(--secondary)';
    const hasTs = s.start_ms != null && !Number.isNaN(Number(s.start_ms));
    return '<div class="trow" data-idx="' + i + '" data-start="' + (hasTs ? s.start_ms : '') + '" data-end="' + (hasTs ? s.end_ms : '') + '">' +
      '<div class="trow-head">' +
        '<div class="trow-id">' +
          '<span class="speaker-dot" style="background:' + c + '"></span>' +
          '<span class="speaker-name">' + escapeHtml(speakerDisplay(art, s.speakerId || s.speaker)) + '</span>' +
          '<span class="speaker-role">' + escapeHtml(s.role || '') + '</span>' +
          '<span class="playing-flag" data-flag="1"><span class="dot"></span>Playing</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0">' +
          (hasTs ? '<span class="trow-time">' + fmt(s.start_ms) + ' – ' + fmt(s.end_ms) + '</span>' : '') +
          '<span class="trow-actions">' +
            '<button data-act="sloop" ' + (playable ? '' : 'disabled ') + 'title="Loop this sentence"><svg class="icon icon-sm"><use href="#i-repeat"/></svg></button>' +
            '<button data-act="bookmark" class="' + (isBookmarked(art.id, i) ? 'active' : '') + '" ' + (playable ? '' : 'disabled ') + 'title="Bookmark phrase"><svg class="icon icon-sm"><use href="#' + (isBookmarked(art.id, i) ? 'i-bookmark-fill' : 'i-bookmark') + '"/></svg></button>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="trow-en" style="font-size:' + fs + ';line-height:' + (parseInt(fs) + 9) + 'px">' + s.text_en + '</div>' +
      '<div class="trow-zh" style="font-size:' + fs + ';line-height:' + (parseInt(fs) + 9) + 'px">' + s.text_zh + '</div>' +
    '</div>';
  }).join('') + '</div>';
}
function vocabHTML(art) {
  return art.vocabulary.map(v =>
    '<div class="vocab-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><span class="t-13 bold">' + escapeHtml(v.en) + '</span><span class="mono t-10 accent">' + v.symbol + '</span></div>' +
      (v.zh ? '<div class="t-11 accent vocab-zh">' + escapeHtml(v.zh) + '</div>' : '') +
      '<div class="t-11 dim vocab-def">' + escapeHtml(v.def) + '</div>' +
      (v.def_zh ? '<div class="t-11 dim vocab-def-zh">' + escapeHtml(v.def_zh) + '</div>' : '') +
    '</div>').join('');
}
function questionsHTML(art) {
  return art.listening_questions.map((qt, qi) =>
    '<div class="q-card" data-q="' + qi + '">' +
      '<div style="display:flex;align-items:center;justify-content:space-between"><span class="pill mono">Q' + (qi + 1) + '</span><span class="t-10 faint">Single choice</span></div>' +
      '<div class="t-13 bold">' + qt.q + '</div>' +
      (qt.q_zh ? '<div class="i-zh t-12">' + escapeHtml(qt.q_zh) + '</div>' : '') +
      '<div class="q-options">' + qt.options.map((o, oi) =>
        '<label class="q-opt" data-opt="' + oi + '">' +
          '<input type="radio" name="q' + art.id + '_' + qi + '" value="' + oi + '"/>' +
          '<span class="q-opt-en">' + o + '</span>' +
          ((qt.options_zh && qt.options_zh[oi]) ? '<div class="i-zh t-11" style="margin-top:2px">' + escapeHtml(qt.options_zh[oi]) + '</div>' : '') +
          '<span class="ok-tag" data-ok="1" style="display:none">✓ Correct</span>' +
        '</label>').join('') + '</div>' +
      '<div class="q-expl" data-qidx="' + qi + '" data-expl="1" title="Jump to the cited sentence" style="display:none;border-top:1px solid var(--line);padding-top:8px;cursor:pointer">' + qt.explain +
        (qt.explain_zh ? '<div class="i-zh" style="margin-top:4px">' + escapeHtml(qt.explain_zh) + '</div>' : '') +
        '<div class="q-expl-jump">↩ <span data-i18n="quiz.jump">Listen to the sentence</span></div>' +
      '</div>' +
    '</div>').join('');
}
/* Quiz 解析行点击：从 explain 文本提取时间戳（Segment 00:00 / 片段00:09），
   跳到对话中时间最接近的句子并自动播放。LLM 时间戳可能与合成时间轴有小偏差，
   按句中点最近匹配做容错。 */
function seekToExplain(qidx) {
  const art = currentArtifact();
  if (!art || !art.dialogue || !art.dialogue.length) return;
  const qt = (art.listening_questions || [])[qidx];
  const txt = (qt && (qt.explain || '')) || '';
  /* 先尝试从时间戳跳转 */
  const m = String(txt).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const ms = (parseInt(m[1]) * 60 + parseInt(m[2]) + (m[3] ? parseInt(m[3]) : 0)) * 1000;
    let best = 0, bestD = Infinity;
    art.dialogue.forEach((s, i) => {
      const mid = (Number(s.start_ms) + Number(s.end_ms)) / 2;
      const d = Math.abs(mid - ms);
      if (d < bestD) { bestD = d; best = i; }
    });
    seekSentence(best, true);
    return;
  }
  /* 没有时间戳，通过文本匹配找对应的句子 */
  /* 从 explain 里提取关键文本（去掉前缀和引号） */
  const cleanTxt = String(txt)
    .replace(/^.*?says?\s*/i, '')  // 去掉 "The sales consultant says "
    .replace(/^.*?asks?\s*/i, '')   // 去掉 "The buyer asks "
    .replace(/^.*?hypothesizes?\s*/i, '')
    .replace(/^["'""']|["'""']$/g, '') // 去掉首尾引号
    .trim();
  if (!cleanTxt) { showToast('Cannot locate sentence in explanation', 'warn'); return; }
  /* 在 dialogue 里找最匹配的句子 */
  const cleanWords = cleanTxt.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  let best = 0, bestScore = 0;
  art.dialogue.forEach((s, i) => {
    const sTxt = String(s.text_en || '').toLowerCase();
    let score = 0;
    cleanWords.forEach(w => { if (sTxt.includes(w)) score++; });
    if (score > bestScore) { bestScore = score; best = i; }
  });
  if (bestScore > 0) {
    seekSentence(best, true);
  } else {
    showToast('Cannot locate sentence in explanation', 'warn');
  }
}
function patternsHTML(art) {
  return art.core_sentence_patterns.map(p =>
    '<div class="pattern-card">' +
      '<span class="mono t-10 accent uc" style="letter-spacing:.06em">' + p.title + (p.title_zh ? ' · ' + escapeHtml(p.title_zh) : '') + '</span>' +
      '<div class="mono t-12">' + p.pattern + '</div>' +
      (p.pattern_zh ? '<div class="i-zh mono t-11">' + escapeHtml(p.pattern_zh) + '</div>' : '') +
      '<div class="p-eg t-11"><span class="dim">Example: </span>' + p.example + '</div>' +
      (p.example_zh ? '<div class="i-zh t-11" style="margin-top:2px"><span class="dim">示例：</span>' + escapeHtml(p.example_zh) + '</div>' : '') +
    '</div>').join('');
}
function groundingHTML(art) {
  const bg = art.background || {};
  const zh = (k) => bg[k] ? '<p class="t-12 i-zh" style="margin-top:6px">' + escapeHtml(bg[k]) + '</p>' : '';
  return [
    '<div class="vocab-card" style="gap:8px"><span class="mono t-10 accent uc">01 · Engineering Background</span><p class="t-12">' + bg.technical_background + '</p>' + zh('technical_background_zh') + '</div>',
    '<div class="vocab-card" style="gap:8px"><span class="mono t-10 accent uc">02 · Technical Principle</span><p class="t-12">' + bg.technical_principle + '</p>' + zh('technical_principle_zh') + '</div>',
    '<div class="vocab-card" style="gap:8px"><span class="mono t-10 faint uc">03 · Engineering Scenario</span><p class="t-12 dim">' + bg.engineering_scenario + '</p>' + zh('engineering_scenario_zh') + '</div>'
  ].join('');
}

/* ---------------- RENDER: player material ---------------- */
/* Material-header actions that need at least one material loaded. Playback
   controls are handled separately in renderPlayerBar (audioReady gate). */
function setActionsDisabled(off) {
  ['btn-rename','btn-voice','btn-add-pl','btn-md-export','btn-zh-toggle','btn-font'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = off; el.classList.toggle('disabled', off); }
  });
  document.querySelectorAll('.seg-item[data-mode]').forEach(b => {
    b.disabled = off; b.classList.toggle('disabled', off);
  });
}
/* Adjust (btn-voice) is a full-material action: only usable on PUBLISHED
   materials. Drafts / incomplete materials edit via the synth banner. */
function openPublishReadyView() {
  const art = currentArtifact();
  if (!art || !art.meta.generated) return;
  /* Step 2 of 3: audio ready — show the banner with Edit Audio Settings +
     Publish, and the 2/3 phase progress. One click away from publishing. */
  $('synth-banner').classList.remove('hidden');
  $('synth-banner-label').textContent = I18N[state.lang]['tr.audioReady'];
  $('btn-refine').classList.add('hidden');
  $('btn-synth').classList.add('hidden');
  $('btn-edit-audio').classList.remove('hidden');
  $('btn-publish-banner').classList.remove('hidden');
  if (art.meta.audioReady === true) setPhases(2);
}
function applyVoiceGate() {
  const vBtn = $('btn-voice');
  if (!vBtn) return;
  const art = currentArtifact();
  const off = !art || !(art.meta && art.meta.saved === true);
  vBtn.disabled = off;
  vBtn.classList.toggle('disabled', off);
}
/* Normal/Blind switching only makes sense once the corpus text is ready. */
function applyModeGate() {
  const art = currentArtifact();
  const off = !art || !(art.meta && art.meta.generated === true);
  document.querySelectorAll('.seg-item[data-mode]').forEach(b => {
    b.disabled = off;
    b.classList.toggle('disabled', off);
  });
}
function renderMaterial() {
  const art = currentArtifact();
  const tabbar = document.querySelector('.tabbar');
  if (!art) {
    $('m-title').textContent = I18N[state.lang]['lib.emptyTitle'] || 'No materials yet';
    $('m-tag').textContent = ''; $('m-level').textContent = ''; $('m-dur').textContent = ''; $('m-meta').textContent = '';
    $('transcript-list').innerHTML =
      '<div class="empty-state"><span class="es-ic"><svg class="icon"><use href="#i-waveform"/></svg></span>' +
      '<div class="es-title">' + (I18N[state.lang]['lib.emptyTitle'] || 'No materials yet') + '</div>' +
      '<div class="es-sub">' + (I18N[state.lang]['lib.emptySub'] || '') + '</div>' +
      '<button class="btn btn-primary" id="btn-empty-gen" style="margin-top:10px"><svg class="icon icon-sm"><use href="#i-bolt"/></svg><span>' + (I18N[state.lang]['nav.generate'] || 'Generate') + '</span></button>' +
      '</div>';
    $('synth-banner').classList.add('hidden');
    renderOverviewCard(null);  /* 空态时隐藏 overview 卡片 */
    ['tab-vocab-count', 'tab-quiz-count'].forEach(id => { const el = $(id); if (el) el.textContent = ''; });
    const pg = $('panel-grounding'); if (pg) pg.innerHTML = '';
    if (tabbar) tabbar.style.display = 'none';
    setActionsDisabled(true);
    return;
  }
  if (tabbar) tabbar.style.display = '';
  setActionsDisabled(false);
  applyVoiceGate();
  applyModeGate();
  const ins = $('inspector');
  if (ins) ins.dataset.fs = state.fontIdx;
  const meta = art.meta;
  $('m-title').textContent = meta.title;
  $('m-tag').textContent = meta.tag || '';
  $('m-level').textContent = meta.difficulty;
  $('m-dur').textContent = fmt(meta.total_duration_ms);
  $('m-meta').textContent = meta.domain + ' · ' + meta.role + ' · ' + meta.scenario;
  $('tab-vocab-count').textContent = '(' + art.vocabulary.length + ')';
  $('tab-quiz-count').textContent = '(' + art.listening_questions.length + ')';
  $('transcript-list').innerHTML = transcriptHTML(art);
  /* staggerIn 动画在某些情况下不触发完成，导致 opacity 停留在 0，先禁用 */
  /* if (window.Ui && Ui.staggerIn) Ui.staggerIn($('transcript-list').querySelectorAll('.trow'), { stagger: 15, duration: Ui.getDur('fast') }); */
  renderOverviewCard(art);
  setSynthBanner();
  $('panel-grounding').innerHTML = groundingHTML(art);
  $('panel-vocab').innerHTML = '<div class="vocab-grid" style="grid-template-columns:1fr">' + vocabHTML(art) + '</div>';
  $('panel-questions').innerHTML = questionsHTML(art);
  $('panel-patterns').innerHTML = patternsHTML(art);
  renderPlayerBar();
  syncHighlight();
  renderLibrary();
  applyTranscriptLang();
  syncPhases();
}
function applyListenMode() {
  $('transcript-pane').classList.toggle('blind-mode', state.listenMode === 'blind');
  document.querySelectorAll('.seg-item[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === state.listenMode));
  applyTranscriptLang();
}
/* 剧情引子（对话概述）卡：常显在 transcript 之前；双语、跟随翻译按键、
   豁免盲听（不模糊不隐藏）；旧素材无 overview 不渲染。 */
function renderOverviewCard(art) {
  const el = $('overview-card');
  if (!el) return;
  if (!art) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const ov = (art && (art.overview || (art.meta && art.meta.overview))) || null;
  if (!ov || !ov.text_en) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const en = String(ov.text_en || '').trim();
  const zh = String(ov.text_zh || '').trim();
  const narr = (art && art.meta && art.meta.narration) || null;
  /* 只有合成了 TTS（audioReady=true）才显示播放按钮 */
  const hasNarr = true;  /* always show overview card */
  const canPlay = art && art.meta && art.meta.audioReady === true;
  const L = I18N[state.lang] || {};
  const badge = hasNarr ? '<span class="narr-badge">' + (L['narr.badge'] || 'Scene Overview') + '</span>' : '';
  const btn = canPlay
    ? '<button class="narr-btn" id="btn-narr-play" title="Play narration" style="border:none;background:none;padding:2px;cursor:pointer">' +
      '<svg class="icon" style="width:18px;height:18px"><use href="#i-volume"/></svg>' +
      '</button>'
    : '';
  el.classList.toggle('narr-card', hasNarr);
  el.innerHTML = '<div class="narr-head">' + badge + btn + '</div>' +
    '<div class="ov-en">' + escapeHtml(en) + '</div>' +
    (zh ? '<div class="ov-zh">' + escapeHtml(zh) + '</div>' : '');
  el.classList.remove('hidden');
}

/* ---- 通用重命名弹窗 ---- */
let renameCallback = null;
function openRenameModal(title, current, cb) {
  const m = $('rename-modal'); if (!m) return;
  $('rename-title').textContent = title;
  const inp = $('rename-input'); inp.value = current;
  m.classList.remove('hidden');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  renameCallback = cb;
}
function closeRenameModal() {
  $('rename-modal').classList.add('hidden');
  renameCallback = null;
}
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    $('rename-cancel').onclick = closeRenameModal;
    $('rename-close').onclick = closeRenameModal;
    $('rename-ok').onclick = () => {
      const v = $('rename-input').value.trim();
      if (!v) {
        /* 空白不接受：震动输入框 + 提示，不关闭弹窗 */
        const inp = $('rename-input');
        inp.style.animation = 'shake 0.3s';
        inp.style.borderColor = 'var(--error)';
        showToast(I18N[state.lang]['rename.empty'] || '名称不能为空', 'warn');
        setTimeout(() => { inp.style.animation = ''; inp.style.borderColor = ''; }, 300);
        return;
      }
      if (renameCallback) renameCallback(v);
      closeRenameModal();
    };
    $('rename-input').onkeydown = (e) => {
      if (e.key === 'Enter') $('rename-ok').click();
      if (e.key === 'Escape') closeRenameModal();
    };
  }, 100);
});

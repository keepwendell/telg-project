# -*- coding: utf-8 -*-
"""TELG 全链路回归测试（mock 模式）"""
import os
from playwright.sync_api import sync_playwright

results = []
def log(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS' if ok else 'FAIL'), '|', name, ('| ' + detail if detail else ''), flush=True)

with sync_playwright() as p:
    CHROME = '/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome'
    b = p.chromium.launch(**({'executable_path': CHROME, 'args': ['--no-sandbox']} if os.path.exists(CHROME) else {'args': ['--no-sandbox']}))
    pg = b.new_page(viewport={'width':1440,'height':900})
    errs=[]; cons=[]
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: cons.append(m.text) if m.type=='error' else None)
    pg.add_init_script("try{localStorage.setItem('telg-test-data','tire'); localStorage.setItem('telg-onboarding', JSON.stringify({done:true,at:Date.now()})); localStorage.setItem('telg-llm-mock','1'); localStorage.setItem('telg-tts-mock','1');}catch(e){}")
    pg.goto('file:///home/user/Doubao/chats/38441710896760066/telg-project/frontend/index.html'); pg.wait_for_timeout(600)
    pg.evaluate("localStorage.clear(); localStorage.setItem('telg-test-data','tire'); localStorage.setItem('telg-onboarding', JSON.stringify({done:true,at:Date.now()})); localStorage.setItem('telg-llm-mock','1'); localStorage.setItem('telg-tts-mock','1'); location.reload(); true"); pg.wait_for_timeout(800)
    for _wl in range(20):
        if pg.evaluate("state.library.length") > 0: break
        pg.wait_for_timeout(400)

    log('A1 页面加载无 JS 错误', len(errs)==0, '; '.join(errs[:3]))

    pg.keyboard.press('Control+k'); pg.wait_for_timeout(300)
    log('B1 ⌘K 打开生成面板', not pg.evaluate("document.getElementById('gen-panel').classList.contains('hidden')"))
    pg.evaluate("(()=>{state.genScene.context='Brake-by-Wire Failover'; renderGenScene();})()"); pg.wait_for_timeout(100)
    pg.evaluate("document.getElementById('btn-generate').click(); true"); pg.wait_for_timeout(300)
    steps = pg.evaluate("document.querySelectorAll('#gen-progress-box .gen-step').length")
    log('B2 生成进度 3 步显示', steps==3, f'steps={steps}')
    pg.wait_for_timeout(2200)
    log('B3 语料就绪后预览出现', not pg.evaluate("document.getElementById('transcript-body').classList.contains('hidden')"))
    log('B4 语料态仅编辑/合成两键', pg.evaluate("!document.getElementById('btn-refine').classList.contains('hidden') && !document.getElementById('btn-synth').classList.contains('hidden') && document.getElementById('btn-publish-banner').classList.contains('hidden')"))
    log('B5 toast 提示语料已生成', 'Corpus generated' in pg.evaluate("document.querySelector('.toast') ? document.querySelector('.toast').textContent : ''"))
    log('B6 素材进入库列表', pg.evaluate("document.querySelectorAll('.lib-item').length") >= 1)
    cur = pg.evaluate("(()=>{const m=document.querySelector('.lib-item.active'); return m?m.textContent:'N/A'})()")
    log('B7 当前素材为新生成（结构化命名）', 'Brake by Wire' in cur, cur)

    pg.evaluate("document.getElementById('btn-synth').click(); true"); pg.wait_for_timeout(400)
    log('C1 打开音色/合成面板', not pg.evaluate("document.getElementById('adjust-modal').classList.contains('hidden')"))
    pg.wait_for_timeout(100)  # openTTSModal opens the Voice panel directly
    pg.evaluate("(()=>{const sel=document.querySelector('#adj-voice-roles .voice-role-row select'); if(sel)sel.value='en-US-ChristopherNeural'; const s=document.getElementById('adj-tts-style'); if(s)s.value='serious'; document.getElementById('btn-adjust-apply').click();})()"); pg.wait_for_timeout(300)
    log('C2 音色应用后进入 TTS 合成进度', not pg.evaluate("document.getElementById('gen-progress-box').classList.contains('hidden')"))
    for _i in range(90):
        pg.wait_for_timeout(1000)
        if pg.evaluate("currentArtifact() ? currentArtifact().meta.audioReady : false"): break
    log('C3 合成完成 audioReady', pg.evaluate("(document.querySelector('.lib-item.active') ? currentArtifact().meta.audioReady : false) == true"))
    pg.wait_for_timeout(800)
    log('C4 合成后出现编辑音频/发布两键', pg.evaluate("document.getElementById('btn-publish-banner') && !document.getElementById('btn-publish-banner').classList.contains('hidden') && document.getElementById('btn-edit-audio') && !document.getElementById('btn-edit-audio').classList.contains('hidden')"))
    log('C5 合成后自动播放中', pg.evaluate("state.playing") is True)

    pg.evaluate("document.getElementById('btn-publish-banner').click(); true"); pg.wait_for_timeout(300)
    log('D1 发布弹窗出现', not pg.evaluate("document.getElementById('publish-modal').classList.contains('hidden')"))
    pg.evaluate("(()=>{const i=document.querySelector('#publish-modal input'); i.value='Brake-by-Wire Failover (Final)'; document.querySelector('#publish-modal .btn-primary').click();})()"); pg.wait_for_timeout(400)
    lib = pg.evaluate("Array.from(document.querySelectorAll('.lib-item .lib-item-name')).map(x=>x.textContent)")
    log('D2 发布后库中为最终名', any('Brake-by-Wire Failover (Final)' in x for x in lib), str(lib[-2:]))
    log('D3 发布后进度/发布区隐藏', pg.evaluate("document.getElementById('gen-phases').classList.contains('hidden')"))

    pg.evaluate("(()=>{const m=document.querySelector('.lib-item.active'); if(!m) return 'noactive'; const a=m.querySelector('.lib-item-actions [data-act=\\'rename\\']'); if(!a) return 'norename'; a.click(); return 'ok';})()"); pg.wait_for_timeout(300)
    pg.evaluate("(()=>{const i=document.querySelector('.lib-rename-input'); i.value='Renamed Material'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()"); pg.wait_for_timeout(300)
    log('E1 列表项重命名生效', 'Renamed Material' in pg.evaluate("document.querySelector('#playlist-list').textContent"))

    pg.evaluate("(()=>{const r=document.querySelector('.playlist-row[data-plid=\\'__all__\\']'); if(r && !r.classList.contains('active')) r.click();})()"); pg.wait_for_timeout(300)
    delSel = pg.evaluate("(()=>{const items=document.querySelectorAll('.lib-item'); const cur=document.querySelector('.lib-item.active'); const curId=cur?cur.dataset.id:null; const it=Array.from(items).find(x=>x.dataset.id!==curId && !x.querySelector('.lib-act[data-act=\\'pl-remove\\']') && x.querySelector('.lib-item-actions [data-act=\\'delete\\']')); if(!it) return 'none'; window.__delId=it.dataset.id; it.querySelector('.lib-item-actions [data-act=\\'delete\\']').click(); return it.dataset.id;})()"); pg.wait_for_timeout(300)
    if delSel != 'none':
        log('F1 删除弹窗出现', not pg.evaluate("document.getElementById('confirm-modal').classList.contains('hidden')"))
        pg.evaluate("document.querySelector('#confirm-modal .btn-danger').click(); true"); pg.wait_for_timeout(300)
        log('F2 确认删除后素材移除', not pg.evaluate("!!document.querySelector('.lib-item[data-id=\"' + window.__delId + '\"]')"))
    else:
        log('F1 删除弹窗出现（跳过：无其它可删素材）', True)
        log('F2 确认删除后素材移除（跳过）', True)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)

    pg.evaluate("document.getElementById('btn-new-playlist').click(); true"); pg.wait_for_timeout(300)
    import time as _t
    _plname = 'Chassis-%d' % int(_t.time() % 1000000)
    pg.evaluate("(()=>{const i=document.querySelector('.pl-rename-input'); i.value='%s'; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()" % _plname); pg.wait_for_timeout(300)
    log('G1 新建播放列表', _plname in pg.evaluate("document.querySelector('#playlist-list').textContent"))
    pg.evaluate("(()=>{const m=document.querySelector('.lib-item'); if(!m) return 'noitem'; const a=m.querySelector('[data-act=\\'pl-add\\']'); if(a){a.click(); return 'ok';} return 'noact';})()"); pg.wait_for_timeout(300)
    log('G2 添加到播放列表弹窗', not pg.evaluate("document.getElementById('pl-modal').classList.contains('hidden')"))
    pg.evaluate("(()=>{const t=Array.from(document.querySelectorAll('#pl-modal .pl-row')).find(x=>x.textContent.includes('%s')); t.click();})()" % _plname); pg.wait_for_timeout(300)
    g3rows = pg.evaluate("Array.from(document.querySelectorAll('#playlist-list .playlist-row')).map(x=>x.textContent)")
    g3cr = [r for r in g3rows if _plname in r]
    g3ok = False
    if g3cr:
        import re as _re
        _m = _re.search(r'(\d+)\s*$', g3cr[0].strip())
        g3ok = bool(_m) and int(_m.group(1)) >= 1
    log('G3 素材加入列表', g3ok, '|'.join(g3rows))
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)

    pg.evaluate("document.getElementById('btn-engine-config').click(); true"); pg.wait_for_timeout(300)
    log('H1 设置弹窗打开', not pg.evaluate("document.getElementById('engine-modal').classList.contains('hidden')"))
    tabs = pg.evaluate("document.querySelectorAll('#engine-modal .s-nav-item').length")
    log('H2 设置 Tab 数=8', tabs==8, f'tabs={tabs}')
    pg.evaluate("document.querySelector('#cfg-theme-seg .seg-item[data-theme-opt=\\'light\\']').click(); true"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('#btn-modal-save').click(); true"); pg.wait_for_timeout(300)
    t1 = pg.evaluate("document.documentElement.dataset.theme")
    log('H3 应用后主题切浅色', t1 == 'light', f'theme={t1}')
    pg.evaluate("document.getElementById('btn-engine-config').click(); true"); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('#cfg-theme-seg .seg-item[data-theme-opt=\\'dark\\']').click(); true"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('#btn-modal-save').click(); true"); pg.wait_for_timeout(300)

    pg.evaluate("document.getElementById('btn-engine-config').click(); true"); pg.wait_for_timeout(300)
    pg.evaluate("(()=>{const s=document.getElementById('cfg-lang'); s.value='zh'; s.dispatchEvent(new Event('change',{bubbles:true}));})()"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('#btn-modal-save').click(); true"); pg.wait_for_timeout(300)
    zh = pg.evaluate("document.querySelector('#engine-modal .modal-head .t-15').textContent")
    log('H4 应用后语言切中文', '设置' in zh, zh)
    pg.evaluate("document.getElementById('btn-engine-config').click(); true"); pg.wait_for_timeout(300)
    pg.evaluate("(()=>{const s=document.getElementById('cfg-lang'); s.value='en'; s.dispatchEvent(new Event('change',{bubbles:true}));})()"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('#btn-modal-save').click(); true"); pg.wait_for_timeout(300)

    pg.evaluate("document.getElementById('btn-engine-config').click(); true"); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('#engine-modal .s-nav-item[data-mtab=\\'llm\\']').click(); true"); pg.wait_for_timeout(300)
    pg.evaluate("(()=>{const i=document.getElementById('cfg-llm-key'); i.type='password'; document.getElementById('btn-key-eye').click();})()"); pg.wait_for_timeout(200)
    log('H5 Key 眼睛切换明文', pg.evaluate("document.getElementById('cfg-llm-key').type")=='text')
    pg.evaluate("document.querySelector('#engine-modal .s-nav-item[data-mtab=\\'general\\']').click(); true"); pg.wait_for_timeout(300)
    zhOn = pg.evaluate("document.querySelector('#cfg-zh-seg .seg-item.active').dataset.zhOpt")
    pg.evaluate("document.querySelector('#cfg-zh-seg .seg-item[data-zh-opt=\\'off\\']').click(); true"); pg.wait_for_timeout(300)
    zhOff = pg.evaluate("document.querySelector('#cfg-zh-seg .seg-item.active').dataset.zhOpt")
    log('H6 中文字幕开关切换', zhOn=='on' and zhOff=='off', f'{zhOn}->{zhOff}')
    pg.evaluate("document.querySelector('#btn-modal-save').click(); true"); pg.wait_for_timeout(300)
    log('H7 设置保存到 localStorage', 'telg-settings' in pg.evaluate("Object.keys(localStorage)"))

    pg.keyboard.press('Space'); pg.wait_for_timeout(300)
    log('I1 Space 暂停生效', pg.evaluate("state.playing") is False)
    pg.keyboard.press('Space'); pg.wait_for_timeout(200)
    pg.evaluate("document.getElementById('btn-pb-speed').click(); true"); pg.wait_for_timeout(300)
    pg.evaluate("(()=>{const t=Array.from(document.querySelectorAll('#speed-menu button')).find(x=>x.textContent.trim().startsWith('1.5')); t.click();})()"); pg.wait_for_timeout(200)
    log('I2 倍速切 1.5x', pg.evaluate("document.getElementById('pb-speed-label').textContent")=='1.5x', pg.evaluate("document.getElementById('pb-speed-label').textContent"))
    pg.evaluate("nextSentence(); true"); pg.wait_for_timeout(200)
    idx1 = pg.evaluate("currentSegIndex()")
    pg.evaluate("prevSentence(); true"); pg.wait_for_timeout(200)
    idx2 = pg.evaluate("currentSegIndex()")
    log('I3 K/J 前后句切换', idx1>idx2, f'{idx2}->{idx1}')
    _i4b = pg.evaluate("document.getElementById('inspector').classList.contains('hidden')")
    pg.evaluate("document.getElementById('btn-pb-subs').click(); true"); pg.wait_for_timeout(600)
    _i4a = pg.evaluate("document.getElementById('inspector').classList.contains('hidden')")
    log('I4 详情面板切换', _i4b != _i4a, f'{_i4b}->{_i4a}')
    pg.evaluate("document.getElementById('btn-pb-subs').click(); true"); pg.wait_for_timeout(200)

    pg.set_viewport_size({'width':900,'height':700}); pg.wait_for_timeout(500)
    ov1 = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    log('J1 900px 无横向溢出', ov1<=0, f'overflow={ov1}')
    pg.set_viewport_size({'width':620,'height':700}); pg.wait_for_timeout(500)
    ov2 = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    log('J2 620px 无横向溢出', ov2<=0, f'overflow={ov2}')

    print('\n===== SUMMARY =====', flush=True)
    passed = sum(1 for _,ok,_ in results if ok)
    print(f'{passed}/{len(results)} passed', flush=True)
    print('JS errors:', errs, flush=True)
    print('console errors:', cons[:5], flush=True)
    b.close()

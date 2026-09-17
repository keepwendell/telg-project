# -*- coding: utf-8 -*-
import os
from playwright.sync_api import sync_playwright
R=[]; 
def log(n,ok,d=''):
    R.append((n,ok)); print(('PASS' if ok else 'FAIL'),'|',n,('| '+d if d else ''),flush=True)
with sync_playwright() as p:
    CHROME = '/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome'
    b = p.chromium.launch(**({'executable_path': CHROME, 'args': ['--no-sandbox']} if os.path.exists(CHROME) else {'args': ['--no-sandbox']}))
    pg=b.new_page(viewport={'width':1440,'height':900})
    errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.add_init_script("try{localStorage.setItem('telg-test-data','tire'); localStorage.setItem('telg-onboarding', JSON.stringify({done:true,at:Date.now()})); localStorage.setItem('telg-llm-mock','1'); localStorage.setItem('telg-tts-mock','1');}catch(e){}")
    pg.goto('file:///home/user/Doubao/chats/38441710896760066/telg-project/frontend/index.html'); pg.wait_for_timeout(500)
    pg.evaluate("localStorage.clear(); localStorage.setItem('telg-test-data','tire'); localStorage.setItem('telg-onboarding', JSON.stringify({done:true,at:Date.now()})); localStorage.setItem('telg-llm-mock','1'); localStorage.setItem('telg-tts-mock','1'); location.reload(); true"); pg.wait_for_timeout(700)
    # K5 详情 tab
    pg.evaluate("document.querySelector('.tab-btn[data-tab=\\'vocab\\']').click(); true"); pg.wait_for_timeout(200)
    log('K5a 详情 Vocab Tab', not pg.evaluate("document.getElementById('panel-vocab').classList.contains('hidden')"))
    pg.evaluate("document.querySelector('.tab-btn[data-tab=\\'questions\\']').click(); true"); pg.wait_for_timeout(200)
    log('K5b 详情 Quiz Tab', not pg.evaluate("document.getElementById('panel-questions').classList.contains('hidden')"))
    pg.evaluate("document.querySelector('.tab-btn[data-tab=\\'patterns\\']').click(); true"); pg.wait_for_timeout(200)
    log('K5c 详情 Patterns Tab', not pg.evaluate("document.getElementById('panel-patterns').classList.contains('hidden')"))
    pg.evaluate("document.querySelector('.tab-btn[data-tab=\\'grounding\\']').click(); true"); pg.wait_for_timeout(200)
    # K1 句子点击 seek（先切回 transcript 视图）
    pg.evaluate("document.querySelector('.tab-btn[data-tab=\\'grounding\\']').click(); true"); pg.wait_for_timeout(150)
    pg.evaluate("document.querySelectorAll('#transcript-list .trow')[2].click(); true"); pg.wait_for_timeout(200)
    pg.evaluate("(()=>{const c=currentArtifact(); if(!c || !c.meta.audioReady){ const m=state.library.find(x=>x.meta&&x.meta.audioReady); if(m) playArtifact(m); } return true;})()"); pg.wait_for_timeout(400)
    pg.evaluate("(()=>{if(document.querySelectorAll('#transcript-list .trow').length<3){seekSentence(2,false); return 'fallback';} document.querySelectorAll('#transcript-list .trow')[2].click(); return 'click';})()"); pg.wait_for_timeout(200)
    log('K1 句子点击 seek', pg.evaluate("state.time") > 0, f'time={pg.evaluate("state.time")}')
    # K4 导出 MD
    pg.evaluate("document.getElementById('btn-md-export').click(); true"); pg.wait_for_timeout(400)
    log('K4 导出 MD 触发下载/提示', pg.evaluate("document.querySelector('.toast') ? (document.querySelector('.toast').textContent.includes('Markdown')||document.querySelector('.toast').textContent.includes('导出')) : false"), pg.evaluate("document.querySelector('.toast')?document.querySelector('.toast').textContent:''"))
    # K8 重置默认值（生成面板）
    pg.evaluate("document.getElementById('btn-lib-gen').click(); true"); pg.wait_for_timeout(200)
    pg.evaluate("(()=>{state.genScene.context='XX'; const t=document.getElementById('gen-context'); if(t)t.value='XX'; const btn=document.getElementById('btn-reset'); if(btn) btn.click(); return state.genScene.context;})()"); pg.wait_for_timeout(200)
    log('K8 生成面板重置', pg.evaluate("(state.genScene.context||'')")!='XX')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    # K3 删除当前素材
    pg.evaluate("(()=>{const it=document.querySelector('.lib-item.active'); it.querySelector('.lib-item-actions [data-act=\\'delete\\']').click();})()"); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('#confirm-modal .btn-danger').click(); true"); pg.wait_for_timeout(400)
    log('K3 删除当前素材后仍可播放', pg.evaluate("document.querySelector('.lib-item.active')") is not None and pg.evaluate("document.getElementById('pb-title').textContent")!='—')
    # K7 浅色主题
    pg.evaluate("document.getElementById('btn-theme').click(); true"); pg.wait_for_timeout(300)
    log('K7 浅色主题切换', pg.evaluate("document.documentElement.dataset.theme")=='light')
    pg.evaluate("document.getElementById('btn-theme').click(); true"); pg.wait_for_timeout(200)
    # K6 480px
    pg.set_viewport_size({'width':480,'height':800}); pg.wait_for_timeout(400)
    ov=pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    log('K6 480px 无横向溢出', ov<=0, f'overflow={ov}')
    # K9 Edit Corpus（原 Regenerate 已合并）
    pg.set_viewport_size({'width':1440,'height':900}); pg.wait_for_timeout(300)
    pg.evaluate("(()=>{const b=document.getElementById('btn-refine'); if(b){b.click(); return true;} return false;})()"); pg.wait_for_timeout(300)
    log('K9 Edit Corpus 入口存在', pg.evaluate("!document.getElementById('adjust-modal').classList.contains('hidden')"))
    # K2 生成中切换素材（竞态）
    pg.evaluate("document.getElementById('btn-lib-gen').click(); true"); pg.wait_for_timeout(200)
    pg.evaluate("document.getElementById('btn-generate').click(); true"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelectorAll('.lib-item')[0].click(); true"); pg.wait_for_timeout(1200)
    log('K2 生成中切换素材无崩溃', len(errs)==0)
    print('SUMMARY', sum(1 for _,ok in R if ok), '/', len(R), '| errs:', errs, flush=True)
    b.close()

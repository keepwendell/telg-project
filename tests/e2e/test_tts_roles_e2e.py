# -*- coding: utf-8 -*-
"""重构验证：音色角色独立行 + 试听融合 + 布局对齐 + 视觉反馈"""
from playwright.sync_api import sync_playwright
R=[]
def log(n,ok,d=''):
    R.append((n,ok)); print(('PASS' if ok else 'FAIL'),'|',n,('| '+d if d else ''),flush=True)
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/opt/vm/preinstall/ms-playwright/chromium-1169/chrome-linux/chrome',args=['--no-sandbox'])
    pg=b.new_page(viewport={'width':1440,'height':900})
    errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.add_init_script("try{localStorage.setItem('telg-test-data','tire')}catch(e){}")
    pg.goto('file:///home/user/Doubao/chats/38441710896760066/telg-project/frontend/index.html'); pg.wait_for_timeout(500)
    pg.evaluate("localStorage.clear(); localStorage.setItem('telg-test-data','tire'); location.reload(); true"); pg.wait_for_timeout(700)
    pg.evaluate("document.getElementById('btn-engine-config').click(); true"); pg.wait_for_timeout(300)
    pg.evaluate("document.querySelector('#engine-modal .s-nav-item[data-mtab=\\'tts\\']').click(); true"); pg.wait_for_timeout(300)
    # 1. Voice Roles 标题与其他设置项标题对齐（x 坐标一致）
    xs = pg.evaluate("(()=>{const names=Array.from(document.querySelectorAll('#mp-tts .s-name')).map(n=>Math.round(n.getBoundingClientRect().x)); return names;})()")
    log('L1 标题与 TTS Provider 对齐', len(xs)>=3 and xs[0]==xs[2], f'x={xs}')
    # 2. 说明文案精简（<40 字符）
    desc = pg.evaluate("(()=>{const d=Array.from(document.querySelectorAll('#mp-tts .s-row-stack .s-desc'))[0]; return d?d.textContent.trim():'';})()")
    log('L2 说明无符号且精简', ('▶' not in desc and 'emo' not in desc.lower() and len(desc)<40), f'len={len(desc)} | {desc}')
    # 3. 输入框加长（高度≥44px）且全宽
    h = pg.evaluate("(()=>{const i=document.getElementById('cfg-tts-test-text'); return Math.round(i.getBoundingClientRect().height);})()")
    w = pg.evaluate("(()=>{const i=document.getElementById('cfg-tts-test-text'); return Math.round(i.getBoundingClientRect().width);})()")
    zoneW = pg.evaluate("(()=>{const z=document.querySelector('.tts-voice-zone'); return Math.round(z.getBoundingClientRect().width);})()")
    isTA = pg.evaluate("document.getElementById('cfg-tts-test-text').tagName==='TEXTAREA'")
    log('L3 textarea 四行高且全宽', isTA and h>=96 and w>=zoneW-2, f'textarea={isTA} {h}px高 × {w}px宽')
    # 4. Add role 与状态框分两行（foot 只含 Add role，状态独立）
    footKids = pg.evaluate("(()=>{const f=document.querySelector('.tts-voice-foot'); return f?f.children.length:0;})()")
    resSibling = pg.evaluate("(()=>{const r=document.getElementById('tts-test-result'); return r && r.parentElement.className.includes('tts-voice-zone') && !r.parentElement.querySelector('.tts-voice-foot')?.contains(r);})()")
    log('L4 Add role 与状态框分行', footKids==1 and resSibling, f'foot={footKids}')
    # 5. 角色行独立 + 含试听/删除
    rows = pg.evaluate("(()=>{const rs=document.querySelectorAll('#voice-roles .voice-role-row'); return Array.from(rs).map(r=>({name:r.querySelector('.role-name')?r.querySelector('.role-name').value:'', hasSel:!!r.querySelector('select'), hasTest:!!r.querySelector('.btn-role-test'), hasDel:!!r.querySelector('.btn-role-del')}));})()")
    log('L5 角色每行独立含试听/删除', len(rows)>=2 and all(r['hasTest'] and r['hasDel'] and r['hasSel'] for r in rows), str(rows))
    # 6. 点击试听 → loading 视觉反馈出现
    pg.evaluate("document.querySelectorAll('#voice-roles .btn-role-test')[0].click(); true")
    pg.wait_for_timeout(120)
    loading = pg.evaluate("document.querySelectorAll('#voice-roles .btn-role-test')[0].classList.contains('loading')")
    pg.wait_for_timeout(1200)
    done = not pg.evaluate("document.querySelectorAll('#voice-roles .btn-role-test')[0].classList.contains('loading')")
    cls = pg.evaluate("document.getElementById('tts-test-result').className")
    log('L6 试听点击有 loading 反馈并完成', loading and done and 'ok' in cls, f'loading={loading} done={done} {cls}')
    # 7. 统一文本输入框共享（修改文本后另一角色试听）
    pg.evaluate("(()=>{const i=document.getElementById('cfg-tts-test-text'); i.value='Can we recheck the yaw rate feedback loop before the release?';})()"); pg.wait_for_timeout(100)
    pg.evaluate("document.querySelectorAll('#voice-roles .btn-role-test')[1].click(); true"); pg.wait_for_timeout(1200)
    log('L7 自定义文本后试听可用', 'ok' in pg.evaluate("document.getElementById('tts-test-result').className"))
    # 8. Add role 增加一行
    pg.evaluate("document.getElementById('btn-role-add').click(); true"); pg.wait_for_timeout(200)
    n = pg.evaluate("document.querySelectorAll('#voice-roles .voice-role-row').length")
    log('L8 添加角色生效', n==3, f'rows={n}')
    # 9. 无 JS 错误
    log('L9 无 JS 错误', len(errs)==0, '; '.join(errs[:2]))
    # 10. 窄屏 620px 无溢出
    pg.set_viewport_size({'width':620,'height':760}); pg.wait_for_timeout(400)
    ov = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    log('L10 620px 设置页无横向溢出', ov<=0, f'overflow={ov}')
    print('SUMMARY', sum(1 for _,ok in R if ok),'/',len(R),flush=True)
    b.close()

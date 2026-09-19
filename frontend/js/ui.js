/* ============================================================
   Scenear — UI Motion Layer (js/ui.js)
   动效增强层。依赖（均在 frontend/vendor/ 本地化）：
     · vendor/motion.min.js            → window.Motion
     · vendor/floating-ui.core.umd.min.js → window.FloatingUICore
     · vendor/floating-ui.dom.umd.min.js  → window.FloatingUIDOM
   设计约束：
     · 增强均为附加层：库缺失 / 环境不支持 / prefers-reduced-motion
       时静默降级，不抛错、不阻塞业务逻辑（业务在 player.js/state.js/i18n.js）
     · 不修改 DOM 结构、class、id（Playwright e2e 基线保护）
     · 时长/缓动读取 tokens.css 的动效 Token（--dur-* / --ease-*）
   对外暴露 window.Ui
   ============================================================ */
(function () {
  'use strict';

  var M = window.Motion || null;
  var FD = window.FloatingUIDOM || null;
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* CSS duration tokens carry milliseconds (e.g. 120ms); Motion's `duration`
     and `delay` are expressed in SECONDS, so tokens are converted once here.
     (Passing ms straight through made every animation run ~1000x too slow, so
     containers that faded in from opacity 0 — e.g. the font menu — stayed
     effectively invisible.) */
  function tokenSec(name, fallbackMs) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return (v ? parseFloat(v) : fallbackMs) / 1000;
    } catch (e) { return fallbackMs / 1000; }
  }
  var DUR = {
    fast: tokenSec('--dur-fast', 120),
    base: tokenSec('--dur-base', 200),
    slow: tokenSec('--dur-slow', 320)
  };

  function noop() {}

  var Ui = {
    reduced: REDUCED,
    getDur: function (n) { return DUR[n] || DUR.base; },

    /* ---------- 基础动效工具（全部带降级） ---------- */

    /* 淡入：opacity 0→1（降级/减少动效时直接可见） */
    fadeIn: function (el, opts) {
      if (!el) return;
      opts = opts || {};
      if (!M || REDUCED || opts.instant) { el.style.opacity = ''; el.style.transform = ''; return; }
      M.animate(el, { opacity: [0, 1] }, { duration: opts.duration || DUR.base, delay: opts.delay || 0, easing: 'ease-out' });
    },

    /* 淡出：完成后回调（供隐藏流程使用） */
    fadeOut: function (el, opts) {
      if (!el) return;
      opts = opts || {};
      if (!M || REDUCED || opts.instant) { el.style.opacity = ''; return; }
      M.animate(el, { opacity: [1, 0] }, { duration: opts.duration || DUR.base, easing: 'ease-in', onComplete: opts.done || noop });
    },

    /* 上滑淡入（toast / 面板提示） */
    slideIn: function (el, opts) {
      if (!el) return;
      opts = opts || {};
      if (!M || REDUCED || opts.instant) { el.style.opacity = ''; el.style.transform = ''; return; }
      M.animate(el, { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0)'] },
        { duration: opts.duration || DUR.base, delay: opts.delay || 0, easing: 'ease-out' });
    },

    /* 弹窗卡片入场：spring 弹入（更大幅度 + 弹性） */
    popIn: function (el, opts) {
      if (!el) return;
      opts = opts || {};
      if (!M || REDUCED || opts.instant) { el.style.opacity = ''; el.style.transform = ''; return; }
      M.animate(el,
        { opacity: [0, 1], scale: [0.92, 1], y: [16, 0] },
        { type: 'spring', stiffness: 260, damping: 20, delay: opts.delay || 0 });
    },

    /* 列表交错入场（stagger） */
    staggerIn: function (els, opts) {
      if (!els || !els.length) return;
      opts = opts || {};
      if (!M || REDUCED || opts.instant) { return; }
      M.animate(els, { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0)'] },
        { duration: opts.duration || DUR.base, delay: M.stagger((opts.stagger || 40) / 1000), easing: 'ease-out' });
    },

    /* toast 图标回弹（完成态反馈） */
    popIcon: function (el) {
      if (!el || !M || REDUCED) return;
      M.animate(el, { transform: ['scale(.4)', 'scale(1.15)', 'scale(1)'] },
        { duration: 0.32, easing: [0.22, 0.61, 0.36, 1] });
    },

    /* ---------- tooltip：接入 Floating UI 定位 ---------- */
    /* 覆写全局 positionTip（i18n.js 定义，API 签名不变），保留 #telg-tip 样式与 --arrow-x */
    enhanceTooltip: function () {
      if (!FD) return;
      var tip = document.getElementById('telg-tip');
      if (!tip || typeof window.positionTip !== 'function') return;
      window.positionTip = function (anchor) {
        if (!anchor || !tip.classList.contains('show')) return;
        FD.computePosition(anchor, tip, {
          placement: 'bottom',
          middleware: [FD.offset(10), FD.flip(), FD.shift({ padding: 12 })]
        }).then(function (pos) {
          if (!tip.classList.contains('show')) return;  /* 定位期间已隐藏则放弃 */
          tip.style.left = pos.x + 'px';
          tip.style.top = pos.y + 'px';
          var above = pos.placement.indexOf('top') === 0;
          tip.classList.toggle('above', above);
          var r = anchor.getBoundingClientRect();
          var ax = r.left + r.width / 2 - pos.x;
          tip.style.setProperty('--arrow-x', Math.max(14, Math.min(tip.offsetWidth - 14, ax)) + 'px');
        }).catch(noop);
      };
    },

    /* ---------- 全局挂接 ---------- */

    /* 弹窗卡片入场增强：监听 .modal-overlay 从 hidden 变可见时，spring 弹入 */
    enhanceModal: function () {
      if (!M || REDUCED) return;
      var self = this;
      var SEL = '.modal-overlay, .gen-panel, .adjust-modal, .onboard-modal';
      var obs = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          if (m.attributeName !== 'class') return;
          var el = m.target;
          if (el.classList.contains('hidden')) return;
          var card = el.querySelector('.gen-card, .modal, .confirm-box, .onboard-card');
          if (!card || card.dataset.uiPopDone) return;
          card.dataset.uiPopDone = '1';
          self.popIn(card);
        });
      });
      document.querySelectorAll(SEL).forEach(function (el) {
        obs.observe(el, { attributes: true, attributeFilter: ['class'] });
      });
    },

    /* ---------- 按钮按压回弹（全局事件委托） ---------- */
    enhancePress: function () {
      if (!M || REDUCED) return;
      var SEL = '.btn, .btn-icon, .seg-item, .chip, .lib-act, .pb-controls button, .lib-new-btn, .zh-toggle';
      document.addEventListener('pointerdown', function (e) {
        var el = e.target.closest(SEL);
        if (!el) return;
        M.animate(el, { scale: 0.93 }, { type: 'spring', stiffness: 600, damping: 25 });
      });
      document.addEventListener('pointerup', function (e) {
        var el = e.target.closest(SEL);
        if (!el) return;
        M.animate(el, { scale: 1 }, { type: 'spring', stiffness: 350, damping: 15 });
      });
      document.addEventListener('pointercancel', function (e) {
        var el = e.target.closest(SEL);
        if (!el) return;
        M.animate(el, { scale: 1 }, { type: 'spring', stiffness: 350, damping: 15 });
      });
    },

    /* ---------- seg 滑动指示器 ---------- */
    /* 给等宽 segmented control 注入滑动滑块；active 项背景由滑块承担 */
    _positionSegThumb: function (seg, thumb, animate) {
      var items = seg.querySelectorAll('.seg-item');
      var active = seg.querySelector('.seg-item.active');
      if (!active || !items.length) return;
      var cs = getComputedStyle(seg);
      var padL = parseFloat(cs.paddingLeft) || 0;
      var padT = parseFloat(cs.paddingTop) || 0;
      var x = active.offsetLeft;          /* 相对 seg（position:relative） */
      var w = active.offsetWidth;
      thumb.style.width = w + 'px';
      thumb.style.top = padT + 'px';
      thumb.style.left = padL + 'px';
      thumb.style.bottom = padT + 'px';
      var tx = x - padL;
      thumb.style.transform = 'translateX(' + tx + 'px)';
    },
    enhanceSeg: function (seg) {
      if (!seg || seg.dataset.uiSeg) return;
      seg.dataset.uiSeg = '1';
      seg.classList.add('has-seg-thumb');
      var thumb = document.createElement('div');
      thumb.className = 'seg-thumb';
      seg.appendChild(thumb);
      var self = this;
      this._positionSegThumb(seg, thumb, false);
      seg.addEventListener('click', function () {
        /* 等业务侧（renderGenScene）同步更新 active class 后再定位 */
        setTimeout(function () { self._positionSegThumb(seg, thumb, true); }, 0);
      });
    },
    enhanceSegAll: function () {
      var segs = document.querySelectorAll('.seg');
      for (var i = 0; i < segs.length; i++) this.enhanceSeg(segs[i]);
    },
    /* 重排所有已注入的 seg 滑块（容器从 hidden 变可见后尺寸才有效） */
    layoutSegThumbs: function () {
      var segs = document.querySelectorAll('.seg.has-seg-thumb');
      for (var i = 0; i < segs.length; i++) {
        this._positionSegThumb(segs[i], segs[i].querySelector('.seg-thumb'), false);
      }
    },

    enhance: function () {
      this.enhanceTooltip();
      this.enhanceSegAll();
      this.enhancePress();
      this.enhanceModal();
    }
  };

  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        if (M && !REDUCED) document.body.classList.add('ui-motion-on');
        Ui.enhance();
      });
    } else {
      if (M && !REDUCED) document.body.classList.add('ui-motion-on');
      Ui.enhance();
    }
  }
  init();

  window.Ui = Ui;
})();

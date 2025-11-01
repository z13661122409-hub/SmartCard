// ===== SmartCard content.js =====
// 说明：运行在扩展的 content-script 环境，负责：注入 inpage.js、UI（悬浮按钮 + 右下角结果面板）、
// 选择文本 -> 发送请求 -> 接收结果 -> 展示。
// —— i18n：走 Chrome 扩展 _locales，新增语言只需加 messages.json；缺失时回退到 fallback 或 key。
const L = (key, fallback = "") =>
  (globalThis.chrome?.i18n?.getMessage?.(key)) || fallback || key;

// 当前 Chrome UI 语言（跟随浏览器界面语言）
const UI_LANG = (globalThis.chrome?.i18n?.getUILanguage?.() || navigator.language || "en").toLowerCase();

// ---------- 注入 inpage.js 到页面主世界 ----------
const s = document.createElement('script');
s.src = chrome.runtime.getURL('inpage.js');
s.async = false;
(document.head || document.documentElement).appendChild(s);
s.remove();

// ---------- DOM 工具 ----------
function createEl(tag, className, html) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (html != null) el.innerHTML = html;
  return el;
}
function on(el, ev, fn) { el.addEventListener(ev, fn, false); }

// ---------- 悬浮操作泡泡 ----------
let bubble = null;
let lastSelectionText = '';

function ensureBubble() {
  if (bubble) return bubble;

  bubble = createEl('div', 'smartcard-bubble');
  bubble.style.cssText = `
    position: absolute;
    z-index: 2147483647;
    display: none;
    background: #111;
    color: #fff;
    border-radius: 10px;
    padding: 6px 8px;
    box-shadow: 0 4px 14px rgba(0,0,0,.25);
    font-size: 12px;
    user-select: none;
    gap: 6px;
    align-items: center;
  `;

  const TYPE_NAME = {
    sum: L('op_summary', 'Summary'),
    tr:  L('op_translate', 'Translate'),
    fix: L('op_polish', 'Polish')
  };

  const mkBtn = (key, type) => {
    const b = createEl('button', 'smartcard-btn', L(key, TYPE_NAME[type] || type));
    b.style.cssText = `
      all: unset;
      cursor: pointer;
      background: #373737ff;
      padding: 4px 8px;
      border-radius: 8px;
      font-weight: 600;
    `;
    on(b, 'mouseenter', () => { b.style.opacity = '0.9'; });
    on(b, 'mouseleave', () => { b.style.opacity = '1'; });
    on(b, 'click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = (window.getSelection()?.toString() || '').trim();
      const payload = text || lastSelectionText || '';
      if (!payload) return;
      requestToInpage(type, payload);
      // 不隐藏 bubble；用户可继续点其它操作或点击空白处隐藏
    });
    return b;
  };

  bubble.appendChild(mkBtn('btn_summary',  'sum'));
  bubble.appendChild(mkBtn('btn_translate', 'tr'));
  bubble.appendChild(mkBtn('btn_polish',   'fix'));

  document.documentElement.appendChild(bubble);
  return bubble;
}

function showBubbleAtRange(range) {
  const b = ensureBubble();
  const rect = range.getBoundingClientRect();
  b.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
  b.style.top  = `${Math.max(8, rect.top + window.scrollY - 36)}px`;
  b.style.display = 'flex';
}
function hideBubble() {
  if (bubble) bubble.style.display = 'none';
}

// 选区监听：抬起鼠标时，如果有文本则显示泡泡
on(document, 'mouseup', () => {
  const sel = window.getSelection();
  const text = (sel && sel.toString()) ? sel.toString().trim() : '';
  lastSelectionText = text;
  if (text && sel.rangeCount > 0) {
    showBubbleAtRange(sel.getRangeAt(0));
  } else {
    hideBubble();
  }
});
// 点击页面空白处隐藏泡泡
on(document, 'mousedown', (e) => {
  if (!bubble) return;
  if (!bubble.contains(e.target)) hideBubble();
});

// ---------- 右下角结果面板 ----------
let panel = null;
let panelBody = null;

function ensurePanel() {
  if (panel) return panel;

  panel = createEl('div', 'smartcard-panel');
  panel.style.cssText = `
    position: fixed;
    right: 18px;
    bottom: 18px;
    width: min(520px, calc(100vw - 48px));
    max-height: min(60vh, 560px);
    z-index: 2147483647;
    background: #0b1020;
    color: #eaeef2;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px;
    box-shadow: 0 10px 24px rgba(0,0,0,.35);
    display: none;
    overflow: hidden;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji";
  `;

  const header = createEl('div', 'smartcard-panel-header', L('app_name', 'SmartCard'));
  header.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    font-weight: 700; padding: 10px 12px; background: rgba(255,255,255,0.06);
  `;

  const close = createEl('button', 'smartcard-close', '×');
  close.title = L('tip_close', 'Close (Esc)');
  close.style.cssText = `
    all: unset; cursor: pointer; font-size: 18px; line-height: 1;
    width: 28px; height: 28px; text-align: center; border-radius: 8px;
  `;
  on(close, 'click', () => hidePanel());
  header.appendChild(close);

  panelBody = createEl('div', 'smartcard-panel-body');
  panelBody.style.cssText = `
    padding: 12px; overflow: auto; white-space: pre-wrap;
    word-break: break-word; overflow-wrap: anywhere; font-size: 14px;
  `;

  panel.appendChild(header);
  panel.appendChild(panelBody);
  document.documentElement.appendChild(panel);

  // Esc 隐藏
  on(window, 'keydown', (e) => {
    if (e.key === 'Escape') hidePanel();
  });

  return panel;
}

function showPanel(html) {
  const p = ensurePanel();
  panelBody.innerHTML = html;
  p.style.display = 'block';
}
function hidePanel() {
  if (panel) panel.style.display = 'none';
}

// ---------- 与 inpage 通信 ----------
function requestToInpage(type, text) {
  document.dispatchEvent(new CustomEvent('SMARTCARD_REQUEST', { detail: { type, text } }));
  const TYPE_NAME = {
    sum: L('op_summary', 'Summary'),
    tr:  L('op_translate', 'Translate'),
    fix: L('op_polish', 'Polish')
  };
  showPanel(`<div style="opacity:.8">${L('status_processing', 'Processing…')} (${TYPE_NAME[type] || type})</div>`);
}

document.addEventListener('SMARTCARD_RESPONSE', (e) => {
  const { ok, type, result, error } = e.detail || {};
  if (!ok) {
    const prefix = L('error_prefix', 'Error');
    const unknown = L('error_unknown', 'Unknown error');
    showPanel(`<div style="color:#ffb4b4">❌ ${prefix}${type ? ` (${type})` : ''}: ${error || unknown}</div>`);
  } else {
    showPanel(`${result || ''}`);
  }
});

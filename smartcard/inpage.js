// ===== SmartCard inpage.js =====
// 说明：运行在页面主世界，使用 On-Device APIs（Summarizer / Translator / LanguageDetector）。
const SMARTCARD_VER = '0.2.0';
const TAG = `[SmartCard/inpage ${SMARTCARD_VER}]`;
console.debug(TAG, 'loaded');

// 小工具：派发结果到 content.js
function post(type, detail) {
  document.dispatchEvent(new CustomEvent(type, { detail }));
}

// -------- 语言规范化 & 侦测 --------
function normalizeLang(tag) {
  if (!tag || typeof tag !== 'string') return 'en';
  const t = tag.toLowerCase();
  // 中文细分
  if (t.startsWith('zh')) {
    if (t.includes('hant') || t.includes('tw') || t.includes('hk') || t.includes('mo')) return 'zh-Hant';
    return 'zh';
  }
  // 只保留主子标
  return t.split('-')[0];
}

function getSystemLang() {
  const raw = (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage)
    ? chrome.i18n.getUILanguage()
    : (navigator.language || 'en');
  return normalizeLang(raw);
}

// 简单字符启发式（当 LanguageDetector 不可用时兜底）
function guessByChars(text) {
  if (/[\u4E00-\u9FFF]/.test(text)) { // CJK
    return 'zh';
  }
  if (/[а-яё]/i.test(text)) return 'ru';
  if (/[ぁ-ゟ゠-ヿ]/.test(text)) return 'ja';
  if (/[가-힣]/.test(text)) return 'ko';
  return 'en';
}

async function detectSourceLanguage(text) {
  try {
    if (!('LanguageDetector' in self)) throw new Error('no-detector');
    const det = await LanguageDetector.create();
    // 兼容不同实现的返回结构
    const r = await det.detect(text);
    const code =
      r?.detectedLanguage ||
      r?.language ||
      (Array.isArray(r) ? (r[0]?.detectedLanguage || r[0]?.language) : null);
    return normalizeLang(code || guessByChars(text));
  } catch {
    return normalizeLang(guessByChars(text));
  }
}

// -------- Summarizer --------
let summarizerInstance = null;

async function ensureSummarizer() {
  if (!('Summarizer' in self)) {
    throw new Error('Summarizer API 不可用（需 Chrome 开启 On-Device Summarization）');
  }
  if (summarizerInstance) return summarizerInstance;

  const availability = await Summarizer.availability();
  if (availability === 'unavailable') {
    throw new Error('Summarizer 不可用（语言包/版本/硬件）');
  }
  // 注意：Summarizer 官方当前明确支持 outputLanguage: en / es / ja。
  summarizerInstance = await Summarizer.create({
    type: 'key-points',
    format: 'markdown',
    length: 'medium',
    position: 'auto',
    contextSize: 60,
    outputLanguage: 'en'
  });
  return summarizerInstance;
}

// -------- Translator（多语言自动策略）--------
async function ensureTranslatorPair(sourceLanguage, targetLanguage) {
  if (!('Translator' in self)) {
    throw new Error('Translator API 不可用（需 Chrome 开启 On-Device Translation）');
  }
  // 不允许 'auto'；必须用显式语言标签
  const av = await Translator.availability({ sourceLanguage, targetLanguage });
  if (av === 'unavailable') {
    throw new Error(`Translator 不可用：缺少「${sourceLanguage}→${targetLanguage}」语言包/不支持`);
  }
  // 可读（已装好）或可下载（自动拉取模型）都直接创建
  return Translator.create({
    sourceLanguage,
    targetLanguage,
    monitor: s => console.debug(TAG, 'Translator status', s?.status || s)
  });
}

// 统一的“智能翻译”入口：
// 1) 源语不是 en → 译到 en
// 2) 源语是 en → 译到系统 UI 语言（若系统也是 en → 提示无需翻译）
async function translateSmart(text) {
  const src = await detectSourceLanguage(text);
  const sys = getSystemLang();

  if (src === 'en') {
    if (sys === 'en') {
      return { noTranslation: true, message: 'No translation needed (already English)' };
    }
    const tr = await ensureTranslatorPair('en', sys);
    const out = await tr.translate(text);
    return { from: 'en', to: sys, text: out };
  } else {
    const tr = await ensureTranslatorPair(src, 'en');
    const out = await tr.translate(text);
    return { from: src, to: 'en', text: out };
  }
}

// -------- Fixer（用 Summarizer 做轻量润色/改写）--------
async function fixText(text) {
  // 这里沿用 Summarizer，给它一个“改写提示”
  const sm = await ensureSummarizer();
  const prompt = `Rewrite the following text to be clearer and more concise. Preserve meaning.\n\n---\n${text}`;
  // 有的实现提供 summarize()；也有 rewriter API。这里复用 summarize 形成要点式“清晰版”。
  return sm.summarize(prompt);
}

// -------- 请求分发 --------
document.addEventListener('SMARTCARD_REQUEST', async (e) => {
  const { type, text } = (e && e.detail) || {};
  if (!text || !text.trim()) {
    post('SMARTCARD_RESPONSE', { ok: false, type, error: '没有可处理的文本。' });
    return;
  }
  try {
    if (type === 'sum') {
      const sm = await ensureSummarizer();
      const res = await sm.summarize(text);
      post('SMARTCARD_RESPONSE', { ok: true, type, result: res });
      return;
    }

    if (type === 'tr') {
      const r = await translateSmart(text);
      if (r.noTranslation) {
        post('SMARTCARD_RESPONSE', { ok: true, type, result: r.message });
      } else {
        const tag = (r.from && r.to) ? `（${r.from} → ${r.to}）\n` : '';
        post('SMARTCARD_RESPONSE', { ok: true, type, result: tag + r.text });
      }
      return;
    }

    if (type === 'fix') {
      const res = await fixText(text);
      post('SMARTCARD_RESPONSE', { ok: true, type, result: res });
      return;
    }

    post('SMARTCARD_RESPONSE', { ok: false, type, error: '未知的操作类型。' });
  } catch (err) {
    post('SMARTCARD_RESPONSE', { ok: false, type, error: String(err && err.message || err) });
  }
});

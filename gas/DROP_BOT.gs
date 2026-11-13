/**
 * DROP.Bot（対話型の投稿コーチ）— Google Apps Script（Web アプリ）
 * ------------------------------------------------------------
 * index.html（GitHub Pages）から、投稿前の下書き（写真＋コメント）と会話の履歴を受け取り、
 * Azure OpenAI に「次のひとこと・次の問い・投稿案」を作らせて JSON で返す。
 * 方針は DROP_Dashboard_Shinagawa1.0 の DROP_COACH_GPT.gs（with_sample 版）を引き継ぎ、
 * 一括の改善提案ではなく「問いを 1 つずつ投げかけて、本人の言葉で投稿案を組み立てる」形にしたもの。
 *
 * ■ アクション（POST / Content-Type: text/plain / body は JSON 文字列）
 *   { "action":"login", "name":"...", "password":"..." }
 *       → { ok:true, token:"...", expires_in:秒 }
 *   { "action":"chat", "token":"...", "session":"端末で発行した会話 ID", "name":"利用者名",
 *     "command":"start|answer|summarize|revise",
 *     "draft":{ "text":"...", "name":"表示名（任意）", "image_data":"data:image/jpeg;base64,..." },   ※image_data は start のときだけ使う
 *     "image_desc":"前回返した画像の説明（start 以外）",
 *     "category":"前回の分類（A〜D）",
 *     "references":[{ "text":"...", "name":"...", "gender":"...", "age":"...", "date":"...", "image":"https://...", "image_data":"data:..." }],
 *     "history":[{ "role":"bot|user", "text":"...", "question":"（bot のとき）" }],
 *     "message":"利用者の最新のメッセージ（answer / revise）",
 *     "proposal":"現在の投稿案（revise のとき）" }
 *       → { ok:true, elapsed_ms, model, prompt_version, turn, images_used, images_note,
 *           result:{ category:{code,label}, level, image_desc, photo:{match,comment},
 *                    reply, question, aim, proposal:{text,points}, done } }
 *   エラー時 → { ok:false, code:"AUTH|LOCKED|LIMIT|BUSY|BAD_REQUEST|CONFIG|AI|SERVER", message:"..." }
 *
 * ■ スクリプトプロパティ
 *   必須
 *     APP_PASSWORD        … 画面で入力させるパスワード
 *     AZURE_API_KEY_LUNA  … Azure OpenAI の API キー（※リポジトリには絶対に書かない）
 *     PROMPT_URL          … prompt/drop_bot.md の raw URL（github.com/…/blob/… 形式でも可）
 *   任意（括弧内は既定値）
 *     LOG_SHEET_ID        （空）  … 会話ログを書き込むスプレッドシート ID。空ならログを取らない
 *     MAX_QUESTIONS (3) / MAX_PROPOSAL (200) / DAILY_LIMIT (300) / MAX_FAILS (30) / TOKEN_TTL_SEC (21600)
 *     REASONING_EFFORT (none) / MAX_OUTPUT_TOKENS (2000) / PROMPT_CACHE_SEC (300)
 *     MAX_TEXT (300) / MAX_MESSAGE (300) / MAX_HISTORY (16) / MAX_REFS (5)
 *     ENABLE_IMAGES (true) / MAX_IMAGES (4) / MAX_IMAGE_BYTES (1500000) / IMAGE_DETAIL (low)
 *     SERVER_IMAGE_FETCH (true) / IMAGE_URL_PREFIX (https://adpf-poc.com/machiapps/userdata/photos/)
 *     IMAGE_REFERER (https://adpf-poc.com/machiapps/)
 *
 * ■ デプロイ
 *   貼り替え後、エディタで checkSetup() → testChat() を実行 → デプロイを管理 → 編集 → 新バージョン（URL は変わらない）
 *   ウェブアプリ設定：次のユーザーとして実行「自分」/ アクセスできるユーザー「全員」
 *
 * ■ 貼り付け時の注意
 *   貼り付け後に「&g」+「t;」「&l」+「t;」「<a」+「 href」で検索し 0 件であることを確認すること。
 */

/* ============================== 設定 ============================== */
const AZURE_MODEL = {
  name: 'gpt-6-luna',
  deployment: 'gpt-6-luna',
  endpoint: 'https://uhr65-mkgfgxtk-eastus2.openai.azure.com',
  api_version: '2025-04-01-preview',
  secret: 'AZURE_API_KEY_LUNA'
};
const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
const DEFAULTS = {
  LOG_SHEET_ID: '',
  MAX_QUESTIONS: 3,
  MAX_PROPOSAL: 200,
  DAILY_LIMIT: 300,
  MAX_FAILS: 30,
  TOKEN_TTL_SEC: 21600,
  REASONING_EFFORT: 'none',
  MAX_OUTPUT_TOKENS: 2000,
  PROMPT_CACHE_SEC: 300,
  MAX_TEXT: 300,
  MAX_MESSAGE: 300,
  MAX_HISTORY: 16,
  MAX_REFS: 5,
  ENABLE_IMAGES: 'true',
  MAX_IMAGES: 4,
  MAX_IMAGE_BYTES: 1500000,
  IMAGE_DETAIL: 'low',
  SERVER_IMAGE_FETCH: 'true',
  IMAGE_URL_PREFIX: 'https://adpf-poc.com/machiapps/userdata/photos/',
  IMAGE_REFERER: 'https://adpf-poc.com/machiapps/'
};
const CACHE_MAX_SEC = 21600;
const FAIL_WINDOW_SEC = 900;
const KEY = { FAIL: 'bot_auth_fail', PROMPT: 'bot_prompt_v1', TOKEN: 'bot_tok_', QUOTA: 'bot_count_' };
const LEVELS = ['低', '中', '高'];
const MATCHES = ['一致', '一部一致', '不一致'];
const AIMS = ['WHAT', 'WHY', 'WHO', 'HOW', '方向'];
const CATEGORIES = {
  A: { label: '心が動いた' },
  B: { label: '人とつながった' },
  C: { label: '会社・場所の印象' },
  D: { label: 'その他' }
};
const COMMANDS = {
  start: 'start：利用者が下書きを入力して会話を始めた。下書きと画像を読み、良い点を伝えて、最初の問いを 1 つ出す（問題のない投稿なら、その旨を伝え、問いは任意で最大 1 つ）。投稿案はまだ出さない。',
  answer: 'answer：利用者が直前の問いに答えた。答えを短く受け止め、まだ聞くべきことがあれば次の問いを 1 つ出す。下書きと回答で投稿に必要なことがそろった場合は、問いを出さずに投稿案を出す。',
  summarize: 'summarize：利用者が「投稿案をつくって」と頼んだ。問いは出さず、ここまでの下書きと回答だけで投稿案を出す。',
  revise: 'revise：利用者が現在の投稿案の直しを頼んだ（最新のメッセージが希望）。希望に沿って投稿案を作り直す。投稿案のルールは守る。問いは出さない。',
  limit: 'answer（問いの上限に到達）：利用者が直前の問いに答えた。答えを短く受け止め、問いは出さずに、ここまでの下書きと回答で投稿案を出す。'
};
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif)$/i;
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const LOG_HEADERS = ['日時', '名前', '会話ID', 'ターン', '操作', '分類', 'レベル', '下書き', '利用者のメッセージ', 'ボットの返答', '問い', '投稿案', '処理秒', '画像枚数'];

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (v !== null && v !== undefined) return v;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? String(DEFAULTS[key]) : null;
}
function numProp_(key) {
  const raw = prop_(key);
  const n = Number(raw);
  return raw === null || raw === '' || !isFinite(n) ? Number(DEFAULTS[key]) : n;
}
function boolProp_(key) { return String(prop_(key)).trim().toLowerCase() !== 'false'; }
function azureUrl_() {
  return AZURE_MODEL.endpoint.replace(/\/+$/, '') +
    '/openai/deployments/' + encodeURIComponent(AZURE_MODEL.deployment) +
    '/chat/completions?api-version=' + encodeURIComponent(AZURE_MODEL.api_version);
}

/* ============================ エントリ ============================ */
function doPost(e) {
  try {
    let req;
    try {
      req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      throw new AppError('BAD_REQUEST', 'リクエストが JSON ではありません');
    }
    switch (req && req.action) {
      case 'login': return handleLogin_(req);
      case 'chat':  return handleChat_(req);
      default:      throw new AppError('BAD_REQUEST', '不明な action です');
    }
  } catch (err) {
    if (err instanceof AppError) return fail_(err.code, err.message);
    console.error((err && err.stack) || err);
    return fail_('SERVER', 'サーバーエラーが発生しました。管理者は GAS の実行ログを確認してください');
  }
}
function doGet() {
  return json_({ ok: true, service: 'drop-bot', version: 1, commands: Object.keys(COMMANDS).filter(k => k !== 'limit'), images: boolProp_('ENABLE_IMAGES'), time: new Date().toISOString() });
}

/* ============================ ログイン ============================ */
function handleLogin_(req) {
  const expected = prop_('APP_PASSWORD');
  if (!expected) throw new AppError('CONFIG', 'APP_PASSWORD が未設定です');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(KEY.FAIL) || 0);
  if (fails >= numProp_('MAX_FAILS')) {
    throw new AppError('LOCKED', 'パスワードの失敗回数が上限に達しました。15 分ほど待ってから再試行してください');
  }
  const pw = String((req && req.password) || '');
  if (!pw || !safeEqual_(sha256_(pw), sha256_(expected))) {
    cache.put(KEY.FAIL, String(fails + 1), FAIL_WINDOW_SEC);
    Utilities.sleep(800);
    throw new AppError('AUTH', 'パスワードが違います');
  }
  cache.remove(KEY.FAIL);
  const ttl = Math.min(numProp_('TOKEN_TTL_SEC'), CACHE_MAX_SEC);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put(KEY.TOKEN + sha256_(token), '1', ttl);
  return json_({ ok: true, token: token, expires_in: ttl });
}
function checkToken_(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get(KEY.TOKEN + sha256_(String(token))) === '1';
}

/* ============================== 対話 ============================== */
function handleChat_(req) {
  const t0 = Date.now();
  if (!checkToken_(req.token)) {
    throw new AppError('AUTH', 'ログインの有効期限が切れました。パスワードを再入力してください');
  }
  const apiKey = prop_(AZURE_MODEL.secret);
  if (!apiKey) throw new AppError('CONFIG', 'スクリプトプロパティ ' + AZURE_MODEL.secret + ' が未設定です');

  let command = String(req.command || '');
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command) || command === 'limit') {
    throw new AppError('BAD_REQUEST', 'command（start / answer / summarize / revise）を指定してください');
  }
  const draft = sanitizeDraft_(req.draft);
  if (!draft) throw new AppError('BAD_REQUEST', '下書きのコメントが空です');
  const history = command === 'start' ? [] : sanitizeHistory_(req.history);
  const message = sanitizeText_(req.message, numProp_('MAX_MESSAGE'));
  if ((command === 'answer' || command === 'revise') && !message) throw new AppError('BAD_REQUEST', 'メッセージが空です');
  const proposal = sanitizeText_(req.proposal, 1000);
  if (command === 'revise' && !proposal) command = 'summarize';
  const asked = history.filter(h => h.role === 'bot' && h.question).length;
  const maxQ = Math.max(1, numProp_('MAX_QUESTIONS'));
  if (command === 'answer' && asked >= maxQ) command = 'limit';
  const prevCategory = Object.prototype.hasOwnProperty.call(CATEGORIES, req.category) ? String(req.category) : '';

  // 画像は start のときだけ AI に渡す。以降は start で返した image_desc（文章）で代用する
  const references = sanitizeSamples_(req.references, command === 'start');
  const images = [];
  const notes = [];
  if (command === 'start' && boolProp_('ENABLE_IMAGES')) {
    const max = Math.max(0, numProp_('MAX_IMAGES'));
    if (draft.image_data && max > 0) images.push({ id: 'T', dataUrl: draft.image_data });
    else if (draft._rejected) notes.push('アップロード画像を読み取れなかったため、本文のみで会話します');
    const refImgs = references.filter(r => r.image).slice(0, Math.max(0, max - images.length));
    const fromBrowser = refImgs.filter(r => r.image_data).map(r => ({ id: r.id, dataUrl: r.image_data }));
    const rest = refImgs.filter(r => !r.image_data).map(r => ({ id: r.id, url: r.image }));
    const fetched = rest.length && boolProp_('SERVER_IMAGE_FETCH') ? fetchImages_(rest) : [];
    const order = ['T'].concat(references.map(r => r.id));
    fromBrowser.concat(fetched).forEach(x => images.push(x));
    images.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }
  delete draft.image_data; delete draft._rejected;
  references.forEach(r => { delete r.image; delete r.image_data; });
  const hasDraftImage = images.some(x => x.id === 'T');
  const imageDesc = sanitizeText_(req.image_desc, 300);

  const prompt = loadPrompt_();
  const vars = {
    COMMAND: COMMANDS[command],
    CATEGORY: prevCategory ? prevCategory + '（' + CATEGORIES[prevCategory].label + '）' : '（まだ決まっていない）',
    TARGET: JSON.stringify(draft),
    IMAGE_INFO: command === 'start'
      ? (hasDraftImage ? 'このメッセージの末尾に【T の画像】として添付しています' : '画像なし')
      : (imageDesc ? '画像の説明（初回に作成）: ' + imageDesc : '画像なし'),
    REFERENCES: references.length ? references.map(r => JSON.stringify(r)).join('\n') : '（なし）',
    HISTORY: history.length ? history.map(h => h.role + ': ' + h.text + (h.question ? '\n  （問い）' + h.question : '')).join('\n') : '（なし：会話の開始）',
    MESSAGE: message || '（なし）',
    ASKED: String(asked),
    MAX_QUESTIONS: String(maxQ),
    CURRENT_PROPOSAL: proposal ? JSON.stringify(proposal) : '（なし）',
    MAX_PROPOSAL: String(numProp_('MAX_PROPOSAL'))
  };
  const system = fillTemplate_(prompt.system, vars);
  const userText = fillTemplate_(prompt.user, vars);

  if (!adjustDailyQuota_(+1)) throw new AppError('LIMIT', '本日の AI 利用回数の上限に達しました');
  let data, imagesUsed = images.length;
  try {
    if (images.length) {
      try {
        data = callAzureOpenAI_(apiKey, [{ role: 'system', content: system }, { role: 'user', content: buildUserContent_(userText, images) }]);
      } catch (err) {
        if (err instanceof AppError && err.code === 'AI' && /image|vision|content.*type|HTTP 400/i.test(err.message)) {
          console.warn('画像付きリクエストが拒否されたためテキストのみで再送します: ' + err.message);
          notes.push('AI が画像を受け付けなかったため、本文のみで会話します');
          imagesUsed = 0;
          data = callAzureOpenAI_(apiKey, [{ role: 'system', content: system }, { role: 'user', content: userText + noImageNote_() }]);
        } else {
          throw err;
        }
      }
    } else {
      data = callAzureOpenAI_(apiKey, [{ role: 'system', content: system }, { role: 'user', content: userText + (command === 'start' ? noImageNote_() : '') }]);
    }
  } catch (err) {
    adjustDailyQuota_(-1);
    throw err;
  }

  const result = normalizeResult_(data, {
    command: command, prevCategory: prevCategory, imageDesc: imageDesc,
    hasImage: command === 'start' ? imagesUsed > 0 && hasDraftImage : !!imageDesc,
    canAsk: command === 'start' || command === 'answer'
  });
  const payload = {
    ok: true,
    model: AZURE_MODEL.name,
    prompt_version: prompt.version,
    command: command === 'limit' ? 'answer' : command,
    turn: asked + (result.question ? 1 : 0),
    images_used: imagesUsed,
    images_note: notes.join(' / '),
    result: result,
    elapsed_ms: Date.now() - t0
  };
  writeLog_(req, command, draft, message, result, payload);
  return json_(payload);
}
function noImageNote_() {
  return '\n\n※今回は T の画像が添付されていません。photo の match・comment は空文字、image_desc は空文字で返してください。';
}

/* ---------- 入力整形 ---------- */
const num_ = v => (isFinite(Number(v)) ? Number(v) : 0);
const str_ = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
function sanitizeText_(raw, max) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/^[ \t]*#+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}
function sanitizeDraft_(p) {
  if (!p || typeof p !== 'object') return null;
  const text = sanitizeText_(p.text, numProp_('MAX_TEXT'));
  if (!text) return null;
  const o = { text: text };
  if (p.name) o.name = str_(p.name, 40);
  if (p.image_data) {
    const data = sanitizeImageData_(p.image_data);
    if (data) o.image_data = data; else o._rejected = true;
  }
  return o;
}
function sanitizeHistory_(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(h => h && typeof h === 'object' && (h.role === 'bot' || h.role === 'user'))
    .slice(-numProp_('MAX_HISTORY'))
    .map(h => {
      const o = { role: h.role, text: sanitizeText_(h.text, 400).replace(/\n+/g, ' ') };
      if (h.role === 'bot' && h.question) o.question = str_(h.question, 100);
      return o;
    })
    .filter(h => h.text || h.question);
}
function sanitizeSamples_(raw, withImages) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(p => p && typeof p === 'object')
    .slice(0, numProp_('MAX_REFS'))
    .map((p, i) => {
      const o = { id: 'R' + (i + 1), text: str_(p.text, numProp_('MAX_TEXT')) };
      if (p.name) o.name = str_(p.name, 40);
      if (p.gender) o.gender = str_(p.gender, 10);
      if (p.age) o.age = str_(p.age, 10);
      if (withImages) {
        const img = sanitizeImageUrl_(p.image);
        if (img) {
          o.image = img;
          const data = sanitizeImageData_(p.image_data);
          if (data) o.image_data = data;
        }
      }
      return o;
    })
    .filter(o => o.text);
}

/* ---------- 画像 ---------- */
function sanitizeImageUrl_(v) {
  const u = String(v == null ? '' : v).trim();
  if (!u || u.length > 500 || !/^https:\/\/[^\s"'<>\\]+$/.test(u)) return '';
  if (/\.\.|%2e%2e/i.test(u)) return '';
  const prefixes = String(prop_('IMAGE_URL_PREFIX') || '').split(',').map(x => x.trim()).filter(Boolean);
  return prefixes.some(p => u.indexOf(p) === 0) ? u : '';
}
function sniffType_(b) {
  const u = i => (b[i] === undefined ? -1 : b[i] & 0xff);
  if (u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF) return 'image/jpeg';
  if (u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return 'image/png';
  if (u(0) === 0x47 && u(1) === 0x49 && u(2) === 0x46) return 'image/gif';
  if (u(0) === 0x52 && u(1) === 0x49 && u(2) === 0x46 && u(3) === 0x46 && u(8) === 0x57 && u(9) === 0x45) return 'image/webp';
  return '';
}
/** ブラウザから届いた data URL を検証。形式・サイズ・先頭バイトが正しいものだけ返す */
function sanitizeImageData_(v) {
  const s = String(v == null ? '' : v);
  const maxBytes = numProp_('MAX_IMAGE_BYTES');
  if (!s || s.length > Math.ceil(maxBytes * 4 / 3) + 40) return '';
  const m = s.match(DATA_URL_RE);
  if (!m) return '';
  let bytes;
  try { bytes = Utilities.base64Decode(m[2]); } catch (e) { return ''; }
  if (!bytes.length || bytes.length > maxBytes) return '';
  const type = sniffType_(bytes);
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return '';
  return type === m[1] ? s : 'data:' + type + ';base64,' + m[2];
}
/** image_data が無いサンプル画像を GAS から取得（Referer 付き）。失敗分は除外 */
function fetchImages_(reqs) {
  if (!reqs.length) return [];
  const maxBytes = numProp_('MAX_IMAGE_BYTES');
  const referer = String(prop_('IMAGE_REFERER') || '');
  let responses;
  try {
    responses = UrlFetchApp.fetchAll(reqs.map(r => ({ url: r.url, muteHttpExceptions: true, followRedirects: true,
      headers: Object.assign({ Accept: 'image/*' }, referer ? { Referer: referer } : {}) })));
  } catch (e) {
    console.warn('image fetchAll failed', e);
    return [];
  }
  const out = [];
  responses.forEach((res, i) => {
    try {
      if (res.getResponseCode() !== 200) return;
      const blob = res.getBlob();
      const bytes = blob.getBytes();
      if (!bytes.length || bytes.length > maxBytes) return;
      const header = String(blob.getContentType() || '').split(';')[0].trim();
      const type = sniffType_(bytes) || (IMAGE_TYPES.test(header) ? header : '');
      if (!IMAGE_TYPES.test(type)) return;
      out.push({ id: reqs[i].id, dataUrl: 'data:' + type + ';base64,' + Utilities.base64Encode(bytes) });
    } catch (e) {
      console.warn('image convert failed: ' + reqs[i].url, e);
    }
  });
  return out;
}
function buildUserContent_(userText, images) {
  const detail = ['low', 'high', 'auto'].indexOf(String(prop_('IMAGE_DETAIL'))) >= 0 ? String(prop_('IMAGE_DETAIL')) : 'low';
  const parts = [{ type: 'text', text: userText }];
  images.forEach(img => {
    parts.push({ type: 'text', text: '【' + img.id + ' の画像】' });
    parts.push({ type: 'image_url', image_url: { url: img.dataUrl, detail: detail } });
  });
  return parts;
}

/* ---------- 出力整形 ---------- */
function normalizeResult_(data, ctx) {
  const d = data && typeof data === 'object' ? data : {};
  const text = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n || 2000) : '');
  const list = (v, max) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()).slice(0, max) : []);
  const obj = v => (v && typeof v === 'object' ? v : {});
  const ph = obj(d.photo), pr = obj(d.proposal);
  // 分類は会話の途中で変えない（start で決めたものを維持）
  const code = ctx.prevCategory || (Object.prototype.hasOwnProperty.call(CATEGORIES, d.category) ? d.category : 'D');
  let question = ctx.canAsk ? text(d.question, 120) : '';
  let proposal = { text: text(pr.text, 1000), points: list(pr.points, 3) };
  if (ctx.command === 'start') proposal = { text: '', points: [] };   // 初回は投稿案を出さない
  if (proposal.text) question = '';                                       // 投稿案と問いは同時に出さない
  if (!proposal.text) proposal.points = [];
  return {
    category: { code: code, label: CATEGORIES[code].label },
    level: LEVELS.indexOf(d.level) >= 0 ? d.level : '',
    image_desc: ctx.command === 'start' ? (ctx.hasImage ? text(d.image_desc, 300) : '') : ctx.imageDesc,
    photo: ctx.command === 'start' && ctx.hasImage
      ? { match: MATCHES.indexOf(ph.match) >= 0 ? ph.match : '', comment: text(ph.comment, 200) }
      : { match: '', comment: '' },
    reply: text(d.reply, 300),
    question: question,
    aim: question && AIMS.indexOf(d.aim) >= 0 ? d.aim : '',
    proposal: proposal,
    done: !!proposal.text
  };
}

/* ============================ プロンプト ============================ */
function loadPrompt_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(KEY.PROMPT);
  if (hit) return JSON.parse(hit);
  const url = normalizePromptUrl_(prop_('PROMPT_URL'));
  let res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    console.error('prompt fetch failed: ' + url, e);
    throw new AppError('CONFIG', 'プロンプトファイルに接続できません。管理者は PROMPT_URL を確認してください');
  }
  if (res.getResponseCode() !== 200) {
    throw new AppError('CONFIG', 'プロンプトファイルを取得できません（HTTP ' + res.getResponseCode() + '）。管理者は PROMPT_URL を確認してください');
  }
  const prompt = parsePrompt_(res.getContentText('UTF-8'));
  cache.put(KEY.PROMPT, JSON.stringify(prompt), Math.min(numProp_('PROMPT_CACHE_SEC'), CACHE_MAX_SEC));
  return prompt;
}
function normalizePromptUrl_(url) {
  const u = String(url || '').trim();
  if (!u) throw new AppError('CONFIG', 'スクリプトプロパティ PROMPT_URL が未設定です');
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? [RAW_GITHUB_BASE, m[1], m[2], m[3]].join('/') : u;
}
function parsePrompt_(rawText) {
  if (/^\s*<(!doctype|html)/i.test(rawText)) {
    throw new AppError('CONFIG', 'プロンプトが HTML で返りました。PROMPT_URL に raw URL を指定してください');
  }
  const text = rawText.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '');
  const m = text.match(/^#{2,3}[ \t]*SYSTEM[ \t]*\n([\s\S]*?)^#{2,3}[ \t]*USER[ \t]*\n([\s\S]*)$/im);
  if (!m) throw new AppError('CONFIG', 'プロンプトファイルに「### SYSTEM」「### USER」の見出しがありません');
  return { system: m[1].trim(), user: m[2].trim(), version: sha256_(text).slice(0, 10) };
}
function fillTemplate_(tpl, vars) {
  return tpl.replace(/\{\{\s*([\w\\]+?)\s*\}\}/g, (all, k) => {
    const name = k.replace(/\\/g, '');
    return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all;
  });
}
function clearPromptCache() {
  CacheService.getScriptCache().remove(KEY.PROMPT);
  console.log('プロンプトのキャッシュを削除しました');
}

/* ============================== Azure OpenAI ============================== */
const OUTPUT_SCHEMA = (() => {
  const strArr = { type: 'array', items: { type: 'string' } };
  return {
    type: 'object',
    additionalProperties: false,
    // 出力順＝考える順（分類 → 画像 → ひとこと → 問い or 投稿案）
    required: ['category', 'level', 'image_desc', 'photo', 'reply', 'question', 'aim', 'proposal', 'done'],
    properties: {
      category: { type: 'string', enum: Object.keys(CATEGORIES) },
      level: { type: 'string', enum: LEVELS },
      image_desc: { type: 'string' },
      photo: {
        type: 'object', additionalProperties: false,
        required: ['match', 'comment'],
        properties: { match: { type: 'string', enum: MATCHES.concat(['']) }, comment: { type: 'string' } }
      },
      reply: { type: 'string' },
      question: { type: 'string' },
      aim: { type: 'string', enum: AIMS.concat(['']) },
      proposal: {
        type: 'object', additionalProperties: false,
        required: ['text', 'points'],
        properties: { text: { type: 'string' }, points: strArr }
      },
      done: { type: 'boolean' }
    }
  };
})();
function callAzureOpenAI_(apiKey, messages) {
  const body = {
    messages: messages,
    max_completion_tokens: numProp_('MAX_OUTPUT_TOKENS'),
    response_format: { type: 'json_schema', json_schema: { name: 'drop_bot', strict: true, schema: OUTPUT_SCHEMA } }
  };
  const effort = prop_('REASONING_EFFORT');
  if (effort) body.reasoning_effort = effort;
  let r = postAzure_(apiKey, body);
  if (r.code === 400 && body.reasoning_effort && /reasoning/i.test(r.text)) {
    console.warn('reasoning_effort=' + body.reasoning_effort + ' が拒否されたため外して再送します: ' + r.text);
    delete body.reasoning_effort;
    r = postAzure_(apiKey, body);
  }
  let json;
  try {
    json = JSON.parse(r.text);
  } catch (e) {
    console.error('Azure OpenAI non-JSON', r.code, String(r.text).slice(0, 500));
    throw new AppError('AI', 'Azure OpenAI の応答を解釈できません (HTTP ' + r.code + ')');
  }
  if (r.code !== 200) {
    console.error('Azure OpenAI error', r.code, String(r.text).slice(0, 1000));
    const m = String((json.error && json.error.message) || '').slice(0, 200);
    if (r.code === 401) throw new AppError('AI', 'API キーが無効です（' + AZURE_MODEL.secret + ' を確認してください）');
    if (r.code === 404) throw new AppError('AI', 'デプロイ「' + AZURE_MODEL.deployment + '」または api-version が見つかりません');
    if (r.code === 429) throw new AppError('BUSY', 'AI の利用が混み合っています。少し待ってから再送してください');
    throw new AppError('AI', 'Azure OpenAI エラー (HTTP ' + r.code + '): ' + m);
  }
  const choice = json.choices && json.choices[0];
  const msg = choice && choice.message;
  if (!msg) throw new AppError('AI', 'AI の応答が空です');
  if (msg.refusal) throw new AppError('AI', 'AI が回答を拒否しました: ' + String(msg.refusal).slice(0, 200));
  if (choice.finish_reason === 'content_filter') throw new AppError('AI', 'Azure のコンテンツフィルターにより応答が停止されました');
  if (choice.finish_reason === 'length') throw new AppError('AI', '出力が上限で途切れました。MAX_OUTPUT_TOKENS を増やしてください');
  if (json.usage) console.log('usage', JSON.stringify(json.usage));
  try {
    return JSON.parse(msg.content);
  } catch (e) {
    throw new AppError('AI', 'AI の出力が JSON ではありません');
  }
}
function postAzure_(apiKey, body) {
  let res;
  try {
    res = UrlFetchApp.fetch(azureUrl_(), {
      method: 'post', contentType: 'application/json',
      headers: { 'api-key': apiKey }, payload: JSON.stringify(body), muteHttpExceptions: true
    });
  } catch (e) {
    console.error('Azure OpenAI fetch failed', e);
    throw new AppError('AI', 'Azure OpenAI に接続できません。endpoint の設定を確認してください');
  }
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/* ============================== ログ ============================== */
/** LOG_SHEET_ID が設定されていれば 1 ターン 1 行で記録（画像は記録しない）。失敗しても応答は返す */
function writeLog_(req, command, draft, message, result, payload) {
  const id = String(prop_('LOG_SHEET_ID') || '').trim();
  if (!id) return;
  try {
    const ss = SpreadsheetApp.openById(id);
    const sh = ss.getSheetByName('log') || ss.insertSheet('log');
    if (sh.getLastRow() === 0) sh.appendRow(LOG_HEADERS);
    const safe = v => { const s = String(v == null ? '' : v); return /^[=+\-@]/.test(s) ? "'" + s : s; };   // 数式インジェクション対策
    sh.appendRow([
      new Date(), str_(req.name, 40), str_(req.session, 60), payload.turn, command === 'limit' ? 'answer' : command,
      result.category.code + ' ' + result.category.label, result.level, draft.text, message,
      result.reply, result.question, result.proposal.text, Math.round(payload.elapsed_ms / 100) / 10, payload.images_used
    ].map(safe));
  } catch (e) {
    console.warn('log write failed', e);
  }
}

/* ============================== 共通 ============================== */
function adjustDailyQuota_(delta) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (e) { throw new AppError('BUSY', 'アクセスが集中しています。少し待ってから再送してください'); }
  try {
    const props = PropertiesService.getScriptProperties();
    const key = KEY.QUOTA + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    const n = Number(props.getProperty(key) || 0);
    if (delta > 0 && n >= numProp_('DAILY_LIMIT')) return false;
    props.setProperty(key, String(Math.max(0, n + delta)));
    if (delta > 0 && n === 0) {
      props.getKeys().filter(k => k.indexOf(KEY.QUOTA) === 0 && k !== key).forEach(k => props.deleteProperty(k));
    }
    return true;
  } finally {
    lock.releaseLock();
  }
}
function sha256_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, message) { return json_({ ok: false, code: code, message: message }); }

/* ============================ 動作確認用 ============================ */
function checkSetup() {
  ['APP_PASSWORD', AZURE_MODEL.secret, 'PROMPT_URL'].forEach(k => console.log(k + ': ' + (prop_(k) ? '設定済み' : '★未設定')));
  console.log('LOG_SHEET_ID: ' + (prop_('LOG_SHEET_ID') ? '設定済み' : '未設定（ログを取らない）'));
  console.log('MODEL: ' + AZURE_MODEL.name + ' / URL: ' + azureUrl_());
  console.log('問いの上限: ' + numProp_('MAX_QUESTIONS') + ' / 1 日の上限: ' + numProp_('DAILY_LIMIT') + ' 回 / 画像: ' + (boolProp_('ENABLE_IMAGES') ? 'ON' : 'OFF'));
  clearPromptCache();
  const p = loadPrompt_();
  console.log('プロンプト version=' + p.version + ' system=' + p.system.length + '字 user=' + p.user.length + '字');
}
/** start → answer → summarize の流れを確認（エディタから実行） */
function testChat() {
  const login = JSON.parse(handleLogin_({ password: prop_('APP_PASSWORD') }).getContent());
  const draft = { text: 'こんな近くに、カブトムシの飼育が趣味のひとがいたんだ！' };
  const refs = [{ text: '今では珍しい二重螺旋階段と噴水です！', name: 'OMM', gender: '男性', age: '30代' }];
  const call = body => JSON.parse(handleChat_(Object.assign({ token: login.token, session: 'test', name: 'test', draft: draft, references: refs }, body)).getContent());
  const r1 = call({ command: 'start' });
  console.log('start', JSON.stringify(r1.result || r1));
  if (!r1.ok) return;
  const history = [{ role: 'bot', text: r1.result.reply, question: r1.result.question }];
  const r2 = call({ command: 'answer', category: r1.result.category.code, history: history, message: '隣のブースの出展者さん。同じ品川の会社の総務の方でした' });
  console.log('answer', JSON.stringify(r2.result || r2));
  if (!r2.ok) return;
  history.push({ role: 'user', text: '隣のブースの出展者さん。同じ品川の会社の総務の方でした' }, { role: 'bot', text: r2.result.reply, question: r2.result.question });
  const r3 = call({ command: 'summarize', category: r1.result.category.code, history: history });
  console.log('summarize', JSON.stringify(r3.result || r3));
}

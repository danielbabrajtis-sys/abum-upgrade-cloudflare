/* ABUM UPGRADE — Cloudflare Pages Functions adapter.
   This file ports NxCreate's logic handlers to Cloudflare Pages + D1.
   API routes: /api/<handlerName>. Static app is served from public/index.html.
*/
const logic = Object.create(null);
const process = { env: {} };
const ABUM_KEY_FIELDS = {
  appusers: 'userId',
  appsettings: 'settingKey',
  apppromocodes: 'code',
  appwithdrawals: 'requestId'
};

function abumDbSame(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => abumDbSame(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && abumDbSame(a[k], b[k]));
  }
  return a === b;
}
function abumDbMatches(doc, filter) {
  for (const [field, expected] of Object.entries(filter || {})) {
    const actual = doc ? doc[field] : undefined;
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
        const forbidden = expected.$ne;
        if (Array.isArray(actual) ? actual.some((value) => abumDbSame(value, forbidden)) : abumDbSame(actual, forbidden)) return false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
        if (!Array.isArray(expected.$in) || !expected.$in.some((value) => abumDbSame(value, actual))) return false;
        continue;
      }
    }
    if (!abumDbSame(actual, expected)) return false;
  }
  return true;
}
function abumDbKeyFor(collection, doc) {
  const keyField = ABUM_KEY_FIELDS[collection];
  if (keyField && doc && doc[keyField] !== undefined && doc[keyField] !== null) return String(doc[keyField]);
  return crypto.randomUUID();
}
function abumDbKeyFromFilter(collection, filter) {
  const keyField = ABUM_KEY_FIELDS[collection];
  if (keyField && filter && filter[keyField] !== undefined && !(filter[keyField] && typeof filter[keyField] === 'object')) return String(filter[keyField]);
  return null;
}
function abumDbApplyUpdate(current, update) {
  const next = structuredClone(current);
  const hasOps = Object.keys(update || {}).some((key) => key.startsWith('$'));
  if (!hasOps) {
    for (const [key, value] of Object.entries(update || {})) next[key] = value;
    return next;
  }
  for (const [key, value] of Object.entries(update.$set || {})) next[key] = value;
  for (const [key, amount] of Object.entries(update.$inc || {})) next[key] = Number(next[key] || 0) + Number(amount || 0);
  for (const [key, value] of Object.entries(update.$push || {})) {
    if (!Array.isArray(next[key])) next[key] = [];
    if (value && typeof value === 'object' && Array.isArray(value.$each)) next[key].push(...value.$each);
    else next[key].push(value);
  }
  for (const [key, value] of Object.entries(update.$pull || {})) {
    if (Array.isArray(next[key])) next[key] = next[key].filter((item) => !abumDbSame(item, value));
  }
  return next;
}
function abumD1Adapter(d1) {
  if (!d1) throw new Error('Cloudflare D1 database binding is missing. Add a D1 binding named DB in Pages Settings.');
  async function rows(collection) {
    const result = await d1.prepare('SELECT doc_key, doc_json FROM abum_documents WHERE collection = ?').bind(String(collection)).all();
    return (result.results || []).map((row) => ({ key: row.doc_key, raw: row.doc_json, doc: JSON.parse(row.doc_json) }));
  }
  async function findOne(collection, filter = {}) {
    const key = abumDbKeyFromFilter(collection, filter);
    if (key !== null) {
      const row = await d1.prepare('SELECT doc_key, doc_json FROM abum_documents WHERE collection = ? AND doc_key = ?').bind(String(collection), key).first();
      if (!row) return null;
      const doc = JSON.parse(row.doc_json);
      return abumDbMatches(doc, filter) ? doc : null;
    }
    const items = await rows(collection);
    const found = items.find((row) => abumDbMatches(row.doc, filter));
    return found ? found.doc : null;
  }
  async function findAll(collection, filter = {}) {
    const items = await rows(collection);
    return items.filter((row) => abumDbMatches(row.doc, filter)).map((row) => row.doc);
  }
  async function insertOne(collection, document) {
    const key = abumDbKeyFor(collection, document);
    try {
      await d1.prepare('INSERT INTO abum_documents (collection, doc_key, doc_json, updated_at) VALUES (?, ?, ?, ?)')
        .bind(String(collection), key, JSON.stringify(document), Date.now()).run();
      return { acknowledged: true, insertedId: key };
    } catch (error) {
      const message = String(error && error.message || error);
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(message)) throw abumError('Такая запись уже существует. Обнови данные и повтори запрос.', 409);
      throw error;
    }
  }
  async function updateOne(collection, filter = {}, update = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = abumDbKeyFromFilter(collection, filter);
      let row;
      if (key !== null) {
        row = await d1.prepare('SELECT doc_key, doc_json FROM abum_documents WHERE collection = ? AND doc_key = ?').bind(String(collection), key).first();
        if (row) {
          const parsed = JSON.parse(row.doc_json);
          if (!abumDbMatches(parsed, filter)) row = null;
        }
      } else {
        const all = await rows(collection);
        row = all.find((item) => abumDbMatches(item.doc, filter)) || null;
        if (row) row = { doc_key: row.key, doc_json: row.raw };
      }
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      const current = JSON.parse(row.doc_json);
      const next = abumDbApplyUpdate(current, update);
      const result = await d1.prepare('UPDATE abum_documents SET doc_json = ?, updated_at = ? WHERE collection = ? AND doc_key = ? AND doc_json = ?')
        .bind(JSON.stringify(next), Date.now(), String(collection), String(row.doc_key), String(row.doc_json)).run();
      const changes = Number(result && result.meta && result.meta.changes || 0);
      if (changes > 0) return { matchedCount: 1, modifiedCount: 1 };
      // For profiles, do not blindly retry stale balance/inventory writes: that could overwrite a newer operation.
      if (collection === 'appusers') throw abumError('Профиль изменился параллельно. Повтори действие.', 409);
      // Non-profile writes can retry against the latest row. Conditional filters protect statuses and promo activation limits.
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }
  const operation = { findOne, findAll, insertOne, updateOne };
  return { operation, findOne, findAll, insertOne, updateOne };
}

async function abumReadBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return {};
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const payload = {};
    for (const [key, value] of form.entries()) payload[key] = typeof value === 'string' ? value : '';
    return payload;
  }
  const raw = await request.text();
  if (!raw.trim()) return {};
  if (contentType.includes('application/json') || contentType.includes('text/plain')) {
    try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch (_) {}
  }
  const payload = {};
  for (const part of raw.split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    const decode = (s) => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (_) { return String(s); } };
    const key = decode(at < 0 ? part : part.slice(0, at));
    if (key) payload[key] = decode(at < 0 ? '' : part.slice(at + 1));
  }
  return payload;
}
function abumResponseHeaders(request, currentHeaders) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  // API and HTML are served from the same Cloudflare Pages origin. This only reflects the exact same origin.
  if (origin && origin === url.origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '600');
  // Preserve non-CORS custom headers from an action response; discard the old NxCreate origin header.
  if (currentHeaders && typeof currentHeaders === 'object') {
    for (const [key, value] of Object.entries(currentHeaders)) {
      if (!/^access-control-allow-origin$/i.test(key) && !/^content-type$/i.test(key)) headers.set(key, String(value));
    }
  }
  return headers;
}

/* ABUM UPGRADE SERVER v6 — security-hardening pass.
   Based on the previously working v5 server; preserve the existing collection names.
   This is defense-in-depth, not a substitute for securing the NxCreate/Telegram accounts.

   ABUM UPGRADE SERVER — NxCreate-compatible profile storage
   Required Env Variable on this server bot:
   MAIN_APP_BOT_TOKEN=<token of the MAIN Telegram bot that opens the Mini App>
   Keep the token private and never place it in HTML.
*/

const ABUM_APP_ORIGIN = '*';
const ABUM_CORS_HEADERS = {
  // CORS is only a browser boundary, not authentication. Every state-changing
  // endpoint still validates Telegram initData on the server.
  'Access-Control-Allow-Origin': ABUM_APP_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  'Vary': 'Origin'
};

// Per-process rate limiter. It is an extra guard against rapid repeated calls;
// it resets on server restart and does not replace platform-level protection.
const ABUM_RATE_LIMIT_BUCKETS = new Map();
let ABUM_RATE_CLEANUP_TICK = 0;
function abumEnforceRateLimit(userId, action, maxRequests, windowMs) {
  const id = String(userId || '');
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    throw abumError('Не удалось подтвердить Telegram-пользователя.', 401);
  }
  const now = Date.now();
  ABUM_RATE_CLEANUP_TICK += 1;
  if (ABUM_RATE_LIMIT_BUCKETS.size > 2000 && ABUM_RATE_CLEANUP_TICK % 50 === 0) {
    for (const [key, item] of ABUM_RATE_LIMIT_BUCKETS.entries()) {
      if (!item || now - Number(item.startedAt || 0) > 10 * 60 * 1000) ABUM_RATE_LIMIT_BUCKETS.delete(key);
    }
  }
  const key = id + ':' + String(action);
  const current = ABUM_RATE_LIMIT_BUCKETS.get(key);
  const duration = Number(windowMs) > 0 ? Number(windowMs) : 60000;
  const max = Math.max(1, Number(maxRequests) || 1);
  if (!current || now - current.startedAt >= duration) {
    ABUM_RATE_LIMIT_BUCKETS.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= max) {
    throw abumError('Слишком много запросов. Подожди немного и попробуй снова.', 429);
  }
  current.count += 1;
}

// NxCreate database adapter: use documented DB helpers instead of raw collection handles.
// The platform documents db.findOne/findAll/insertOne/updateOne and db.operation.updateOne.
function abumCollection(db, name) {
  if (!db) throw new Error('NxCreate database helper is unavailable.');
  const collectionName = String(name || '');
  const operation = db.operation || null;
  return {
    findOne(filter) {
      if (operation && typeof operation.findOne === 'function') return operation.findOne(collectionName, filter || {});
      if (typeof db.findOne === 'function') return db.findOne(collectionName, filter || {});
      throw new Error('NxCreate database findOne is unavailable.');
    },
    insertOne(document) {
      if (typeof db.insertOne === 'function') return db.insertOne(collectionName, document);
      if (operation && typeof operation.insertOne === 'function') return operation.insertOne(collectionName, document);
      throw new Error('NxCreate database insertOne is unavailable.');
    },
    updateOne(filter, update, options) {
      if (operation && typeof operation.updateOne === 'function') {
        return operation.updateOne(collectionName, filter || {}, update || {}, options);
      }
      if (typeof db.updateOne === 'function' && (!options || Object.keys(options).length === 0)) {
        return db.updateOne(collectionName, filter || {}, update || {});
      }
      throw new Error('NxCreate database updateOne is unavailable for this operation.');
    },
    find(filter) {
      if (typeof db.findAll === 'function') return db.findAll(collectionName, filter || {});
      if (operation && typeof operation.findAll === 'function') return operation.findAll(collectionName, filter || {});
      throw new Error('NxCreate database findAll is unavailable.');
    }
  };
}

// Best-effort audit trail: never store tokens, initData, passwords or full request bodies.
async function abumAudit(db, event, userId, metadata) {
  const clean = {};
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  for (const key of Object.keys(source).slice(0, 12)) {
    const value = source[key];
    if (typeof value === 'string') clean[key] = value.slice(0, 120);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
  }
  try {
    await abumCollection(db, 'appsecurityaudit').insertOne({
      event: String(event || 'event').slice(0, 80),
      userId: Number(userId || 0),
      metadata: clean,
      createdAt: Date.now()
    });
  } catch (_) {
    // Audit storage failure must not turn a completed player operation into a failed response.
    console.error('ABUM audit write failed for event:', String(event || 'event'));
  }
}


const ABUM_GIFT_CATALOG = [
  {id:'heart',name:'Сердце',icon:'❤️',price:15,rarity:'Common'},
  {id:'teddy',name:'Мишка',icon:'🧸',price:15,rarity:'Common',art:'teddy'},
  {id:'gift',name:'Подарок',icon:'🎁',price:25,rarity:'Common',art:'giftbox'},
  {id:'rose',name:'Роза',icon:'🌹',price:25,rarity:'Common',art:'rose'},
  {id:'cake',name:'Торт',icon:'🎂',price:50,rarity:'Classic',art:'cake'},
  {id:'bouquet',name:'Букет',icon:'💐',price:50,rarity:'Classic',art:'bouquet'},
  {id:'rocket',name:'Ракета',icon:'🚀',price:50,rarity:'Classic',art:'rocket'},
  {id:'champagne',name:'Бутылка шампанского',icon:'🍾',price:50,rarity:'Classic'},
  {id:'trophy',name:'Трофей',icon:'🏆',price:100,rarity:'Rare'},
  {id:'ring',name:'Кольцо',icon:'💍',price:100,rarity:'Rare',art:'ring'},
  {id:'diamond',name:'Бриллиант',icon:'💎',price:100,rarity:'Rare',art:'diamond'},
  {id:'torch',name:'Фонарик',icon:'🔦',price:450,rarity:'Collectible'},
  {id:'street_lamp',name:'Уличный фонарь',icon:'💡',price:500,rarity:'Collectible'},
  {id:'noodles',name:'Лапша',icon:'🍜',price:495,rarity:'Collectible'},
  {id:'icecream',name:'Мороженое',icon:'🍨',price:500,rarity:'Collectible'},
  {id:'popsicle',name:'Мороженое на палочке',icon:'🍦',price:525,rarity:'Collectible'},
  {id:'liberty',name:'Статуя Свободы',icon:'🗽',price:600,rarity:'Collectible',art:'liberty_statue'},
  {id:'puppy',name:'Щенок',icon:'🐶',price:614,rarity:'Collectible'},
  {id:'lollipop',name:'Леденец',icon:'🍭',price:450,rarity:'Collectible',art:'lollipop'},
  {id:'flamingo',name:'Фламинго',icon:'🦩',price:505,rarity:'Collectible',art:'flamingo'},
  {id:'backpack',name:'Рюкзак',icon:'🎒',price:555,rarity:'Collectible',art:'backpack'},
  {id:'poop',name:'Какашка',icon:'💩',price:480,rarity:'Collectible'},
  {id:'mar8_cupcake',name:'Кекс 8 марта',icon:'🧁',price:465,rarity:'Collectible'},
  {id:'collectible_rocket',name:'Ракета коллекционная',icon:'🚀',price:600,rarity:'Collectible',art:'rocket'},
  {id:'moon_charm',name:'Лунный брелок',icon:'🌙',price:614,rarity:'Collectible',art:'moon_charm'},
  {id:'hugging_cats',name:'Обнимающиеся коты',icon:'🐱',price:1754,rarity:'Rare',art:'cat_globe'},
  {id:'collectible_cake',name:'Торт коллекционный',icon:'🎂',price:613,rarity:'Collectible',art:'cake'},
  {id:'mar8_bouquet',name:'Букет 8 марта',icon:'💐',price:615,rarity:'Collectible',art:'bouquet'},
  {id:'ufc_box',name:'Коробка UFC',icon:'🥊',price:1490,rarity:'Rare'},
  {id:'halloween_eye',name:'Хэллоуинский глаз',icon:'👁️',price:781,rarity:'Collectible'},
  {id:'feather',name:'Перо',icon:'🪶',price:780,rarity:'Collectible'},
  {id:'notebook',name:'Блокнот',icon:'📓',price:588,rarity:'Collectible'},
  {id:'bow',name:'Бант',icon:'🎀',price:613,rarity:'Collectible'},
  {id:'star',name:'Звезда',icon:'⭐',price:900,rarity:'Rare'},
  {id:'spider_heart',name:'Сердце-паук',icon:'🕷️',price:1600,rarity:'Rare'},
  {id:'rose_box',name:'Розы в коробке',icon:'🌹',price:2460,rarity:'Rare',art:'rose'},
  {id:'special_teddy',name:'Особенный мишка',icon:'🧸',price:3500,rarity:'Epic',art:'teddy'},
  {id:'pumpkin',name:'Хэллоуинская тыква',icon:'🎃',price:1629,rarity:'Rare',art:'pumpkin'},
  {id:'cigar',name:'Сигара',icon:'🚬',price:3857,rarity:'Epic'},
  {id:'crystal',name:'Кристалл',icon:'🔮',price:5000,rarity:'Legendary',art:'crystal'},
  {id:'rare_gift',name:'Редкий подарок',icon:'🎁',price:7500,rarity:'Legendary',art:'giftbox'},
  {id:'nft_gift',name:'NFT-подарок',icon:'🌌',price:10000,rarity:'Legendary',art:'crystal'}
];

function abumAdminIds() {
  return String(process.env.ABUM_ADMIN_IDS || '')
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value));
}

function abumIsAdmin(userId) {
  return abumAdminIds().includes(String(userId));
}

function abumDefaultProfile(userId, user, now) {
  return {
    userId: Number(userId),
    username: String((user && user.username) || ''),
    firstName: String((user && user.firstName) || (user && user.first_name) || ''),
    lastName: String((user && user.lastName) || (user && user.last_name) || ''),
    languageCode: String((user && user.languageCode) || (user && user.language_code) || ''),
    starsBalance: 0,
    inventory: [],
    attempts: 0,
    wins: 0,
    history: [],
    createdAt: now,
    lastSeenAt: now
  };
}

function abumProfilePatch(profile, now) {
  return {
    username: String(profile.username || ''),
    firstName: String(profile.firstName || ''),
    lastName: String(profile.lastName || ''),
    languageCode: String(profile.languageCode || ''),
    starsBalance: Math.max(0, Number(profile.starsBalance || 0)),
    inventory: Array.isArray(profile.inventory) ? profile.inventory : [],
    attempts: Math.max(0, Number(profile.attempts || 0)),
    wins: Math.max(0, Number(profile.wins || 0)),
    history: Array.isArray(profile.history) ? profile.history.slice(-50) : [],
    createdAt: Number(profile.createdAt || now),
    lastSeenAt: now
  };
}

function abumAddHistory(profile, text, icon) {
  if (!Array.isArray(profile.history)) profile.history = [];
  profile.history.push({
    text: String(text),
    icon: String(icon || '🎁'),
    createdAt: Date.now()
  });
  profile.history = profile.history.slice(-50);
}

function abumMakeInventoryItem(giftId) {
  const gift = ABUM_GIFT_CATALOG.find((item) => item.id === String(giftId));
  if (!gift) throw abumError('Unknown gift ID.', 400);
  return {
    id: String(Date.now()) + '-' + Math.floor(Math.random() * 1e12).toString(36),
    giftId: gift.id,
    name: gift.name,
    icon: gift.icon,
    price: gift.price,
    rarity: gift.rarity,
    art: String(gift.art || ''),
    acquiredAt: Date.now()
  };
}

function abumRandomPercent() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return (bytes[0] / 0x100000000) * 100;
}

async function abumAuthenticateAndLoad(initData, db) {
  const token = String(process.env.MAIN_APP_BOT_TOKEN || '').trim();
  const telegramUser = await abumVerifyTelegramInitData(initData, token);
  // Global per-user ceiling applies before profile reads/writes; endpoint-specific limits below are stricter.
  abumEnforceRateLimit(telegramUser.id, 'all_authenticated_api', 60, 60000);
  const now = Date.now();
  const users = abumCollection(db, 'appusers');
  let profile = await users.findOne({ userId: telegramUser.id });

  if (!profile) {
    const newProfile = abumDefaultProfile(telegramUser.id, telegramUser, now);
    await users.insertOne(newProfile);
    profile = await users.findOne({ userId: telegramUser.id }) || newProfile;
  }

  profile.username = telegramUser.username;
  profile.firstName = telegramUser.firstName;
  profile.lastName = telegramUser.lastName;
  profile.languageCode = telegramUser.languageCode;
  const patch = abumProfilePatch(profile, now);
  await users.updateOne({ userId: telegramUser.id }, { $set: patch });
  profile = { ...profile, ...patch, userId: telegramUser.id };

  return { users, profile, telegramUser, isAdmin: abumIsAdmin(telegramUser.id) };
}

async function abumLoadOrCreateTargetProfile(users, targetUserId) {
  let profile = await users.findOne({ userId: targetUserId });
  if (!profile) {
    const newProfile = abumDefaultProfile(targetUserId, { firstName: 'Игрок' }, Date.now());
    await users.insertOne(newProfile);
    profile = await users.findOne({ userId: targetUserId }) || newProfile;
  }
  return profile;
}

async function abumSaveProfile(users, profile) {
  const now = Date.now();
  const patch = abumProfilePatch(profile, now);
  await users.updateOne({ userId: Number(profile.userId) }, { $set: patch });
  return { ...profile, ...patch, userId: Number(profile.userId) };
}

function abumPublicState(profile, telegramUser, isAdmin) {
  const inventory = Array.isArray(profile.inventory) ? profile.inventory : [];
  const history = Array.isArray(profile.history)
    ? profile.history.slice(-30).reverse().map((item) => ({
        text: String((item && item.text) || 'Операция'),
        icon: String((item && item.icon) || '🎁'),
        createdAt: Number((item && item.createdAt) || 0)
      }))
    : [];
  return {
    ok: true,
    user: {
      id: Number(telegramUser.id),
      firstName: String(telegramUser.firstName || ''),
      lastName: String(telegramUser.lastName || ''),
      username: String(telegramUser.username || ''),
      languageCode: String(telegramUser.languageCode || '')
    },
    isAdmin: Boolean(isAdmin),
    profile: {
      starsBalance: Number(profile.starsBalance || 0),
      inventory,
      attempts: Number(profile.attempts || 0),
      wins: Number(profile.wins || 0),
      createdAt: Number(profile.createdAt || Date.now())
    },
    history
  };
}

function abumPreflightOrEmptyBody(payload, response) {
  if (payload && Object.keys(payload).length > 0) return false;
  response.statusCode = 200;
  response.data = { preflight: true };
  return true;
}

function abumHandleFailure(error, response, stage) {
  const statusCode = Number(error && error.statusCode) || 500;
  const internalMessage = error && error.message ? String(error.message) : 'ABUM request failed.';
  console.error('ABUM request failed at ' + String(stage || 'unknown') + ' (HTTP ' + statusCode + '): ' + internalMessage.slice(0, 300));
  const publicMessage = statusCode >= 500
    ? (statusCode === 503 ? 'Сервис временно недоступен. Проверь настройки сервера.' : 'Внутренняя ошибка сервера. Попробуй позже.')
    : internalMessage.slice(0, 240);
  response.statusCode = statusCode;
  response.message = publicMessage;
  response.data = {
    code: statusCode === 503 ? 'CONFIG_REQUIRED' : (statusCode === 401 ? 'TELEGRAM_AUTH_FAILED' : (statusCode === 403 ? 'FORBIDDEN' : (statusCode === 429 ? 'RATE_LIMITED' : (statusCode === 409 ? 'CONFLICT' : 'ABUM_REQUEST_FAILED')))),
    stage: String(stage || 'unknown').slice(0, 80)
  };
}

function abumValidateStarsAmount(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000) {
    throw abumError((label || 'Amount') + ' must be an integer from 1 to 1000000.', 400);
  }
  return amount;
}

function abumSetCors(response) {
  response.headers = {
    ...(response.headers || {}),
    ...ABUM_CORS_HEADERS
  };
}


/* Publicly disclosed test mode: all spins display a loss, but stakes/items are NOT consumed. */
async function abumGetGameMode(db) {
  const settings = abumCollection(db, 'appsettings');
  const row = await settings.findOne({ settingKey: 'forceLossTestMode' });
  return {
    forceLossTestMode: Boolean(row && row.enabled === true),
    updatedAt: Number(row && row.updatedAt || 0),
    updatedBy: Number(row && row.updatedBy || 0)
  };
}

async function abumSetGameMode(db, enabled, adminId) {
  const settings = abumCollection(db, 'appsettings');
  const now = Date.now();
  const existing = await settings.findOne({ settingKey: 'forceLossTestMode' });
  if (existing) {
    await settings.updateOne(
      { settingKey: 'forceLossTestMode' },
      { $set: { enabled: Boolean(enabled), updatedAt: now, updatedBy: Number(adminId) } }
    );
  } else {
    await settings.insertOne({
      settingKey: 'forceLossTestMode', enabled: Boolean(enabled),
      updatedAt: now, updatedBy: Number(adminId)
    });
  }
  return { forceLossTestMode: Boolean(enabled), updatedAt: now, updatedBy: Number(adminId) };
}

function abumPublicPromo(promo) {
  const rewardType = String(promo && promo.rewardType || 'stars');
  const gift = rewardType === 'gift'
    ? ABUM_GIFT_CATALOG.find((item) => item.id === String(promo && promo.giftId || ''))
    : null;
  return {
    code: String(promo && promo.code || ''),
    rewardType,
    rewardAmount: Number(promo && promo.rewardAmount || 0),
    giftId: gift ? gift.id : '',
    giftName: gift ? gift.name : '',
    giftIcon: gift ? gift.icon : '',
    maxActivations: Number(promo && promo.maxActivations || 0),
    usedCount: Number(promo && promo.usedCount || 0),
    active: promo && promo.active !== false,
    createdAt: Number(promo && promo.createdAt || 0),
    createdBy: Number(promo && promo.createdBy || 0)
  };
}

function abumNormalizePromoCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
    throw abumError('Промокод должен содержать 3–32 символа: латинские буквы, цифры, дефис или подчёркивание.', 400);
  }
  return code;
}

function abumPromoRewardDescription(promo) {
  if (String(promo.rewardType) === 'stars') return Number(promo.rewardAmount || 0) + ' игровых ⭐';
  const gift = ABUM_GIFT_CATALOG.find((item) => item.id === String(promo.giftId || ''));
  return gift ? gift.name : 'подарок';
}

function abumParseBody(body) {
  // NxCreate custom webhooks may provide JSON as an object, a JSON string,
  // or a URL-encoded form string. Accept all three without relying on URLSearchParams.
  if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  if (typeof body !== 'string') return {};

  const raw = body.trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    // It may be application/x-www-form-urlencoded rather than JSON.
  }

  const form = {};
  const decodeFormPart = (value) => {
    try {
      return decodeURIComponent(String(value).replace(/\+/g, ' '));
    } catch (_) {
      return String(value);
    }
  };
  for (const part of raw.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeFormPart(eq < 0 ? part : part.slice(0, eq));
    const value = decodeFormPart(eq < 0 ? '' : part.slice(eq + 1));
    if (key) form[key] = value;
  }
  return form;
}

function abumError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode || 400;
  return error;
}

function abumParseInitData(initData) {
  const parsed = Object.create(null);
  if (typeof initData !== 'string' || initData.length < 1 || initData.length > 8192) {
    throw abumError('Telegram initData отсутствует или слишком длинный.', 400);
  }
  const decode = (value) => {
    try {
      return decodeURIComponent(String(value).replace(/\+/g, ' '));
    } catch (_) {
      throw abumError('Telegram initData contains invalid URL encoding.', 400);
    }
  };

  for (const part of String(initData).split('&')) {
    if (!part) continue;
    const separator = part.indexOf('=');
    const rawKey = separator < 0 ? part : part.slice(0, separator);
    const rawValue = separator < 0 ? '' : part.slice(separator + 1);
    const key = decode(rawKey);
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw abumError('Telegram initData содержит повторяющиеся параметры.', 400);
    }
    parsed[key] = decode(rawValue);
  }
  return parsed;
}

function abumSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function abumHmacSha256(keyBytes, messageText) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(messageText));
  return new Uint8Array(signature);
}

function abumBytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function abumVerifyTelegramInitData(initData, botToken) {
  if (typeof initData !== 'string' || !initData) {
    throw abumError('Telegram initData is missing. Open this app from the main Telegram bot.', 400);
  }
  if (!botToken) {
    throw abumError('MAIN_APP_BOT_TOKEN is missing in Cloudflare Pages Secrets.', 503);
  }

  const params = abumParseInitData(initData);
  const receivedHash = params.hash;
  const authDate = Number(params.auth_date);
  const now = Math.floor(Date.now() / 1000);

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw abumError('Telegram initData has no valid hash.', 401);
  }
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    throw abumError('Telegram initData has no valid auth_date.', 401);
  }
  if (now - authDate > 3600 || authDate - now > 300) {
    throw abumError('Telegram initData устарели. Закрой и заново открой Mini App через основного бота.', 401);
  }

  const dataCheckString = Object.keys(params)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('\n');

  // Telegram WebApp validation: secret = HMAC_SHA256("WebAppData", bot token),
  // calculatedHash = HMAC_SHA256(secret, data_check_string).
  // Derive the Telegram secret from the fixed key and bot token.
  const derivedKey = await (async () => {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(botToken)));
  })();
  const calculatedBytes = await abumHmacSha256(derivedKey, dataCheckString);
  const calculatedHash = abumBytesToHex(calculatedBytes);
  const hashesMatch = abumSafeEqualHex(receivedHash.toLowerCase(), calculatedHash.toLowerCase());
  if (!hashesMatch) {
    throw abumError('Telegram signature is invalid. Check MAIN_APP_BOT_TOKEN matches the main bot that opens this Mini App.', 401);
  }
  if (!params.user) throw abumError('Telegram user is missing from initData.', 401);
  let user;
  try { user = JSON.parse(params.user); }
  catch (_) { throw abumError('Telegram user data could not be parsed.', 401); }
  const userId = Number(user && user.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw abumError('Telegram user ID is invalid.', 401);
  return {
    id: userId,
    firstName: String(user.first_name || ''),
    lastName: String(user.last_name || ''),
    username: String(user.username || ''),
    languageCode: String(user.language_code || '')
  };
}

/* Withdrawal support. All payouts are manual fulfilment by the owner.
   Internal stars are reserved on request and refunded on cancel/rejection. */
function abumNewWithdrawalId() {
  try {
    if (crypto && typeof crypto.randomUUID === 'function') return 'WD-' + crypto.randomUUID();
  } catch (_) {}
  return 'WD-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
}

function abumPublicWithdrawal(row) {
  return {
    requestId: String(row && row.requestId || ''),
    userId: Number(row && row.userId || 0),
    username: String(row && row.username || ''),
    firstName: String(row && row.firstName || 'Игрок'),
    giftId: String(row && row.giftId || ''),
    giftName: String(row && row.giftName || 'NFT-подарок'),
    giftIcon: String(row && row.giftIcon || '🎁'),
    giftArt: String(row && row.giftArt || ''),
    starsCost: Number(row && row.starsCost || 0),
    status: String(row && row.status || 'pending'),
    createdAt: Number(row && row.createdAt || 0),
    updatedAt: Number(row && row.updatedAt || 0),
    processedAt: Number(row && row.processedAt || 0),
    processedBy: Number(row && row.processedBy || 0)
  };
}

async function abumFindRows(collection, filter, limit) {
  const maxRows = Math.max(1, Math.min(200, Number(limit) || 50));
  let cursor = collection.find(filter || {});
  if (Array.isArray(cursor)) {
    return cursor.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, maxRows);
  }
  if (cursor && typeof cursor.sort === 'function') {
    const sorted = cursor.sort({ createdAt: -1 });
    if (sorted) cursor = sorted;
  }
  if (cursor && typeof cursor.limit === 'function') {
    const limited = cursor.limit(maxRows);
    if (limited) cursor = limited;
  }
  if (cursor && typeof cursor.toArray === 'function') {
    return (await cursor.toArray()).slice(0, maxRows);
  }
  if (cursor && typeof cursor.then === 'function') {
    const result = await cursor;
    if (Array.isArray(result)) return result.slice().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, maxRows);
  }
  throw new Error('NxCreate storage did not return a readable collection cursor.');
}

function abumWithdrawalGift(giftId) {
  const gift = ABUM_GIFT_CATALOG.find((item) => item.id === String(giftId || ''));
  if (!gift || Number(gift.price) < 450) {
    throw abumError('Вывод доступен только для NFT из каталога стоимостью от 450 игровых ⭐.', 400);
  }
  return gift;
}

function abumWithdrawalStatusLabel(status) {
  if (status === 'pending') return 'pending';
  if (status === 'fulfilled') return 'fulfilled';
  if (status === 'rejected') return 'rejected';
  if (status === 'cancelled') return 'cancelled';
  return 'unknown';
}

/* Health check: keep this endpoint simple and stable. */
logic['upgrade_ping'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  response.statusCode = 200;
  response.data = { ok: true, message: 'ABUM UPGRADE SERVER ONLINE' };
};

/* Load/create a verified Telegram profile. */
logic['app_state'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || (query && query.initData) || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'app_state', 20, 60000);
    stage = 'profile_response';
    const publicState = abumPublicState(auth.profile, auth.telegramUser, auth.isAdmin);
    publicState.serverMode = await abumGetGameMode(db);
    response.statusCode = 200;
    response.data = publicState;
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Admin-controlled, publicly disclosed test mode. It shows losses but never consumes player assets. */
logic['app_admin_game_mode'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'admin_game_mode', 8, 60000);
    if (!abumAdminIds().length) throw abumError('Добавь ABUM_ADMIN_IDS в Env Variables серверного бота.', 503);
    if (!auth.isAdmin) throw abumError('Нет прав администратора.', 403);
    const enabled = payload.enabled === true || String(payload.enabled).toLowerCase() === 'true';
    stage = 'save_game_mode';
    const serverMode = await abumSetGameMode(db, enabled, auth.telegramUser.id);
    await abumAudit(db, 'admin_game_mode_changed', auth.telegramUser.id, { enabled });
    response.statusCode = 200;
    response.data = { ok: true, serverMode };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Server-side upgrade. The client sends IDs and stake only; prices and outcome are decided here. */
logic['app_upgrade'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'app_upgrade', 8, 60000);
    const profile = auth.profile;
    const users = auth.users;
    const gameMode = await abumGetGameMode(db);
    const forceLossTestMode = gameMode.forceLossTestMode === true;
    const mode = String(payload.mode || 'gift');
    let won = false;
    let chance = 0;
    let source = null;
    let reward = null;
    let payoutStars = 0;
    let sourceLossText = '';

    if (!Array.isArray(profile.inventory)) profile.inventory = [];
    if (!Array.isArray(profile.history)) profile.history = [];

    if (mode === 'gift') {
      stage = 'validate_gift_upgrade';
      const sourceItemId = String(payload.sourceItemId || '');
      const inventoryIndex = profile.inventory.findIndex((item) => String(item && item.id) === sourceItemId);
      if (inventoryIndex < 0) throw abumError('Исходного подарка нет в твоём инвентаре.', 400);
      source = profile.inventory[inventoryIndex];
      const target = ABUM_GIFT_CATALOG.find((item) => item.id === String(payload.targetGiftId || ''));
      if (!target) throw abumError('Целевой подарок не найден в каталоге.', 400);
      const sourcePrice = Number(source.price || 0);
      if (!Number.isFinite(sourcePrice) || sourcePrice < 1) throw abumError('У исходного подарка некорректная стоимость.', 400);
      if (target.price <= sourcePrice) throw abumError('Целевой подарок должен быть дороже исходного.', 400);
      chance = Math.max(0.01, Math.min(95, Number(((sourcePrice / target.price) * 100).toFixed(2))));
      profile.attempts = Number(profile.attempts || 0) + 1;
      if (forceLossTestMode) {
        // Transparent test mode: show a loss but never remove the source item or create a reward.
        won = false;
        sourceLossText = source.name;
        abumAddHistory(profile, 'Тестовый режим: показан демонстрационный проигрыш; подарок «' + source.name + '» сохранён, списаний нет.', '🧪');
      } else {
        won = abumRandomPercent() < chance;
        profile.inventory.splice(inventoryIndex, 1);
        if (won) {
          reward = abumMakeInventoryItem(target.id);
          profile.inventory.push(reward);
          profile.wins = Number(profile.wins || 0) + 1;
          abumAddHistory(profile, 'Успех: ' + source.name + ' → ' + target.name + ' (' + chance + '%)', '🎉');
        } else {
          sourceLossText = source.name;
          abumAddHistory(profile, 'Неудача: потерян подарок ' + source.name + ' (цель: ' + target.name + ', шанс ' + chance + '%)', '💔');
        }
      }
    } else if (mode === 'stars') {
      stage = 'validate_star_bet';
      const stake = abumValidateStarsAmount(payload.stake, 'Ставка');
      chance = Number(payload.chance);
      if (!Number.isFinite(chance) || chance < 0.1 || chance > 95) {
        throw abumError('Шанс для режима ставок должен быть от 0,1% до 95%. Нулевой шанс недоступен.', 400);
      }
      chance = Number(chance.toFixed(1));
      const rewardType = String(payload.rewardType || 'stars');
      let grossPayout = 0;
      let targetGift = null;
      let minStake = 1;
      if (rewardType === 'gift') {
        targetGift = ABUM_GIFT_CATALOG.find((item) => item.id === String(payload.targetGiftId || ''));
        if (!targetGift) throw abumError('Целевой подарок не найден в каталоге.', 400);
        const maxAllowedStake = Math.floor(Number(targetGift.price) * 0.95);
        if (stake > maxAllowedStake || stake >= Number(targetGift.price)) {
          throw abumError('Для шанса не выше 95% ставка на «' + targetGift.name + '» не может превышать ' + maxAllowedStake + ' игровых ⭐.', 400);
        }
        // The real probability is derived from server-side catalogue price and stake.
        // Do not trust the chance sent by the browser.
        chance = Number(((stake / Number(targetGift.price)) * 100).toFixed(2));
        if (chance < 0.01 || chance > 95) throw abumError('Для выбранной ставки фактический шанс должен быть больше 0% и не выше 95%.', 400);
        minStake = 1;
      } else if (rewardType === 'stars') {
        minStake = Math.ceil(chance / (100 - chance));
        grossPayout = Math.floor(stake * 100 / chance);
        if (stake < minStake || grossPayout <= stake) {
          throw abumError('Для шанса ' + chance + '% нужна ставка минимум ' + minStake + ' игровых ⭐, чтобы выигрыш был больше ставки.', 400);
        }
      } else {
        throw abumError('Выбери цель: игровые ⭐ или подарок.', 400);
      }
      if (Number(profile.starsBalance || 0) < stake) {
        throw abumError('Недостаточно игровых ⭐ для этой ставки.', 400);
      }
      source = { name: 'Ставка', icon: '⭐', price: stake };
      if (rewardType === 'gift') source.targetGiftName = targetGift.name;
      profile.attempts = Number(profile.attempts || 0) + 1;
      if (forceLossTestMode) {
        // Transparent test mode: no balance is deducted and no reward is granted.
        won = false;
        payoutStars = 0;
        reward = null;
        abumAddHistory(profile, 'Тестовый режим: ставка ' + stake + ' игровых ⭐ не списана; показан демонстрационный проигрыш.', '🧪');
      } else {
        profile.starsBalance = Number(profile.starsBalance || 0) - stake;
        won = abumRandomPercent() < chance;
        if (won) {
          profile.wins = Number(profile.wins || 0) + 1;
          if (rewardType === 'gift') {
            reward = abumMakeInventoryItem(targetGift.id);
            profile.inventory.push(reward);
            payoutStars = 0;
            abumAddHistory(profile, 'Ставка ' + stake + ' игровых ⭐: выигран подарок ' + targetGift.name + ' (шанс ' + chance + '%)', '🎉');
          } else {
            payoutStars = grossPayout;
            profile.starsBalance += grossPayout;
            reward = { name: 'Игровые ⭐', icon: '⭐', price: grossPayout, payout: grossPayout };
            abumAddHistory(profile, 'Ставка ' + stake + ' игровых ⭐: выплата ' + grossPayout + ' ⭐ при шансе ' + chance + '%', '✨');
          }
        } else {
          payoutStars = 0;
          reward = null;
          abumAddHistory(profile, 'Ставка ' + stake + ' игровых ⭐ проиграна (шанс ' + chance + '%)', '💔');
        }
      }
    } else {
      throw abumError('Неизвестный режим апгрейда.', 400);
    }

    stage = 'save_upgrade';
    const saved = await abumSaveProfile(users, profile);
    await abumAudit(db, 'upgrade_settled', auth.telegramUser.id, { mode, won, chance, stake: Number(source && source.price || 0), targetGiftId: String(payload.targetGiftId || '') });
    stage = 'upgrade_response';
    response.statusCode = 200;
    response.data = {
      ok: true,
      mode,
      won,
      chance,
      source,
      reward,
      payoutStars,
      sourceLossText,
      testMode: forceLossTestMode,
      serverMode: gameMode,
      ...abumPublicState(saved, auth.telegramUser, auth.isAdmin)
    };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Sell one owned virtual gift for its fixed in-game value. This does not pay real Telegram Stars. */
logic['app_sell'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'app_sell', 10, 60000);
    const profile = auth.profile;
    const users = auth.users;
    stage = 'validate_inventory_item';
    const itemId = String(payload.inventoryItemId || '');
    const index = (Array.isArray(profile.inventory) ? profile.inventory : []).findIndex((item) => String(item && item.id) === itemId);
    if (index < 0) throw abumError('Этот подарок уже отсутствует в инвентаре.', 400);
    const [sold] = profile.inventory.splice(index, 1);
    const saleValue = Math.max(0, Number(sold.price || 0));
    profile.starsBalance = Number(profile.starsBalance || 0) + saleValue;
    abumAddHistory(profile, 'Продан ' + String(sold.name || 'подарок') + ': +' + saleValue + ' игровых ⭐', '💰');
    stage = 'save_sale';
    const saved = await abumSaveProfile(users, profile);
    await abumAudit(db, 'gift_sold', auth.telegramUser.id, { itemId: String(sold.id || ''), price: saleValue });
    response.statusCode = 200;
    response.data = {
      ok: true,
      sold: { id: String(sold.id), name: String(sold.name || 'Подарок'), price: saleValue },
      ...abumPublicState(saved, auth.telegramUser, auth.isAdmin)
    };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Admin credit console endpoint. Configure ABUM_ADMIN_IDS as comma-separated Telegram IDs. */
logic['app_admin_credit'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'admin_credit', 12, 60000);
    if (!abumAdminIds().length) throw abumError('Добавь ABUM_ADMIN_IDS в Env Variables серверного бота. Значение — числовой Telegram ID администратора.', 503);
    if (!auth.isAdmin) throw abumError('Нет прав администратора.', 403);
    const targetUserId = Number(payload.targetUserId);
    if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) throw abumError('Укажи корректный Telegram ID получателя.', 400);
    const users = auth.users;
    stage = 'load_target_profile';
    let targetProfile = await abumLoadOrCreateTargetProfile(users, targetUserId);
    if (!Array.isArray(targetProfile.inventory)) targetProfile.inventory = [];
    if (!Array.isArray(targetProfile.history)) targetProfile.history = [];
    const action = String(payload.action || 'gift');
    let credited;

    if (action === 'stars') {
      const amount = abumValidateStarsAmount(payload.amount, 'Количество игровых ⭐');
      targetProfile.starsBalance = Number(targetProfile.starsBalance || 0) + amount;
      abumAddHistory(targetProfile, 'Администратор начислил ' + amount + ' игровых ⭐', '✨');
      credited = { type: 'stars', amount };
    } else if (action === 'gift') {
      const giftId = String(payload.giftId || '');
      const quantity = Number(payload.quantity || 1);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw abumError('Количество подарков должно быть от 1 до 100.', 400);
      const gift = ABUM_GIFT_CATALOG.find((item) => item.id === giftId);
      if (!gift) throw abumError('Подарок не найден в каталоге.', 400);
      for (let i = 0; i < quantity; i++) targetProfile.inventory.push(abumMakeInventoryItem(giftId));
      abumAddHistory(targetProfile, 'Администратор начислил подарок: ' + gift.name + ' × ' + quantity, gift.icon);
      credited = { type: 'gift', giftId: gift.id, name: gift.name, quantity };
    } else {
      throw abumError('Выбери начисление игровых ⭐ или подарка.', 400);
    }

    stage = 'save_target_profile';
    await abumSaveProfile(users, targetProfile);
    await abumAudit(db, 'admin_credit', auth.telegramUser.id, { targetUserId, action, giftId: String(payload.giftId || ''), amount: Number(payload.amount || 0), quantity: Number(payload.quantity || 1) });
    response.statusCode = 200;
    response.data = {
      ok: true,
      targetUserId,
      credited,
      target: {
        starsBalance: Number(targetProfile.starsBalance || 0),
        inventoryCount: Array.isArray(targetProfile.inventory) ? targetProfile.inventory.length : 0
      }
    };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};


/* Admin creates an activation-limited promo code for internal stars or one virtual gift. */
logic['app_admin_promo_create'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'promo_create', 8, 60000);
    if (!abumAdminIds().length) throw abumError('Добавь ABUM_ADMIN_IDS в Env Variables серверного бота.', 503);
    if (!auth.isAdmin) throw abumError('Нет прав администратора.', 403);
    stage = 'validate_promo';
    const code = abumNormalizePromoCode(payload.code);
    const rewardType = String(payload.rewardType || 'stars');
    const maxActivations = Number(payload.maxActivations);
    if (!Number.isSafeInteger(maxActivations) || maxActivations < 1 || maxActivations > 100000) {
      throw abumError('Лимит активаций должен быть целым числом от 1 до 100000.', 400);
    }
    const promos = abumCollection(db, 'apppromocodes');
    if (await promos.findOne({ code })) throw abumError('Промокод «' + code + '» уже существует.', 409);
    const now = Date.now();
    const record = {
      code,
      rewardType,
      rewardAmount: 0,
      giftId: '',
      maxActivations,
      usedCount: 0,
      activatedUserIds: [],
      active: true,
      createdAt: now,
      createdBy: Number(auth.telegramUser.id)
    };
    if (rewardType === 'stars') {
      record.rewardAmount = abumValidateStarsAmount(payload.amount, 'Награда в игровых ⭐');
    } else if (rewardType === 'gift') {
      const gift = ABUM_GIFT_CATALOG.find((item) => item.id === String(payload.giftId || ''));
      if (!gift) throw abumError('Выбери подарок для промокода.', 400);
      record.giftId = gift.id;
    } else {
      throw abumError('Тип награды должен быть stars или gift.', 400);
    }
    stage = 'save_promo';
    await promos.insertOne(record);
    await abumAudit(db, 'admin_promo_created', auth.telegramUser.id, { code, rewardType, maxActivations, rewardAmount: Number(record.rewardAmount || 0), giftId: String(record.giftId || '') });
    response.statusCode = 200;
    response.data = { ok: true, promo: abumPublicPromo(record) };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Admin lists promo codes without exposing the list of users who redeemed each code. */
logic['app_admin_promos'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'promo_list', 20, 60000);
    if (!abumAdminIds().length) throw abumError('Добавь ABUM_ADMIN_IDS в Env Variables серверного бота.', 503);
    if (!auth.isAdmin) throw abumError('Нет прав администратора.', 403);
    stage = 'load_promos';
    const rows = await abumFindRows(abumCollection(db, 'apppromocodes'), {}, 100);
    response.statusCode = 200;
    response.data = { ok: true, promos: rows.map(abumPublicPromo) };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Redeem once per Telegram account; activation limits and rewards are checked on the server. */
logic['app_promo_redeem'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  let claimedPromo = null;
  let claimedCount = 0;
  let claimedUserId = 0;
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'promo_redeem', 5, 60000);
    const profile = auth.profile;
    const users = auth.users;
    stage = 'validate_promo_code';
    const code = abumNormalizePromoCode(payload.code);
    const promos = abumCollection(db, 'apppromocodes');
    const promo = await promos.findOne({ code });
    if (!promo || promo.active === false) throw abumError('Промокод не найден или отключён.', 404);
    const userId = Number(auth.telegramUser.id);
    const activationIds = Array.isArray(promo.activatedUserIds) ? promo.activatedUserIds : [];
    if (activationIds.some((value) => Number(value) === userId)) throw abumError('Ты уже активировал этот промокод.', 409);
    const usedCount = Number(promo.usedCount || 0);
    const maxActivations = Number(promo.maxActivations || 0);
    if (maxActivations < 1 || usedCount >= maxActivations) throw abumError('Лимит активаций этого промокода исчерпан.', 409);

    stage = 'claim_promo_activation';
    const claim = await promos.updateOne(
      { code, active: true, usedCount, activatedUserIds: { $ne: userId } },
      { $inc: { usedCount: 1 }, $push: { activatedUserIds: userId } }
    );
    if (claim && ((typeof claim.matchedCount === 'number' && claim.matchedCount === 0) || (typeof claim.modifiedCount === 'number' && claim.modifiedCount === 0))) {
      throw abumError('Промокод только что активировали или его лимит исчерпан. Попробуй ещё раз.', 409);
    }
    const afterClaim = await promos.findOne({ code });
    const afterIds = Array.isArray(afterClaim && afterClaim.activatedUserIds) ? afterClaim.activatedUserIds : [];
    if (!afterClaim || !afterIds.some((value) => Number(value) === userId) || Number(afterClaim.usedCount || 0) < usedCount + 1) {
      throw abumError('Не удалось зарезервировать активацию промокода. Попробуй ещё раз.', 409);
    }
    claimedPromo = promo;
    claimedCount = Number(afterClaim.usedCount || usedCount + 1);
    claimedUserId = userId;

    stage = 'apply_promo_reward';
    let reward;
    if (String(promo.rewardType) === 'stars') {
      const amount = abumValidateStarsAmount(promo.rewardAmount, 'Награда в игровых ⭐');
      profile.starsBalance = Number(profile.starsBalance || 0) + amount;
      reward = { type: 'stars', amount, description: amount + ' игровых ⭐' };
      abumAddHistory(profile, 'Промокод ' + code + ': начислено ' + amount + ' игровых ⭐', '🎟️');
    } else if (String(promo.rewardType) === 'gift') {
      const gift = ABUM_GIFT_CATALOG.find((item) => item.id === String(promo.giftId || ''));
      if (!gift) throw abumError('Награда промокода содержит неизвестный подарок.', 500);
      const item = abumMakeInventoryItem(gift.id);
      profile.inventory = Array.isArray(profile.inventory) ? profile.inventory : [];
      profile.inventory.push(item);
      reward = { type: 'gift', giftId: gift.id, name: gift.name, icon: gift.icon, description: gift.name, item };
      abumAddHistory(profile, 'Промокод ' + code + ': получен подарок ' + gift.name, '🎁');
    } else {
      throw abumError('У промокода неизвестный тип награды.', 500);
    }

    stage = 'save_promo_reward';
    let saved;
    saved = await abumSaveProfile(users, profile);
    await abumAudit(db, 'promo_redeemed', auth.telegramUser.id, { code, rewardType: String(promo.rewardType || ''), rewardAmount: Number(promo.rewardAmount || 0), giftId: String(promo.giftId || '') });
    response.statusCode = 200;
    response.data = {
      ok: true,
      code,
      reward,
      promo: abumPublicPromo({ ...promo, usedCount: claimedCount }),
      serverMode: await abumGetGameMode(db),
      ...abumPublicState(saved, auth.telegramUser, auth.isAdmin)
    };
  } catch (error) {
    // If reward validation failed after an activation was claimed, release the claim.
    if (claimedPromo && claimedUserId) {
      try {
        const promos = abumCollection(db, 'apppromocodes');
        await promos.updateOne(
          { code: claimedPromo.code, activatedUserIds: claimedUserId },
          { $inc: { usedCount: -1 }, $pull: { activatedUserIds: claimedUserId } }
        );
      } catch (_) {}
    }
    abumHandleFailure(error, response, stage);
  }
};

/* List the current user's withdrawal requests. */
logic['app_my_withdrawals'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'my_withdrawals', 20, 60000);
    stage = 'load_user_withdrawals';
    const rows = await abumFindRows(abumCollection(db, 'appwithdrawals'), { userId: Number(auth.telegramUser.id) }, 50);
    response.statusCode = 200;
    response.data = { ok: true, requests: rows.map(abumPublicWithdrawal) };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Create a manual NFT withdrawal request. The internal-star cost is reserved up front. */
logic['app_withdraw_request'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'withdraw_request', 4, 60000);
    const profile = auth.profile;
    const users = auth.users;
    stage = 'validate_withdrawal';
    const gift = abumWithdrawalGift(payload.giftId);
    const cost = Number(gift.price);
    const balance = Number(profile.starsBalance || 0);
    if (balance < cost) {
      throw abumError('Не хватает ' + (cost - balance) + ' игровых ⭐. Для вывода «' + gift.name + '» нужно ' + cost + ' ⭐.', 400);
    }
    const now = Date.now();
    const request = {
      requestId: abumNewWithdrawalId(),
      userId: Number(auth.telegramUser.id),
      username: String(auth.telegramUser.username || ''),
      firstName: String(auth.telegramUser.firstName || 'Игрок'),
      giftId: gift.id,
      giftName: gift.name,
      giftIcon: gift.icon,
      giftArt: String(gift.art || ''),
      starsCost: cost,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      processedAt: 0,
      processedBy: 0
    };
    profile.starsBalance = balance - cost;
    abumAddHistory(profile, 'Заявка на ручной вывод ' + gift.name + ': зарезервировано ' + cost + ' игровых ⭐ (' + request.requestId + ')', '📤');
    stage = 'reserve_withdrawal_balance';
    await abumSaveProfile(users, profile);
    try {
      stage = 'create_withdrawal_record';
      await abumCollection(db, 'appwithdrawals').insertOne(request);
      await abumAudit(db, 'withdrawal_requested', auth.telegramUser.id, { requestId: request.requestId, giftId: gift.id, starsCost: cost });
    } catch (insertError) {
      profile.starsBalance = Number(profile.starsBalance || 0) + cost;
      abumAddHistory(profile, 'Возврат ' + cost + ' игровых ⭐: не удалось создать заявку на вывод.', '↩️');
      await abumSaveProfile(users, profile);
      throw insertError;
    }
    stage = 'withdrawal_response';
    const rows = await abumFindRows(abumCollection(db, 'appwithdrawals'), { userId: Number(auth.telegramUser.id) }, 50);
    const saved = await users.findOne({ userId: Number(auth.telegramUser.id) }) || profile;
    response.statusCode = 200;
    response.data = {
      ok: true,
      request: abumPublicWithdrawal(request),
      requests: rows.map(abumPublicWithdrawal),
      ...abumPublicState(saved, auth.telegramUser, auth.isAdmin)
    };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Cancel only a still-pending request and refund the reserved internal stars. */
logic['app_withdraw_cancel'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'withdraw_cancel', 4, 60000);
    const requestId = String(payload.requestId || '');
    if (!requestId) throw abumError('Не указан номер заявки.', 400);
    const requests = abumCollection(db, 'appwithdrawals');
    stage = 'load_withdrawal';
    const request = await requests.findOne({ requestId });
    if (!request || Number(request.userId) !== Number(auth.telegramUser.id)) {
      throw abumError('Заявка не найдена.', 404);
    }
    if (request.status !== 'pending') throw abumError('Эту заявку уже обработали — отменить её нельзя.', 409);
    stage = 'cancel_withdrawal';
    const update = await requests.updateOne(
      { requestId, status: 'pending' },
      { $set: { status: 'cancelled', updatedAt: Date.now(), processedAt: Date.now() } }
    );
    if (update && ((typeof update.modifiedCount === 'number' && update.modifiedCount === 0) || (typeof update.matchedCount === 'number' && update.matchedCount === 0))) {
      throw abumError('Заявку уже обрабатывают. Обнови список.', 409);
    }
    const profile = auth.profile;
    profile.starsBalance = Number(profile.starsBalance || 0) + Number(request.starsCost || 0);
    abumAddHistory(profile, 'Заявка на вывод отменена: возвращено ' + Number(request.starsCost || 0) + ' игровых ⭐ (' + requestId + ')', '↩️');
    try {
      stage = 'refund_withdrawal';
      await abumSaveProfile(auth.users, profile);
      await abumAudit(db, 'withdrawal_cancelled', auth.telegramUser.id, { requestId, refunded: Number(request.starsCost || 0) });
    } catch (saveError) {
      try { await requests.updateOne({ requestId, status: 'cancelled' }, { $set: { status: 'pending', updatedAt: Date.now(), processedAt: 0 } }); } catch (_) {}
      throw saveError;
    }
    const rows = await abumFindRows(requests, { userId: Number(auth.telegramUser.id) }, 50);
    const saved = await auth.users.findOne({ userId: Number(auth.telegramUser.id) }) || profile;
    response.statusCode = 200;
    response.data = { ok: true, requests: rows.map(abumPublicWithdrawal), ...abumPublicState(saved, auth.telegramUser, auth.isAdmin) };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Admin-only withdrawal queue. */
logic['app_admin_withdrawals'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'admin_withdrawals', 20, 60000);
    if (!abumAdminIds().length) throw abumError('Добавь ABUM_ADMIN_IDS в Env Variables серверного бота. Значение — числовой Telegram ID владельца.', 503);
    if (!auth.isAdmin) throw abumError('Нет прав администратора.', 403);
    stage = 'load_admin_withdrawals';
    const rows = await abumFindRows(abumCollection(db, 'appwithdrawals'), {}, 100);
    response.statusCode = 200;
    response.data = { ok: true, requests: rows.map(abumPublicWithdrawal) };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};

/* Admin fulfils a request manually or rejects it and refunds the reserved stars. */
logic['app_admin_withdraw_action'] = async (query, body, db, response, params) => {
  abumSetCors(response);
  const payload = abumParseBody(body);
  if (abumPreflightOrEmptyBody(payload, response)) return;
  let stage = 'telegram_auth';
  try {
    const auth = await abumAuthenticateAndLoad(payload.initData || '', db);
    await abumEnforceRateLimit(auth.telegramUser.id, 'admin_withdraw_action', 8, 60000);
    if (!abumAdminIds().length) throw abumError('Добавь ABUM_ADMIN_IDS в Env Variables серверного бота.', 503);
    if (!auth.isAdmin) throw abumError('Нет прав администратора.', 403);
    const requestId = String(payload.requestId || '');
    const action = String(payload.action || '');
    if (!requestId) throw abumError('Не указан номер заявки.', 400);
    if (!['fulfilled', 'rejected'].includes(action)) throw abumError('Неизвестное действие с заявкой.', 400);
    const requests = abumCollection(db, 'appwithdrawals');
    stage = 'load_withdrawal';
    const request = await requests.findOne({ requestId });
    if (!request) throw abumError('Заявка не найдена.', 404);
    if (request.status !== 'pending') throw abumError('Заявка уже обработана.', 409);
    stage = 'update_withdrawal_status';
    const now = Date.now();
    const update = await requests.updateOne(
      { requestId, status: 'pending' },
      { $set: { status: action, updatedAt: now, processedAt: now, processedBy: Number(auth.telegramUser.id) } }
    );
    if (update && ((typeof update.modifiedCount === 'number' && update.modifiedCount === 0) || (typeof update.matchedCount === 'number' && update.matchedCount === 0))) {
      throw abumError('Заявку уже обрабатывают. Обнови список.', 409);
    }
    const users = abumCollection(db, 'appusers');
    stage = 'update_withdrawal_user_history';
    const targetProfile = await abumLoadOrCreateTargetProfile(users, Number(request.userId));
    if (!Array.isArray(targetProfile.history)) targetProfile.history = [];
    if (action === 'rejected') {
      targetProfile.starsBalance = Number(targetProfile.starsBalance || 0) + Number(request.starsCost || 0);
      abumAddHistory(targetProfile, 'Заявка на вывод ' + String(request.giftName || 'NFT') + ' отклонена; возвращено ' + Number(request.starsCost || 0) + ' игровых ⭐', '↩️');
    } else {
      abumAddHistory(targetProfile, 'Администратор подтвердил ручную выдачу ' + String(request.giftName || 'NFT') + ' (' + request.requestId + '). Выдача NFT выполняется вручную вне приложения.', '🎁');
    }
    try {
      await abumSaveProfile(users, targetProfile);
      await abumAudit(db, 'admin_withdrawal_processed', auth.telegramUser.id, { requestId, action, targetUserId: Number(request.userId), starsCost: Number(request.starsCost || 0) });
    } catch (saveError) {
      try { await requests.updateOne({ requestId, status: action }, { $set: { status: 'pending', updatedAt: Date.now(), processedAt: 0, processedBy: 0 } }); } catch (_) {}
      throw saveError;
    }
    stage = 'admin_withdrawal_response';
    const rows = await abumFindRows(requests, {}, 100);
    response.statusCode = 200;
    response.data = { ok: true, request: abumPublicWithdrawal({ ...request, status: action, updatedAt: now, processedAt: now, processedBy: Number(auth.telegramUser.id) }), requests: rows.map(abumPublicWithdrawal) };
  } catch (error) {
    abumHandleFailure(error, response, stage);
  }
};



export async function onRequest(context) {
  const { request, env } = context;
  // The original handler logic reads process.env; in Cloudflare Pages these are bindings/secrets on env.
  process.env = env || {};
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (request.method === 'OPTIONS') {
    const headers = abumResponseHeaders(request, {});
    return new Response(null, { status: 204, headers });
  }
  if (!pathname.startsWith('/api/')) {
    return Response.json({ ok: false, message: 'Not an API route.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const apiPath = pathname.slice('/api/'.length).split('/').filter(Boolean).join('/');
  if (apiPath === 'db_health') {
    const headers = abumResponseHeaders(request, {});
    if (!env.DB) {
      return Response.json({ ok: false, statusCode: 503, message: 'D1 binding DB is missing. Add the abum-upgrade-db binding named DB in Pages Settings.' }, { status: 503, headers });
    }
    try {
      const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind('abum_documents').first();
      if (!table) {
        return Response.json({ ok: false, statusCode: 503, message: 'D1 is connected, but abum_documents is missing. Run schema.sql in the D1 Console.' }, { status: 503, headers });
      }
      await env.DB.prepare('SELECT doc_key FROM abum_documents LIMIT 1').first();
      return Response.json({ ok: true, statusCode: 200, data: { ok: true, message: 'D1 connected; abum_documents table is ready.' } }, { status: 200, headers });
    } catch (error) {
      console.error('ABUM D1 health check failed:', String(error && error.message || error).slice(0, 200));
      return Response.json({ ok: false, statusCode: 503, message: 'D1 query failed. Confirm the DB binding and schema.sql.' }, { status: 503, headers });
    }
  }
  const handler = logic[apiPath];
  if (typeof handler !== 'function') {
    return Response.json({ ok: false, statusCode: 404, message: 'Unknown API path: ' + apiPath }, { status: 404, headers: abumResponseHeaders(request, {}) });
  }
  let body = {};
  try {
    body = await abumReadBody(request);
  } catch (error) {
    return Response.json({ ok: false, statusCode: 400, message: 'Не удалось прочитать тело запроса.' }, { status: 400, headers: abumResponseHeaders(request, {}) });
  }
  const query = Object.fromEntries(url.searchParams.entries());
  const response = { statusCode: 200, headers: {}, data: undefined, message: undefined };
  try {
    // Health check does not require D1, so it remains available while DB is being configured.
    const db = apiPath === 'upgrade_ping' ? {} : abumD1Adapter(env.DB);
    await handler(query, body, db, response, context.params || {});
  } catch (error) {
    console.error('ABUM Cloudflare route error:', apiPath, String(error && error.message || error).slice(0, 300));
    response.statusCode = Number(error && error.statusCode) || 500;
    response.message = response.statusCode >= 500 ? 'Внутренняя ошибка сервера. Попробуй позже.' : String(error && error.message || error).slice(0, 240);
    response.data = { code: 'ABUM_REQUEST_FAILED' };
  }
  const status = Number(response.statusCode) || 200;
  const envelope = {
    ok: status < 400,
    statusCode: status,
    headers: {},
    ...(response.message ? { message: response.message } : {}),
    ...(response.data !== undefined ? { data: response.data } : {})
  };
  return new Response(JSON.stringify(envelope), { status, headers: abumResponseHeaders(request, response.headers) });
}

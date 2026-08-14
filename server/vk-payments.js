/**
 * Приём платежей за Голоса ВКонтакте для «Будки Сокровищ».
 * Cloudflare Worker + KV. Как разворачивать и что прописать в кабинете VK —
 * в server/README.md рядом.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. Игра — статика на GitHub Pages, сервера у неё нет.
 * Но покупки за Голоса без сервера невозможны в принципе, и не из-за правил,
 * а технически: когда игра вызывает VKWebAppShowOrderBox, ВКонтакте идёт
 * на «адрес обратного вызова» из настроек приложения с уведомлением get_item,
 * чтобы узнать название и цену товара. Некому ответить — окно покупки просто
 * не откроется. Плюс правила VK требуют подтверждать покупку на сервере, а не
 * начислять товар по ответу клиента: клиент подделывается, Голоса реальные.
 *
 * ТРИ РУЧКИ:
 *   GET  /items     — каталог для витрины в игре (чтобы цена в UI не разъезжалась
 *                     с ценой, которую сервер отдаёт ВКонтакте на get_item).
 *   POST /callback  — уведомления ВКонтакте (get_item, order_status_change).
 *   POST /claim     — игра спрашивает «что мне начислить», получает монеты
 *                     за оплаченные и ещё не начисленные заказы.
 *
 * ПОЧЕМУ НАЧИСЛЕНИЕ РАЗДЕЛЕНО НА ДВА ШАГА. Заказ оплачивается «в обход» игры:
 * деньги списывает ВКонтакте и сообщает об этом СЕРВЕРУ, а не клиенту. Клиент
 * узнаёт только order_id и то лишь если дожил до конца диалога. Поэтому оплата
 * (callback) и начисление (claim) — разные события, а связывает их KV. Игра
 * дёргает /claim не только после покупки, но и на каждом запуске: если игрок
 * закрыл приложение сразу после оплаты, монеты дождутся его в следующий раз.
 */

/* ===== КАТАЛОГ =====
   Единственный источник цен. Товары в кабинете VK создавать НЕ надо: при работе
   через Callback API название товара — произвольная строка, которую игра передаёт
   в VKWebAppShowOrderBox, а сервер расшифровывает здесь.
   price — в Голосах, coins — сколько игровых монет начислить.
   Крупные пакеты выгоднее в пересчёте на Голос: это нормальная практика и
   единственный честный способ поощрить большую покупку.
   Ставка по умолчанию 40, поэтому 25 000 монет — это ~620 спинов, а не «на два
   нажатия»: покупка обязана давать заметно больше, чем ролик (1 000) и
   ежедневная награда (до 4 000), иначе за неё нет смысла платить.
   title видит игрок в окне оплаты ВКонтакте, максимум 48 символов. */
const ITEMS = {
  budka_coins_s:  { title: 'Мешочек монет — 25 000 🪙',  price: 10,  coins: 25000 },
  budka_coins_m:  { title: 'Кошель монет — 75 000 🪙',   price: 25,  coins: 75000 },
  budka_coins_l:  { title: 'Сундук монет — 175 000 🪙',  price: 50,  coins: 175000 },
  budka_coins_xl: { title: 'Клад — 400 000 🪙',          price: 100, coins: 400000 }
};

/* Уведомление считаем своим, только если возраст запуска игры разумный.
   Защита от воспроизведения чужой ссылки запуска: параметры запуска подписаны,
   но подпись не истекает никогда. */
const LAUNCH_TTL = 24 * 60 * 60;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    try {
      if (path === '/items')    return cors(json({ items: publicCatalog() }));
      if (path === '/callback') return cors(await onCallback(req, env));
      if (path === '/claim')    return cors(await onClaim(req, env));
      if (path === '/')         return cors(json({ ok: true, service: 'budka-payments' }));
      return cors(json({ error: 'not_found' }, 404));
    } catch (e) {
      /* Свои 500 наружу не показываем, но и молчать нельзя: ВКонтакте по ошибке
         с critical:false повторит уведомление, и заказ не потеряется. */
      return cors(json({ error: { error_code: 1, error_msg: 'Внутренняя ошибка, повторите позже', critical: false } }, 200));
    }
  }
};

/* ===== ВИТРИНА ===== */
function publicCatalog() {
  return Object.entries(ITEMS).map(([id, it]) => ({ item: id, title: it.title, price: it.price, coins: it.coins }));
}

/* ===== УВЕДОМЛЕНИЯ ВКОНТАКТЕ ===== */
async function onCallback(req, env) {
  const p = await readParams(req);
  const secret = env.VK_PROTECTED_KEY || '';
  if (!secret) return json({ error: { error_code: 1, error_msg: 'Сервер не настроен', critical: false } });

  /* Подпись обязательна. Без неё кто угодно постучится с order_status_change
     и «оплатит» себе клад. */
  if (!(await checkSig(p, secret))) {
    return json({ error: { error_code: 10, error_msg: 'Подпись не совпала', critical: true } });
  }

  const type = String(p.notification_type || '');
  /* Тестовый режим кабинета присылает те же уведомления с суффиксом _test.
     Обрабатываем так же, но помечаем заказ — чтобы тестовые покупки было видно. */
  const test = type.endsWith('_test');
  const kind = test ? type.slice(0, -5) : type;

  if (kind === 'get_item') {
    const it = ITEMS[String(p.item || '')];
    if (!it) return json({ error: { error_code: 20, error_msg: 'Товар не найден', critical: true } });
    return json({ response: { item_id: String(p.item), title: it.title, price: it.price } });
  }

  if (kind === 'order_status_change') {
    const status = String(p.status || '');
    const orderId = String(p.order_id || '');
    const userId  = String(p.user_id || '');
    const itemKey = String(p.item || '');
    const it = ITEMS[itemKey];
    if (!orderId || !userId) return json({ error: { error_code: 1, error_msg: 'Нет order_id или user_id', critical: true } });

    if (status === 'chargeable') {
      if (!it) return json({ error: { error_code: 20, error_msg: 'Товар не найден', critical: true } });
      const key = 'order:' + orderId;
      const known = await env.ORDERS.get(key, 'json');
      /* Идемпотентность: ВКонтакте повторяет уведомление, если не дождался ответа.
         Второй раз тот же заказ не создаём и монеты не удваиваем — просто отвечаем
         тем же, чем в первый раз. */
      if (!known) {
        await env.ORDERS.put(key, JSON.stringify({
          order_id: orderId, user_id: userId, item: itemKey,
          coins: it.coins, price: Number(p.item_price || it.price),
          status: 'paid', claimed: false, test, ts: Date.now()
        }));
        await addPending(env, userId, orderId);
      }
      /* app_order_id — идентификатор заказа на нашей стороне. Своей нумерации мы
         не ведём: order_id от ВКонтакте уникален, его и возвращаем. */
      return json({ response: { order_id: Number(orderId), app_order_id: Number(orderId) } });
    }

    if (status === 'refunded') {
      const key = 'order:' + orderId;
      const rec = await env.ORDERS.get(key, 'json');
      if (rec && rec.status !== 'refunded') {
        rec.status = 'refunded';
        await env.ORDERS.put(key, JSON.stringify(rec));
        /* Монеты уже у игрока и лежат в его сохранении на клиенте — отобрать их
           сервер не может. Записываем долг: он вычтется из следующего начисления.
           Если начисления не будет, долг просто останется висеть, и это честнее,
           чем уходить в минус по балансу игрока. */
        if (rec.claimed) await addDebt(env, rec.user_id, rec.coins);
        else await removePending(env, rec.user_id, orderId);
      }
      return json({ response: { order_id: Number(orderId), app_order_id: Number(orderId) } });
    }

    return json({ error: { error_code: 1, error_msg: 'Неизвестный статус заказа', critical: true } });
  }

  /* Подписок в игре нет: get_subscription и subscription_status_change приходить
     не должны. Отвечаем ошибкой явно, чтобы это было видно в логах кабинета. */
  return json({ error: { error_code: 1, error_msg: 'Тип уведомления не поддерживается', critical: true } });
}

/* ===== НАЧИСЛЕНИЕ ИГРЕ =====
   Игра присылает свои параметры запуска (location.search целиком). Мы проверяем
   подпись — это и есть доказательство, что за монетами пришёл именно тот игрок,
   которому ВКонтакте продал заказ. Никаких user_id из тела запроса. */
async function onClaim(req, env) {
  const secret = env.VK_PROTECTED_KEY || '';
  const body = await readParams(req);
  const qs = String(body.launch || '');
  const userId = await verifyLaunch(qs, secret);
  if (!userId) return json({ error: 'bad_launch_params' }, 403);

  const pending = (await env.ORDERS.get(pendingKey(userId), 'json')) || [];
  let coins = 0; const done = [];
  for (const orderId of pending) {
    const key = 'order:' + orderId;
    const rec = await env.ORDERS.get(key, 'json');
    if (!rec || rec.user_id !== userId) { done.push(orderId); continue; }
    if (rec.claimed || rec.status !== 'paid') { done.push(orderId); continue; }
    /* Отмечаем начисленным ДО того, как ответили игре. Если ответ не дойдёт,
       игрок потеряет монеты одной покупки — неприятно, но это лечится вручную.
       Обратный порядок дал бы бесконечное начисление на повторных запросах. */
    rec.claimed = true; rec.claimed_at = Date.now();
    await env.ORDERS.put(key, JSON.stringify(rec));
    coins += rec.coins; done.push(orderId);
  }
  const left = pending.filter(id => !done.includes(id));
  await env.ORDERS.put(pendingKey(userId), JSON.stringify(left));

  /* Возвраты вычитаем из начисления, но не уводим его в минус. */
  let debt = Number((await env.ORDERS.get(debtKey(userId))) || 0);
  let applied = 0;
  if (debt > 0 && coins > 0) {
    applied = Math.min(debt, coins);
    coins -= applied; debt -= applied;
    await env.ORDERS.put(debtKey(userId), String(debt));
  }
  return json({ coins, refunded: applied, debt });
}

/* ===== ОЧЕРЕДЬ НЕНАЧИСЛЕННОГО ===== */
const pendingKey = u => 'pending:' + u;
const debtKey    = u => 'debt:' + u;
async function addPending(env, userId, orderId) {
  const list = (await env.ORDERS.get(pendingKey(userId), 'json')) || [];
  if (!list.includes(orderId)) list.push(orderId);
  await env.ORDERS.put(pendingKey(userId), JSON.stringify(list));
}
async function removePending(env, userId, orderId) {
  const list = (await env.ORDERS.get(pendingKey(userId), 'json')) || [];
  await env.ORDERS.put(pendingKey(userId), JSON.stringify(list.filter(id => id !== orderId)));
}
async function addDebt(env, userId, coins) {
  const cur = Number((await env.ORDERS.get(debtKey(userId))) || 0);
  await env.ORDERS.put(debtKey(userId), String(cur + coins));
}

/* ===== ПОДПИСИ =====
   Их две, и они разные. Уведомления о платежах подписаны md5 (устаревший
   формат ВКонтакте, выбора нет), параметры запуска игры — HMAC-SHA256.
   Секрет один и тот же: «защищённый ключ» приложения. */

/* Уведомление: пары параметр=значение, кроме sig, отсортировать по алфавиту,
   склеить без разделителей, дописать защищённый ключ, взять md5. */
async function checkSig(p, secret) {
  const keys = Object.keys(p).filter(k => k !== 'sig').sort();
  const base = keys.map(k => k + '=' + p[k]).join('') + secret;
  const mine = md5(base);
  return timingSafeEqual(mine, String(p.sig || '').toLowerCase());
}

/* Параметры запуска: взять только vk_*, отсортировать, собрать query-строку,
   HMAC-SHA256 защищённым ключом, base64url без «=». Совпало — возвращаем
   vk_user_id, иначе null. */
async function verifyLaunch(qs, secret) {
  if (!qs || !secret) return null;
  const p = new URLSearchParams(qs.replace(/^\?/, ''));
  const sign = p.get('sign');
  const userId = p.get('vk_user_id');
  if (!sign || !userId) return null;

  const ts = Number(p.get('vk_ts') || 0);
  if (ts && Math.abs(Date.now() / 1000 - ts) > LAUNCH_TTL) return null;

  const ordered = new URLSearchParams();
  [...p.keys()].filter(k => k.startsWith('vk_')).sort().forEach(k => ordered.append(k, p.get(k)));
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, utf8(ordered.toString()));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return timingSafeEqual(b64, sign) ? userId : null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ===== MD5 =====
   Своя реализация не от любви к велосипедам: Web Crypto md5 не поддерживает
   намеренно (алгоритм считается небезопасным), а формат подписи уведомлений
   задаёт ВКонтакте. crypto.subtle.digest('MD5') в Cloudflare работает как
   нестандартное расширение, но тогда воркер нельзя перенести ни на Deno,
   ни на Vercel. Проверено против node:crypto на 12 векторах — server/test.mjs. */
function md5(str) {
  const bytes = utf8(str);
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
             5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
             4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
             6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const len = bytes.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(bytes); withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16)      { F = (B & C) | (~B & D);        g = i; }
      else if (i < 32) { F = (D & B) | (~D & C);        g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D;                 g = (3 * i + 5) & 15; }
      else             { F = C ^ (B | ~D);              g = (7 * i) & 15; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return [a0, b0, c0, d0].map(hexLE).join('');
}
function hexLE(n) {
  let s = '';
  for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 255).toString(16).padStart(2, '0');
  return s;
}

/* ===== МЕЛОЧИ ===== */
function utf8(s) { return new TextEncoder().encode(s); }
async function readParams(req) {
  /* Уведомления ВКонтакте приходят как form-urlencoded POST, но GET на всякий
     случай тоже разбираем: тестовая кнопка в кабинете исторически ходила GET-ом. */
  const out = {};
  new URL(req.url).searchParams.forEach((v, k) => { out[k] = v; });
  if (req.method === 'POST') {
    const ct = req.headers.get('content-type') || '';
    const raw = await req.text();
    if (ct.includes('application/json')) {
      try { Object.assign(out, JSON.parse(raw)); } catch (e) {}
    } else {
      new URLSearchParams(raw).forEach((v, k) => { out[k] = v; });
    }
  }
  return out;
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
/* Игра лежит на другом домене (GitHub Pages), поэтому /claim и /items нужны
   с CORS. Ни куки, ни авторизационные заголовки не используются — вся защита
   в подписи параметров запуска, поэтому «*» здесь ничего не открывает. */
function cors(res) {
  res.headers.set('access-control-allow-origin', '*');
  res.headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.headers.set('access-control-allow-headers', 'content-type');
  res.headers.set('access-control-max-age', '86400');
  return res;
}

/* Экспорт для теста (server/test.mjs). В воркере не используется. */
export const _internal = { md5, checkSig, verifyLaunch, ITEMS };

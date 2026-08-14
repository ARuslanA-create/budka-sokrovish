/**
 * Тесты подписей для vk-payments.js. Запуск: node server/test.mjs
 *
 * Проверять тут нечего «на глаз»: если md5 или порядок склейки параметров
 * разойдётся с тем, что считает ВКонтакте, платежи не заработают, а увидим мы
 * это только на живой покупке в кабинете — то есть в самый неудобный момент.
 * Поэтому свою реализацию md5 сравниваем с node:crypto, а обе подписи —
 * с независимо посчитанным эталоном.
 */
import { createHash, createHmac } from 'node:crypto';
import worker, { _internal } from './vk-payments.js';

const { md5, checkSig, verifyLaunch } = _internal;
let fail = 0;
const ok = (name, cond, extra) => {
  if (!cond) { fail++; console.log('FAIL ' + name + (extra ? '  ' + extra : '')); }
  else console.log('ok   ' + name);
};

/* ===== 1. md5 против node:crypto ===== */
const vectors = [
  '', 'a', 'abc', 'message digest',
  'abcdefghijklmnopqrstuvwxyz',
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
  'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(57), 'x'.repeat(63), 'x'.repeat(64),
  'x'.repeat(119), 'x'.repeat(120),
  'Будка Сокровищ',                       // кириллица: важно, что считаем по utf-8 байтам
  'item=budka_coins_l&price=50 🪙'        // эмодзи вне BMP: суррогатная пара
];
for (const v of vectors) {
  const mine = md5(v);
  const ref = createHash('md5').update(v, 'utf8').digest('hex');
  ok('md5 len=' + Buffer.byteLength(v), mine === ref, mine + ' != ' + ref);
}

/* ===== 2. Подпись уведомления о платеже =====
   Эталон считаем здесь заново, руками, по описанию из документации:
   пары параметр=значение, кроме sig, по алфавиту, склеить без разделителей,
   дописать защищённый ключ, md5. */
const KEY = 'protected_key_test';
const notice = {
  notification_type: 'order_status_change',
  app_id: '51234567',
  order_id: '987654',
  user_id: '111222',
  receiver_id: '111222',
  item: 'budka_coins_l',
  item_id: 'budka_coins_l',
  item_price: '50',
  item_title: 'Сундук монет — 175 000 🪙',
  status: 'chargeable',
  date: '1755100000',
  version: '1',
  lang: 'ru_RU'
};
const refSig = createHash('md5')
  .update(Object.keys(notice).sort().map(k => k + '=' + notice[k]).join('') + KEY, 'utf8')
  .digest('hex');

ok('sig: правильная подпись принимается', await checkSig({ ...notice, sig: refSig }, KEY));
ok('sig: подпись в верхнем регистре принимается', await checkSig({ ...notice, sig: refSig.toUpperCase() }, KEY));
ok('sig: подменённая цена отклоняется',
   !(await checkSig({ ...notice, item_price: '1', sig: refSig }, KEY)));
ok('sig: подменённый товар отклоняется',
   !(await checkSig({ ...notice, item: 'budka_coins_xl', sig: refSig }, KEY)));
ok('sig: чужой ключ отклоняется', !(await checkSig({ ...notice, sig: refSig }, 'wrong_key')));
ok('sig: без подписи отклоняется', !(await checkSig(notice, KEY)));
ok('sig: лишний параметр отклоняется',
   !(await checkSig({ ...notice, extra: '1', sig: refSig }, KEY)));

/* ===== 3. Подпись параметров запуска игры =====
   Только vk_*, по алфавиту, query-строка, HMAC-SHA256, base64url без «=». */
const launch = {
  vk_user_id: '111222',
  vk_app_id: '51234567',
  vk_is_app_user: '1',
  vk_are_notifications_enabled: '0',
  vk_language: 'ru',
  vk_ref: 'other',
  vk_access_token_settings: '',
  vk_group_id: '',
  vk_viewer_group_role: '',
  vk_platform: 'mobile_android',
  vk_is_favorite: '0',
  vk_ts: String(Math.floor(Date.now() / 1000))
};
const base = new URLSearchParams(Object.keys(launch).sort().map(k => [k, launch[k]])).toString();
const refSign = createHmac('sha256', KEY).update(base).digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const qs = new URLSearchParams({ ...launch, sign: refSign }).toString();

ok('launch: правильная подпись даёт vk_user_id', (await verifyLaunch(qs, KEY)) === '111222');
ok('launch: с ведущим «?» тоже работает', (await verifyLaunch('?' + qs, KEY)) === '111222');
ok('launch: подменённый vk_user_id отклоняется',
   (await verifyLaunch(qs.replace('vk_user_id=111222', 'vk_user_id=999'), KEY)) === null);
ok('launch: чужой ключ отклоняется', (await verifyLaunch(qs, 'wrong_key')) === null);
ok('launch: без подписи отклоняется',
   (await verifyLaunch(new URLSearchParams(launch).toString(), KEY)) === null);
/* Лишние не-vk_ параметры в подпись не входят: ВКонтакте добавляет к ссылке
   и свои utm-метки, и наш собственный хвост — из-за них подпись ломаться не должна. */
ok('launch: посторонний параметр не ломает подпись',
   (await verifyLaunch(qs + '&utm_source=test&foo=bar', KEY)) === '111222');
/* Просроченный запуск: ссылку месячной давности принимать нельзя. */
const stale = { ...launch, vk_ts: String(Math.floor(Date.now() / 1000) - 40 * 24 * 3600) };
const staleBase = new URLSearchParams(Object.keys(stale).sort().map(k => [k, stale[k]])).toString();
const staleSign = createHmac('sha256', KEY).update(staleBase).digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
ok('launch: старый запуск отклоняется',
   (await verifyLaunch(new URLSearchParams({ ...stale, sign: staleSign }).toString(), KEY)) === null);

/* ===== 4. Весь путь покупки целиком =====
   Тут проверяется то, что стоит денег: не начислить оплаченное, начислить дважды,
   начислить чужое. KV подменяем словарём в памяти — интерфейс у неё крошечный. */
const KV = () => {
  const m = new Map();
  return {
    m,
    async get(k, t) { const v = m.get(k); return v == null ? null : (t === 'json' ? JSON.parse(v) : v); },
    async put(k, v) { m.set(k, String(v)); }
  };
};
const sigFor = (params, key) => createHash('md5')
  .update(Object.keys(params).sort().map(k => k + '=' + params[k]).join('') + key, 'utf8').digest('hex');

const call = (path, params, env) => worker.fetch(new Request('https://x.dev' + path, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params).toString()
}), env);
const body = async r => JSON.parse(await r.text());

const order = (id, item, userId) => {
  const p = { notification_type: 'order_status_change', app_id: '5123', order_id: String(id),
    user_id: String(userId), receiver_id: String(userId), item, item_id: item,
    item_price: String(_internal.ITEMS[item].price), item_title: _internal.ITEMS[item].title,
    status: 'chargeable', date: '1755100000', version: '1' };
  return { ...p, sig: sigFor(p, KEY) };
};

{
  const env = { VK_PROTECTED_KEY: KEY, ORDERS: KV() };

  // товар неизвестен — окно покупки открывать нельзя
  const gi = { notification_type: 'get_item', app_id: '5123', order_id: '1', user_id: '111222',
               receiver_id: '111222', item: 'budka_coins_l', lang: 'ru_RU', version: '1' };
  const r1 = await body(await call('/callback', { ...gi, sig: sigFor(gi, KEY) }, env));
  ok('get_item: цена и название из каталога', r1.response && r1.response.price === 50, JSON.stringify(r1));
  const giBad = { ...gi, item: 'budka_coins_free' };
  const r2 = await body(await call('/callback', { ...giBad, sig: sigFor(giBad, KEY) }, env));
  ok('get_item: неизвестный товар — ошибка', !!r2.error && r2.error.critical === true);
  const r3 = await body(await call('/callback', { ...gi, sig: 'deadbeef' }, env));
  ok('callback: битая подпись отклоняется', !!r3.error);

  // оплата
  const paid = await body(await call('/callback', order(555, 'budka_coins_l', 111222), env));
  ok('оплата: ответ с order_id и app_order_id',
     paid.response && paid.response.order_id === 555 && paid.response.app_order_id === 555);

  // повтор того же уведомления не должен удваивать монеты
  await call('/callback', order(555, 'budka_coins_l', 111222), env);
  await call('/callback', order(555, 'budka_coins_l', 111222), env);

  const claimQs = qs;   // подписанные параметры запуска игрока 111222
  const c1 = await body(await call('/claim', { launch: claimQs }, env));
  ok('claim: начислено 175 000 один раз', c1.coins === 175000, JSON.stringify(c1));
  const c2 = await body(await call('/claim', { launch: claimQs }, env));
  ok('claim: повторный запрос не начисляет ничего', c2.coins === 0, JSON.stringify(c2));

  // чужой заказ нельзя забрать своими параметрами запуска
  await call('/callback', order(777, 'budka_coins_xl', 999999), env);
  const c3 = await body(await call('/claim', { launch: claimQs }, env));
  ok('claim: чужой заказ не начисляется', c3.coins === 0, JSON.stringify(c3));

  const c4 = await body(await call('/claim', { launch: 'vk_user_id=111222&sign=подделка' }, env));
  ok('claim: без правильной подписи — 403', c4.error === 'bad_launch_params');

  // возврат уже начисленного: долг вычитается из следующей покупки
  const ref = { ...order(555, 'budka_coins_l', 111222), status: 'refunded' };
  delete ref.sig; ref.sig = sigFor(ref, KEY);
  await call('/callback', ref, env);
  ok('возврат: записан долг', Number(env.ORDERS.m.get('debt:111222')) === 175000);
  await call('/callback', order(556, 'budka_coins_xl', 111222), env);
  const c5 = await body(await call('/claim', { launch: claimQs }, env));
  ok('возврат: следующее начисление уменьшено на долг',
     c5.coins === 400000 - 175000 && c5.refunded === 175000, JSON.stringify(c5));

  // возврат ещё не начисленного заказа: монеты не выдаём вовсе
  const env2 = { VK_PROTECTED_KEY: KEY, ORDERS: KV() };
  await call('/callback', order(900, 'budka_coins_s', 111222), env2);
  const ref2 = { ...order(900, 'budka_coins_s', 111222), status: 'refunded' };
  delete ref2.sig; ref2.sig = sigFor(ref2, KEY);
  await call('/callback', ref2, env2);
  const c6 = await body(await call('/claim', { launch: claimQs }, env2));
  ok('возврат до начисления: монет нет и долга нет',
     c6.coins === 0 && !env2.ORDERS.m.get('debt:111222'), JSON.stringify(c6));

  // витрина
  const items = await body(await worker.fetch(new Request('https://x.dev/items'), env));
  ok('витрина: четыре пакета с ценами в Голосах',
     items.items.length === 4 && items.items.every(i => i.price > 0 && i.coins > 0));
}

console.log(fail ? '\n' + fail + ' тест(ов) провалено' : '\nвсе тесты прошли');
process.exit(fail ? 1 : 0);

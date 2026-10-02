// ─────────────────────────────────────────────────────────────────────────
//  WebSocket-слой Linqo: typing + presence (+ ретрансляция "прочитано").
//
//  Подключение:  wss://<домен>/ws
//  Первое сообщение клиента ОБЯЗАТЕЛЬНО {"t":"auth","token":"<Firebase ID token>"}
//  (токен не в URL — URL попадает в логи прокси). Без auth за 10 сек — закрываем.
//
//  Клиент → сервер:
//    {t:'auth',   token}
//    {t:'typing', to:<uid>, chatId, v:true|false}   (сервер сам проверяет, что вы в чате)
//    {t:'read',   to:<uid>, chatId}                 (ретрансляция, запись в БД остаётся в Firestore)
//    {t:'watch',  uids:[...]}                       (подписка на presence, до 200 uid)
//    {t:'ping'}
//  Сервер → клиент:
//    {t:'ready', uid}
//    {t:'typing', from, chatId, v}
//    {t:'read',   from, chatId}
//    {t:'presence', uid, online, lastSeen}          (lastSeen — ISO-строка, как в users/{uid})
//    {t:'pong'}  {t:'error', code}
//
//  Состояние (кто онлайн, кто кому печатает) живёт в памяти ОДНОГО процесса —
//  запускать нужно ровно один инстанс (pm2 fork / systemd), без кластера.
// ─────────────────────────────────────────────────────────────────────────

const { WebSocketServer } = require('ws');
const { admin, ensureInitialized } = require('./firebaseAdmin');

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;          // ws-ping; не ответил за интервал — рвём
const MAX_WATCH = 200;
const TYPING_MIN_INTERVAL_MS = 700;   // анти-спам typing:true
const MEMBERSHIP_TTL_MS = 5 * 60_000;
const OFFLINE_GRACE_MS = 8_000;       // переподключение (смена сети) не должно мигать "офлайн"

const conns = new Map();        // uid -> Set<ws>
const watchers = new Map();     // watchedUid -> Set<watcherUid>
const typingTo = new Map();     // uid -> Set<peerUid>, кому сейчас сказали typing:true
const offlineTimers = new Map();
const hideCache = new Map();    // uid -> { v, exp }
const memberCache = new Map();  // chatId -> { members, exp }

const chatIdOf = (a, b) => [a, b].sort().join('_');

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendToUid(uid, obj) {
  const set = conns.get(uid);
  if (!set) return;
  const raw = JSON.stringify(obj);
  for (const ws of set) if (ws.readyState === 1) ws.send(raw);
}

async function isHidden(uid) {
  const c = hideCache.get(uid);
  if (c && c.exp > Date.now()) return c.v;
  let v = false;
  try {
    const d = await admin.firestore().collection('users').doc(uid).get();
    v = d.data()?.hideOnline === true;
  } catch (_) {}
  hideCache.set(uid, { v, exp: Date.now() + 60_000 });
  return v;
}

async function areChatMembers(a, b) {
  const chatId = chatIdOf(a, b);
  const c = memberCache.get(chatId);
  if (c && c.exp > Date.now()) return c.ok;
  let ok = false;
  try {
    const d = await admin.firestore().collection('chats').doc(chatId).get();
    const m = d.data()?.members;
    // Чата ещё нет (ни одного сообщения) — typing не нужен; не пускаем.
    ok = Array.isArray(m) && m.includes(a) && m.includes(b);
  } catch (_) {}
  memberCache.set(chatId, { ok, exp: Date.now() + MEMBERSHIP_TTL_MS });
  return ok;
}

async function broadcastPresence(uid, online, lastSeenIso) {
  // hideOnline: наружу "в сети" не показываем, lastSeen тоже не раскрываем
  if (await isHidden(uid)) return;
  const msg = { t: 'presence', uid, online, lastSeen: lastSeenIso };
  for (const w of watchers.get(uid) || []) sendToUid(w, msg);
}

function clearTyping(uid) {
  const peers = typingTo.get(uid);
  if (!peers) return;
  for (const p of peers) sendToUid(p, { t: 'typing', from: uid, chatId: chatIdOf(uid, p), v: false });
  typingTo.delete(uid);
}

async function markOfflineInDb(uid, iso) {
  // Единственная запись в Firestore по presence — при реальном уходе в офлайн
  // (убитое приложение больше не оставляет "в сети" навсегда).
  if (await isHidden(uid)) return;
  try {
    await admin.firestore().collection('users').doc(uid)
      .set({ isOnline: false, lastSeen: iso }, { merge: true });
  } catch (_) {}
}

function attachWebSocket(httpServer) {
  ensureInitialized();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.uid = null;
    ws.lastTypingAt = 0;
    ws.on('pong', () => { ws.isAlive = true; });

    const authTimer = setTimeout(() => { if (!ws.uid) ws.close(4401, 'auth timeout'); }, AUTH_TIMEOUT_MS);

    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m.t !== 'string') return;

      if (m.t === 'ping') return send(ws, { t: 'pong' });

      if (m.t === 'auth') {
        if (ws.uid || typeof m.token !== 'string') return;
        try {
          const dec = await admin.auth().verifyIdToken(m.token);
          ws.uid = dec.uid;
        } catch {
          send(ws, { t: 'error', code: 'unauthenticated' });
          return ws.close(4401, 'bad token');
        }
        clearTimeout(authTimer);
        const t = offlineTimers.get(ws.uid);
        if (t) { clearTimeout(t); offlineTimers.delete(ws.uid); }

        let set = conns.get(ws.uid);
        const first = !set || set.size === 0;
        if (!set) conns.set(ws.uid, (set = new Set()));
        set.add(ws);
        send(ws, { t: 'ready', uid: ws.uid });
        if (first) broadcastPresence(ws.uid, true, null);
        return;
      }

      if (!ws.uid) return send(ws, { t: 'error', code: 'unauthenticated' });

      if (m.t === 'typing') {
        const to = String(m.to || '');
        if (!to || to === ws.uid) return;
        const v = m.v === true;
        const now = Date.now();
        if (v && now - ws.lastTypingAt < TYPING_MIN_INTERVAL_MS) return;
        if (v) ws.lastTypingAt = now;
        if (!(await areChatMembers(ws.uid, to))) return;
        let s = typingTo.get(ws.uid);
        if (v) { if (!s) typingTo.set(ws.uid, (s = new Set())); s.add(to); }
        else if (s) { s.delete(to); if (!s.size) typingTo.delete(ws.uid); }
        sendToUid(to, { t: 'typing', from: ws.uid, chatId: chatIdOf(ws.uid, to), v });
        return;
      }

      if (m.t === 'read') {
        const to = String(m.to || '');
        if (!to || to === ws.uid) return;
        if (!(await areChatMembers(ws.uid, to))) return;
        sendToUid(to, { t: 'read', from: ws.uid, chatId: chatIdOf(ws.uid, to) });
        return;
      }

      if (m.t === 'watch') {
        if (!Array.isArray(m.uids)) return;
        // сначала снимаем старые подписки этого пользователя
        for (const set of watchers.values()) set.delete(ws.uid);
        const uids = [...new Set(m.uids.filter((u) => typeof u === 'string'))].slice(0, MAX_WATCH);
        for (const u of uids) {
          if (!watchers.has(u)) watchers.set(u, new Set());
          watchers.get(u).add(ws.uid);
          // мгновенный снапшот текущего состояния онлайн-пользователей
          if (conns.get(u)?.size && !(await isHidden(u))) {
            send(ws, { t: 'presence', uid: u, online: true, lastSeen: null });
          }
        }
        return;
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      const uid = ws.uid;
      if (!uid) return;
      const set = conns.get(uid);
      if (!set) return;
      set.delete(ws);
      if (set.size) return;               // ещё есть другие устройства
      conns.delete(uid);
      clearTyping(uid);
      // Небольшая отсрочка: при смене сети клиент переподключается за секунды
      const timer = setTimeout(() => {
        offlineTimers.delete(uid);
        if (conns.get(uid)?.size) return;
        for (const s of watchers.values()) s.delete(uid);
        const iso = new Date().toISOString();
        broadcastPresence(uid, false, iso);
        markOfflineInDb(uid, iso);
      }, OFFLINE_GRACE_MS);
      offlineTimers.set(uid, timer);
    });

    ws.on('error', () => {});
  });

  // Убиваем "зависшие" сокеты (VPN/DPI-маршруты рвутся без FIN)
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(hb));

  // чистим протухшие кэши
  setInterval(() => {
    const n = Date.now();
    for (const [k, v] of memberCache) if (v.exp < n) memberCache.delete(k);
    for (const [k, v] of hideCache) if (v.exp < n) hideCache.delete(k);
  }, 10 * 60_000).unref();

  console.log('✅ WebSocket слой запущен на /ws');
  return wss;
}

module.exports = { attachWebSocket };

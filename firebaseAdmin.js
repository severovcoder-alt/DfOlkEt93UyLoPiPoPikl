// ─────────────────────────────────────────────────────────────────────────
//  Инициализация Firebase Admin SDK.
//
//  Нужна, чтобы:
//   1) проверять Firebase ID-токен пользователя (замена context.auth
//      из Cloud Functions onCall) — см. verifyIdToken() ниже;
//   2) обращаться к Firestore из matchContacts.js.
//
//  Сервисный аккаунт передаётся через переменную окружения
//  FIREBASE_SERVICE_ACCOUNT — это содержимое JSON-файла ключа сервисного
//  аккаунта (Firebase Console → Project settings → Service accounts →
//  Generate new private key), вставленное как ОДНА строка (весь JSON целиком).
//
//  НИКОГДА не коммитьте сам JSON-файл ключа в git — только в переменные
//  окружения сервера (Render → Environment).
// ─────────────────────────────────────────────────────────────────────────

const admin = require('firebase-admin');

let initialized = false;

function ensureInitialized() {
  if (initialized) return;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.error(
      '❌ Не задана переменная окружения FIREBASE_SERVICE_ACCOUNT ' +
      '(JSON ключа сервисного аккаунта Firebase). Запросы, требующие ' +
      'авторизации или Firestore (например /matchContacts), будут падать с 500.'
    );
    return;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (err) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT содержит невалидный JSON:', err.message);
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  initialized = true;
  console.log('✅ Firebase Admin инициализирован');
}

// Express-миддлвар: проверяет заголовок "Authorization: Bearer <idToken>",
// который клиент должен получить через firebase.auth().currentUser.getIdToken().
// При успехе кладёт данные пользователя в req.authUser (аналог context.auth).
async function requireAuth(req, res, next) {
  ensureInitialized();

  if (!initialized) {
    return res.status(500).json({ error: 'Server misconfigured: missing Firebase service account' });
  }

  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'unauthenticated', message: 'Нужно быть авторизованным' });
  }

  const idToken = match[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.authUser = decoded; // decoded.uid и т.д.
    next();
  } catch (err) {
    console.error('Ошибка проверки ID-токена:', err.message);
    return res.status(401).json({ error: 'unauthenticated', message: 'Невалидный или истёкший токен' });
  }
}

module.exports = { admin, ensureInitialized, requireAuth };

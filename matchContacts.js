// ─────────────────────────────────────────────────────────────────────────
//  POST /matchContacts
//
//  Перенесено из Firebase Cloud Function matchContacts (functions/index.js,
//  https.onCall). Здесь та же логика, но как обычный Express-роут:
//   - авторизация через middleware requireAuth (проверка Firebase ID-токена
//     вместо context.auth из onCall);
//   - тело запроса: { "phones": ["+79991234567", ...] } вместо data;
//   - ошибки возвращаются как обычные HTTP-коды вместо HttpsError.
//
//  Клиент должен слать заголовок:
//    Authorization: Bearer <firebase ID token>
//  который получают через firebase.auth().currentUser.getIdToken().
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');
const { admin, requireAuth } = require('./firebaseAdmin');

const router = express.Router();

// Firestore 'in' поддерживает максимум 30 значений в одном запросе —
// бьём список номеров на чанки.
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Простая нормализация E.164: убираем всё кроме цифр и ведущего +,
// приводим типичные варианты российских номеров к единому виду.
// Основную нормализацию всё же лучше делать на клиенте (там проще
// использовать локальную адресную книгу пользователя), здесь —
// подстраховка на случай кривых данных.
function normalizeLoose(raw) {
  if (!raw) return null;
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('8') && digits.length === 11) {
    digits = '+7' + digits.slice(1);
  } else if (digits.length === 10) {
    digits = '+7' + digits;
  } else if (!digits.startsWith('+')) {
    digits = '+' + digits;
  }
  return digits;
}

router.post('/matchContacts', requireAuth, async (req, res) => {
  try {
    const db = admin.firestore();

    const rawPhones = Array.isArray(req.body?.phones) ? req.body.phones : [];
    if (rawPhones.length === 0) {
      return res.status(400).json({ error: 'invalid-argument', message: 'Список номеров пуст' });
    }
    if (rawPhones.length > 2000) {
      return res.status(400).json({
        error: 'invalid-argument',
        message: 'Слишком много контактов за один запрос (максимум 2000)',
      });
    }

    const myUid = req.authUser.uid;

    // Дедуп + нормализация + отсечение собственного номера не требуется —
    // просто не покажем себя же в результатах ниже.
    const phoneSet = new Set(
      rawPhones.map(normalizeLoose).filter((p) => p && p.length >= 8)
    );
    const phones = Array.from(phoneSet);

    const foundUids = new Map(); // uid -> matched phone (для отладки/сортировки)

    const chunks = chunkArray(phones, 30);
    for (const chunk of chunks) {
      const snap = await db
        .collectionGroup('private')
        .where('phoneNumber', 'in', chunk)
        .where('phoneVerified', '==', true)
        .get();

      for (const doc of snap.docs) {
        // doc.ref.parent.parent — это users/{uid} (родитель подколлекции private)
        const userRef = doc.ref.parent.parent;
        if (!userRef) continue;
        const uid = userRef.id;
        if (uid === myUid) continue; // себя не показываем
        foundUids.set(uid, doc.data().phoneNumber);
      }
    }

    if (foundUids.size === 0) {
      return res.json({ matches: [] });
    }

    // Подтягиваем публичные профили найденных пользователей.
    // Firestore getAll — эффективнее, чем поштучные get().
    const userRefs = Array.from(foundUids.keys()).map((uid) =>
      db.collection('users').doc(uid)
    );
    const userSnaps = await db.getAll(...userRefs);

    const matches = [];
    for (const snap of userSnaps) {
      if (!snap.exists) continue;
      const u = snap.data();
      matches.push({
        uid: snap.id,
        name: u.name || '',
        username: u.username || '',
        avatar: u.avatar || '',
        isPremium: u.isPremium || false,
        badgeColor: u.badgeColor || 'purple',
        // Номер телефона намеренно НЕ возвращаем клиенту —
        // это приватные данные другого пользователя.
      });
    }

    return res.json({ matches });
  } catch (err) {
    console.error('Ошибка в /matchContacts:', err);
    return res.status(500).json({ error: 'internal', message: 'Failed to match contacts' });
  }
});

module.exports = router;

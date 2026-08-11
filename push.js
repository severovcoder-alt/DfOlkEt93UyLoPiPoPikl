// ─────────────────────────────────────────────────────────────────────────
//  POST /sendPush
//
//  Отправляет push-уведомление через FCM HTTP v1 API, используя тот же
//  Firebase Admin SDK, что и /matchContacts (firebaseAdmin.js).
//
//  Раньше клиент слал пуши напрямую с телефона через FCM Legacy API
//  (fcm.googleapis.com/fcm/send + Server Key). Google полностью отключил
//  Legacy API в июне 2024 — этот способ больше не работает физически.
//  FCM v1 требует авторизацию через service account, а его нельзя класть
//  в приложение (секрет), поэтому отправка переехала сюда, на сервер —
//  здесь уже есть service account (FIREBASE_SERVICE_ACCOUNT) для /matchContacts.
//
//  Клиент должен слать:
//    POST /sendPush
//    Authorization: Bearer <firebase ID token>
//    Content-Type: application/json
//    {
//      "token": "<fcm device token получателя>",
//      "title": "Имя отправителя",
//      "body": "Текст уведомления",
//      "data": { "type": "chat", "chatId": "...", ... },   // опционально
//      "priority": "high",                                   // опционально
//      "collapseKey": "chat_123",                             // опционально
//      "isCall": false                                        // опционально, влияет на канал/приоритет
//    }
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');
const { admin, requireAuth } = require('./firebaseAdmin');

const router = express.Router();

router.post('/sendPush', requireAuth, async (req, res) => {
  console.log('[sendPush] requireAuth пройден, uid =', req.authUser?.uid);
  try {
    const { token, title, body, data, collapseKey, isCall } = req.body || {};

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'invalid-argument', message: 'Missing "token"' });
    }
    if (!title || !body) {
      return res.status(400).json({ error: 'invalid-argument', message: 'Missing "title" or "body"' });
    }

    // FCM data-payload поддерживает только строки в значениях
    const stringData = {};
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        stringData[k] = String(v);
      }
    }
    stringData.title = title;
    stringData.body = body;

    const channelId = isCall ? 'calls' : 'messages';

    const message = {
      token,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        collapseKey: collapseKey || undefined,
        notification: {
          channelId,
          priority: isCall ? 'max' : 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          ...(isCall ? { 'apns-push-type': 'alert' } : {}),
        },
        payload: {
          aps: {
            sound: 'default',
            'content-available': 1,
            ...(isCall ? { 'interruption-level': 'time-sensitive' } : {}),
          },
        },
      },
    };

    try {
      console.log('[sendPush] отправляю в FCM...');
      const messageId = await admin.messaging().send(message);
      console.log('[sendPush] FCM ответил, messageId =', messageId);
      return res.json({ ok: true, messageId });
    } catch (err) {
      // Токен протух/невалиден — сообщаем клиенту явным кодом,
      // чтобы он мог удалить его из Firestore (аналог _removeInvalidToken).
      // ВАЖНО: сюда должны попадать только коды, однозначно означающие
      // "этот конкретный токен больше нельзя использовать". Раньше сюда
      // же попадал и 'messaging/invalid-argument' — а это общая ошибка
      // некорректного payload (не обязательно связанная с токеном), из-за
      // чего валидный fcmToken получателя мог случайно удаляться из
      // Firestore, и все следующие пуши в этот чат молча переставали
      // отправляться.
      const invalidCodes = [
        'messaging/registration-token-not-registered',
        'messaging/invalid-registration-token',
      ];
      if (invalidCodes.includes(err.code)) {
        return res.status(410).json({ error: 'invalid-token', message: err.message });
      }
      if (err.code === 'messaging/invalid-argument') {
        console.error('Некорректный payload push-уведомления (не связано с токеном):', err.message);
        return res.status(400).json({ error: 'invalid-argument', message: err.message });
      }
      console.error('Ошибка отправки push:', err);
      return res.status(502).json({ error: 'fcm-error', message: err.message });
    }
  } catch (err) {
    console.error('Ошибка в /sendPush:', err);
    return res.status(500).json({ error: 'internal', message: 'Failed to send push' });
  }
});

module.exports = router;

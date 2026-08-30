// ─────────────────────────────────────────────────────────────────────────
//  GET /turn-credentials
//
//  Выдаёт временные TURN username/password для coturn (shared-secret
//  схема, static-auth-secret + use-auth-secret в /etc/turnserver.conf на
//  VPS). Раньше вместо этого был /token для Agora — звонки теперь на
//  чистом WebRTC, relay идёт через свой coturn, а не через Agora Cloud.
//
//  Требует авторизации (Authorization: Bearer <firebase ID token>) —
//  без этого кто угодно мог бы бесплатно попользоваться твоим relay-
//  сервером и его каналом.
//
//  Схема username/password стандартная для coturn REST API:
//    username = "<unix-timestamp-истечения>:<uid>"
//    password = base64(HMAC-SHA1(secret, username))
//  Сам coturn при подключении клиента пересчитывает этот HMAC и сверяет —
//  ничего сверх статического секрета на сервере хранить не нужно.
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('./firebaseAdmin');

const router = express.Router();

const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET;
const TURN_HOST = process.env.TURN_HOST || 'turn.linqosocial.online';
const TURN_CRED_TTL_SECONDS = 24 * 60 * 60; // сутки

router.get('/turn-credentials', requireAuth, (req, res) => {
  if (!TURN_SHARED_SECRET) {
    console.error(
      '❌ Не задана переменная окружения TURN_SHARED_SECRET ' +
      '(тот же секрет, что static-auth-secret в /etc/turnserver.conf на VPS).'
    );
    return res.status(500).json({ error: 'Server misconfigured: missing TURN secret' });
  }

  try {
    const uid = req.authUser.uid;
    const expiry = Math.floor(Date.now() / 1000) + TURN_CRED_TTL_SECONDS;
    const username = `${expiry}:${uid}`;

    const hmac = crypto.createHmac('sha1', TURN_SHARED_SECRET);
    hmac.update(username);
    const credential = hmac.digest('base64');

    return res.json({
      username,
      credential,
      ttl: TURN_CRED_TTL_SECONDS,
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`,
        `turns:${TURN_HOST}:5349?transport=tcp`,
      ],
    });
  } catch (err) {
    console.error('Ошибка генерации TURN credentials:', err);
    return res.status(500).json({ error: 'Failed to generate TURN credentials' });
  }
});

module.exports = router;

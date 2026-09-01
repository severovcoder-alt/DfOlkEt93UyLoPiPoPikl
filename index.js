// ─────────────────────────────────────────────────────────────────────────
//  Linqo Backend Server
// ─────────────────────────────────────────────────────────────────────────


// Локально можно положить секреты в файл .env рядом с index.js —
// dotenv подхватит его автоматически. На Render/Railway секреты задаются
// через Environment в панели хостинга и .env там не нужен.
// (Раньше здесь был захардкожен путь 'C:/secrets/tokens.env' — работал
// только на одной конкретной Windows-машине и был причиной того, что
// AGORA_APP_ID/AGORA_APP_CERTIFICATE не подхватывались на проде.)
require('dotenv').config();

// Форсируем IPv4 для всех исходящих соединений (fetch, https, firebase-admin и т.д.).
// На некоторых VPS IPv6 либо не настроен, либо блокируется провайдером —
// без этого Node может пытаться коннектиться по IPv6 первым и виснуть/таймаутить.
require('dns').setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const matchContactsRouter = require('./matchContacts');
const pushRouter = require('./push');
const turnCredentialsRouter = require('./turnCredentials');
const mediaRouter = require('./media');

const app = express();

// Сервер обычно работает не напрямую, а за прокси (Cloudflare Tunnel,
// Render, Railway и т.п.) — сам процесс видит только http на localhost,
// а наружу отдаётся https через прокси. Без этой строки req.protocol
// всегда будет 'http', даже если снаружи https, и apk_url в /version
// будет собираться неправильно (http:// вместо https://).
// 'trust proxy' указывает Express брать протокол/хост из заголовков
// X-Forwarded-Proto / X-Forwarded-Host, которые проставляет прокси.
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());
app.use(matchContactsRouter);
app.use(pushRouter);
app.use(turnCredentialsRouter);
app.use(mediaRouter);

if (!process.env.TURN_SHARED_SECRET) {
  console.error(
    '❌ Не задана переменная окружения TURN_SHARED_SECRET (тот же секрет, ' +
    'что static-auth-secret в /etc/turnserver.conf на VPS с coturn). ' +
    'Сервер запустится, но /turn-credentials будет возвращать ошибку 500.'
  );
}

// Простой health-check — удобно для Render/Railway, чтобы видеть, что сервис жив
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'linqo-token-server', endpoints: ['/turn-credentials', '/version', '/matchContacts', '/sendPush', '/apk', '/media/upload'] });
});

// Статическая раздача APK-файлов: кладёшь файл в папку apk/ рядом с
// index.js — он сразу становится доступен по /apk/<имя файла>.
// Не коммитится в git (см. .gitignore) — заливается на сервер напрямую
// (например, через SCP/SFTP или панель хостинга), APK — большой бинарник.
app.use('/apk', express.static(path.join(__dirname, 'apk')));

// Раньше здесь был роут /download, отдающий HTML-страницу из public/.
// Сайт переехал на отдельный хостинг (рег.ру) и обращается сюда только
// за данными через fetch('/version') с абсолютным URL этого сервиса —
// см. README, раздел "Деплой сайтов".

// GET /version — проверка версии приложения.
//
// Приложение при каждом запуске дёргает этот эндпоинт и сравнивает
// полученный "version" со своей локальной версией (версия из pubspec.yaml,
// читается через package_info_plus). Если серверная версия новее —
// показывается диалог обновления.
//   force_update: true  — диалог нельзя закрыть, обновление обязательно.
//   force_update: false — диалог можно скипнуть ("Позже").
//
// version.json читается с диска при каждом запросе (а не кэшируется в
// памяти), поэтому чтобы выкатить новую версию/force_update, достаточно
// отредактировать файл на сервере — без передеплоя и рестарта процесса.
//
// apk_filename в version.json -> сервер сам собирает по нему полный
// apk_url вида https://<домен-сервера>/apk/<файл>, используя хост
// текущего запроса (значит работает одинаково и на кастомном домене,
// и на *.onrender.com, без хардкода).
// apk_filename в version.json -> сервер сам собирает по нему полный
// apk_url вида https://<домен-сервера>/apk/<файл>, используя хост
// текущего запроса (значит работает одинаково и на кастомном домене,
// и на *.onrender.com, без хардкода).
//
// Альтернатива: если APK лежит не на этом сервере (например, на
// статическом хостинге вместе с сайтом — так проще, потому что не
// нужно тащить большой бинарник через git на Render), можно вместо
// apk_filename указать в version.json готовый apk_url целиком —
// сервер отдаст его как есть, ничего не собирая.
const VERSION_FILE_PATH = path.join(__dirname, 'version.json');

app.get('/version', (req, res) => {
  try {
    const raw = fs.readFileSync(VERSION_FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);

    const apkFilename = data.apk_filename ? String(data.apk_filename) : '';
    const apkUrl = data.apk_url
      ? String(data.apk_url)
      : (apkFilename
          ? `${req.protocol}://${req.get('host')}/apk/${encodeURIComponent(apkFilename)}`
          : '');

    return res.json({
      version: String(data.version ?? '0.0.0'),
      description: String(data.description ?? ''),
      force_update: Boolean(data.force_update),
      apk_url: apkUrl,
    });
  } catch (err) {
    console.error('Ошибка чтения version.json:', err);
    return res.status(500).json({ error: 'Failed to read version info' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Linqo token server запущен на порту ${PORT}`);
});

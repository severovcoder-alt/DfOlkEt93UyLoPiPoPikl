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

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
const matchContactsRouter = require('./matchContacts');
const pushRouter = require('./push');

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

const APP_ID = process.env.AGORA_APP_ID;
const APP_CERTIFICATE = process.env.AGORA_APP_CERTIFICATE;

// Токен живёт час — CallScreen сам обновляет его через onTokenPrivilegeWillExpire
const TOKEN_EXPIRATION_SECONDS = 3600;

if (!APP_ID || !APP_CERTIFICATE) {
  console.error(
    '❌ Не заданы AGORA_APP_ID и/или AGORA_APP_CERTIFICATE в переменных окружения. ' +
    'Сервер запустится, но все запросы на /token будут возвращать ошибку 500.'
  );
}

// Простой health-check — удобно для Render/Railway, чтобы видеть, что сервис жив
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'linqo-token-server', endpoints: ['/token', '/version', '/vegaVersion', '/matchContacts', '/sendPush', '/apk', '/VegaApk'] });
});

// Статическая раздача APK-файлов: кладёшь файл в папку apk/ рядом с
// index.js — он сразу становится доступен по /apk/<имя файла>.
// Не коммитится в git (см. .gitignore) — заливается на сервер напрямую
// (например, через SCP/SFTP или панель хостинга), APK — большой бинарник.
app.use('/apk', express.static(path.join(__dirname, 'apk')));

// То же самое, но для APK VegaChat — отдельная папка, отдельный сайт
// скачивания, полностью независимо от Linqo (другое приложение того же
// владельца сервера). Кладёшь файл в VegaApk/ — он доступен по
// /VegaApk/<имя файла>.
app.use('/VegaApk', express.static(path.join(__dirname, 'VegaApk')));

// Раньше здесь были роуты /download и /VegaChat, отдающие HTML-страницы
// из public/. Сайты переехали на отдельный хостинг (рег.ру) и обращаются
// сюда только за данными через fetch('/version') / fetch('/vegaVersion')
// с абсолютным URL этого сервиса — см. README, раздел "Деплой сайтов".

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

// GET /vegaVersion — то же самое, что /version, но для VegaChat.
// Читает VegaChatVersion/VegaChatDescription/VegaChatForceUpdate/
// VegaChatApkFilename (или VegaChatApkUrl — см. комментарий выше про
// apk_url) из того же version.json.
app.get('/vegaVersion', (req, res) => {
  try {
    const raw = fs.readFileSync(VERSION_FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);

    const apkFilename = data.VegaChatApkFilename ? String(data.VegaChatApkFilename) : '';
    const apkUrl = data.VegaChatApkUrl
      ? String(data.VegaChatApkUrl)
      : (apkFilename
          ? `${req.protocol}://${req.get('host')}/VegaApk/${encodeURIComponent(apkFilename)}`
          : '');

    return res.json({
      version: String(data.VegaChatVersion ?? '0.0.0'),
      description: String(data.VegaChatDescription ?? ''),
      force_update: Boolean(data.VegaChatForceUpdate),
      apk_url: apkUrl,
    });
  } catch (err) {
    console.error('Ошибка чтения version.json (VegaChat):', err);
    return res.status(500).json({ error: 'Failed to read version info' });
  }
});

// GET /token?channel=<строка>&uid=<число, обычно 0>
app.get('/token', (req, res) => {
  const { channel, uid } = req.query;

  if (!APP_ID || !APP_CERTIFICATE) {
    return res.status(500).json({ error: 'Server misconfigured: missing Agora credentials' });
  }

  if (!channel || typeof channel !== 'string') {
    return res.status(400).json({ error: 'Missing required "channel" query param' });
  }

  // uid=0 в приложении означает "пусть Agora сам назначит числовой uid" —
  // для токена это валидное и часто используемое значение.
  const numericUid = uid !== undefined ? Number(uid) : 0;
  if (Number.isNaN(numericUid)) {
    return res.status(400).json({ error: '"uid" must be a number' });
  }

  try {
    const expirationTimeInSeconds = TOKEN_EXPIRATION_SECONDS;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID,
      APP_CERTIFICATE,
      channel,
      numericUid,
      RtcRole.PUBLISHER,
      privilegeExpiredTs,
      privilegeExpiredTs
    );

    return res.json({ token });
  } catch (err) {
    console.error('Ошибка генерации токена:', err);
    return res.status(500).json({ error: 'Failed to generate token' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Linqo token server запущен на порту ${PORT}`);
});

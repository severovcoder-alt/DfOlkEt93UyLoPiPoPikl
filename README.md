# Linqo Backend Server

Единый Express-сервис для Linqo, объединяющий несколько раньше отдельных бэкендов:

1. **TURN credentials** (`GET /turn-credentials`) — выдаёт временные
   username/password для твоего coturn-сервера (VPS) по shared-secret
   схеме. Раньше здесь был `GET /token`, отдающий Agora RTC-токены —
   звонки переехали на чистый WebRTC (`flutter_webrtc`), сигналинг идёт
   через Firestore, а relay — через свой coturn, без Agora Cloud.
   Именно этот сервис приложение ожидает по адресу `TOKEN_SERVER_URL`
   (см. `AppSecrets.tokenServerUrl` и `CallService.fetchTurnCredentials`
   в Flutter-проекте).
2. **matchContacts** (`POST /matchContacts`) — бывшая Firebase Cloud Function
   (`functions/matchContacts.js`), перенесённая сюда как обычный HTTP-роут,
   чтобы всё крутилось на одном сервисе.
3. **sendPush** (`POST /sendPush`) — отправка push через FCM v1 API.

## Что нужно для /turn-credentials (coturn на VPS)

На VPS с coturn (`/etc/turnserver.conf`) должно быть:
```
use-auth-secret
static-auth-secret=<ДЛИННАЯ_СЛУЧАЙНАЯ_СТРОКА>
```

То же самое значение кладём сюда, в переменную окружения `TURN_SHARED_SECRET`.
Сгенерировать секрет: `openssl rand -hex 32`.

`TURN_HOST` — домен твоего coturn-сервера (например `turn.linqosocial.online`).

Эндпоинт требует авторизации (иначе кто угодно мог бы бесплатно
попользоваться твоим relay-сервером):

```
GET /turn-credentials
Authorization: Bearer <firebase ID token>
```

Ответ:
```json
{
  "username": "1735689600:someUid",
  "credential": "base64hmac==",
  "ttl": 86400,
  "urls": [
    "turn:turn.linqosocial.online:3478?transport=udp",
    "turn:turn.linqosocial.online:3478?transport=tcp",
    "turns:turn.linqosocial.online:5349?transport=tcp"
  ]
}
```

## Что нужно для /matchContacts (Firebase)

Роуту нужен доступ к Firestore и проверка Firebase ID-токенов пользователей.
Для этого:

1. Firebase Console → Project settings → Service accounts → **Generate new private key**.
   Скачается JSON-файл ключа сервисного аккаунта.
2. Возьмите содержимое этого JSON целиком (как одну строку) и положите
   в переменную окружения `FIREBASE_SERVICE_ACCOUNT` на хостинге.
3. ⚠️ Сам JSON-файл никогда не коммитьте в git — только в Environment на хостинге.

Тот же `FIREBASE_SERVICE_ACCOUNT` используется и для проверки токена
в `/turn-credentials`, и в `/sendPush`.

Клиент должен звать эндпоинт так:

```
POST /matchContacts
Authorization: Bearer <firebase ID token>
Content-Type: application/json

{ "phones": ["+79991234567", "+79997654321"] }
```

Ответ (аналогично тому, что раньше возвращала onCall-функция):

```json
{ "matches": [ { "uid": "...", "name": "...", "username": "...", "avatar": "...", "isPremium": false, "badgeColor": "purple" } ] }
```

Ошибки авторизации → `401`, ошибки валидации → `400`, внутренние → `500`
(вместо firebase `HttpsError`, который использовался в исходной Cloud Function).

## Деплой на Render (бесплатный план)

1. Зайдите на https://render.com → New → Web Service.
2. Подключите репозиторий с этой папкой (или загрузите её в отдельный репозиторий на GitHub).
3. Настройки сервиса:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
4. В разделе **Environment** добавьте переменные:
   - `TURN_SHARED_SECRET` = тот же секрет, что `static-auth-secret` на VPS с coturn
   - `TURN_HOST` = домен coturn-сервера (например `turn.linqosocial.online`)
   - `FIREBASE_SERVICE_ACCOUNT` = содержимое JSON-ключа сервисного аккаунта
     Firebase, целиком как одна строка
5. После деплоя Render даст вам URL вида `https://linqo-token-server.onrender.com`.
6. Проверьте: `https://<ваш-домен>/` — должен вернуться `{"ok": true, ...}`.
   `/turn-credentials` без заголовка `Authorization` должен вернуть `401`.

⚠️ На бесплатном плане Render сервис "засыпает" после ~15 минут без запросов
(именно это упомянуто в комментарии кода `CallService.fetchTurnCredentials` —
поэтому там уже есть таймаут на случай "просыпания").

## Деплой на Railway (альтернатива)

1. https://railway.app → New Project → Deploy from GitHub repo.
2. Добавьте переменные окружения `TURN_SHARED_SECRET`, `TURN_HOST`
   и `FIREBASE_SERVICE_ACCOUNT`.
3. Railway сам определит `npm start` из package.json.
4. Скопируйте публичный домен сервиса.

## Настройка в приложении

`TOKEN_SERVER_URL` передаётся при сборке Flutter-приложения через `--dart-define`,
без слэша в конце:

```
flutter build apk \
  --dart-define=TOKEN_SERVER_URL=https://<ваш-домен-сервера>
```

Значение сохранится в защищённом хранилище на устройстве при первом запуске
(см. `AppSecrets.init()`), дальше можно не передавать при пересборке — если
только не нужно его сменить.

## Локальный запуск для теста

```bash
npm install
TURN_SHARED_SECRET=xxx TURN_HOST=turn.linqosocial.online FIREBASE_SERVICE_ACCOUNT='{...}' npm start

# без токена — должно вернуть 401
curl "http://localhost:8080/turn-credentials"

# с токеном — должно вернуть username/credential
curl "http://localhost:8080/turn-credentials" \
  -H "Authorization: Bearer <firebase id token>"

curl -X POST "http://localhost:8080/matchContacts" \
  -H "Authorization: Bearer <firebase id token>" \
  -H "Content-Type: application/json" \
  -d '{"phones": ["+79991234567"]}'
```

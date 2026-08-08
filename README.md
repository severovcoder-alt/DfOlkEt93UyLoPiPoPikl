# Linqo Backend Server

Единый Express-сервис для Linqo, объединяющий два раньше отдельных бэкенда:

1. **Agora Token Server** (`GET /token`) — отдаёт Agora RTC-токены для звонков.
   Именно этот сервер приложение ожидает по адресу `TOKEN_SERVER_URL`
   (см. `AppSecrets.tokenServerUrl` и `CallService.fetchToken` в Flutter-проекте).
2. **matchContacts** (`POST /matchContacts`) — бывшая Firebase Cloud Function
   (`functions/matchContacts.js`), перенесённая сюда как обычный HTTP-роут,
   чтобы всё крутилось на одном сервисе Render.

## Что нужно из Agora Console

Project → Edit → Security:
- **App ID**
- **Primary Certificate** (обязательно включена — без неё токены не сгенерировать)

⚠️ App Certificate — секретный ключ. Никогда не кладите его в приложение,
в git или во фронтенд-код — только в переменные окружения сервера.

## Что нужно для /matchContacts (Firebase)

Роуту нужен доступ к Firestore и проверка Firebase ID-токенов пользователей.
Для этого:

1. Firebase Console → Project settings → Service accounts → **Generate new private key**.
   Скачается JSON-файл ключа сервисного аккаунта.
2. Возьмите содержимое этого JSON целиком (как одну строку) и положите
   в переменную окружения `FIREBASE_SERVICE_ACCOUNT` на Render.
3. ⚠️ Сам JSON-файл никогда не коммитьте в git — только в Environment на Render.

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
   - `AGORA_APP_ID` = ваш App ID
   - `AGORA_APP_CERTIFICATE` = ваш Primary Certificate
   - `FIREBASE_SERVICE_ACCOUNT` = содержимое JSON-ключа сервисного аккаунта
     Firebase, целиком как одна строка (нужно для `/matchContacts`)
5. После деплоя Render даст вам URL вида `https://linqo-token-server.onrender.com`.
6. Проверьте: `https://<ваш-домен>/token?channel=test&uid=0` — должен вернуться `{"token": "..."}`.

⚠️ На бесплатном плане Render сервис "засыпает" после ~15 минут без запросов
(именно это упомянуто в комментарии кода `CallService.fetchToken` — поэтому там
уже есть 3 попытки с увеличивающимся таймаутом на случай "просыпания").

## Деплой на Railway (альтернатива)

1. https://railway.app → New Project → Deploy from GitHub repo.
2. Добавьте переменные окружения `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`
   и `FIREBASE_SERVICE_ACCOUNT`.
3. Railway сам определит `npm start` из package.json.
4. Скопируйте публичный домен сервиса.

## Настройка в приложении

`TOKEN_SERVER_URL` передаётся при сборке Flutter-приложения через `--dart-define`,
без слэша в конце и без `/token`:

```
flutter build apk \
  --dart-define=AGORA_APP_ID=<ваш App ID> \
  --dart-define=TOKEN_SERVER_URL=https://<ваш-домен-сервера>
```

Оба значения сохранятся в защищённом хранилище на устройстве при первом запуске
(см. `AppSecrets.init()`), дальше их можно не передавать при пересборке — если
только не нужно их сменить.

## Локальный запуск для теста

```bash
npm install
AGORA_APP_ID=xxx AGORA_APP_CERTIFICATE=yyy FIREBASE_SERVICE_ACCOUNT='{...}' npm start
curl "http://localhost:8080/token?channel=test&uid=0"
curl -X POST "http://localhost:8080/matchContacts" \
  -H "Authorization: Bearer <firebase id token>" \
  -H "Content-Type: application/json" \
  -d '{"phones": ["+79991234567"]}'
```

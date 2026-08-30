// ─────────────────────────────────────────────────────────────────────────
//  Загрузка/раздача медиа (фото, видео, голосовые, любые файлы) со
//  своего VPS вместо Cloudinary.
//
//  POST /media/upload   (Authorization: Bearer <firebase ID token>)
//    multipart/form-data, поле "file", необязательное поле "type"
//    ('image' | 'video' | 'voice' | 'file') — только для мета-инфы.
//    → { id, url, filename, size, mime, type }
//
//  GET /media/:id/:filename
//    Отдаёт файл (публично, по непредсказуемому id — как secure_url у
//    Cloudinary: ссылку узнают только участники чата через Firestore).
//    Обновляет lastAccess — держит файл "живым", пока им пользуются.
//
//  DELETE /media/:id   (Authorization: Bearer <firebase ID token>,
//                        удалить может только тот, кто загрузил)
//
//  Хранилище: одна папка на диске сервера + JSON-индекс метаданных
//  рядом (метаданные переживают рестарт процесса; сами файлы —
//  переживают, только если у сервера персистентный диск/volume).
//
//  Автоочистка: раз в час удаляются файлы, к которым не было обращений
//  (ни скачивания, ни новой загрузки) дольше MEDIA_TTL_DAYS дней —
//  чтобы диск VPS не забивался старым мусором из давно неактивных
//  чатов. Свежезагруженный файл получает lastAccess = момент загрузки,
//  так что "непрочитанное, но недавнее" не удаляется.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('./firebaseAdmin');

const router = express.Router();

const STORAGE_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media_storage');
const INDEX_PATH = path.join(STORAGE_DIR, '.index.json');

const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 МБ на файл
const MEDIA_TTL_DAYS = Number(process.env.MEDIA_TTL_DAYS || 60); // неактив → удаление
const MAX_TOTAL_GB = process.env.MEDIA_MAX_TOTAL_GB
  ? Number(process.env.MEDIA_MAX_TOTAL_GB)
  : null; // необязательный общий лимит диска, напр. "20"

fs.mkdirSync(STORAGE_DIR, { recursive: true });

// ---- Персистентный индекс метаданных ---------------------------------
// { [id]: { filename, storedName, mime, size, type, uid, uploadedAt, lastAccess } }
let index = {};
try {
  index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
} catch (_) {
  index = {};
}

let saveTimer = null;
function saveIndexSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(INDEX_PATH, JSON.stringify(index), (err) => {
      if (err) console.error('media: не удалось сохранить индекс', err);
    });
  }, 200);
}

function totalStoredBytes() {
  return Object.values(index).reduce((sum, e) => sum + (e.size || 0), 0);
}

// ---- Приём файла --------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STORAGE_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 16);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
});

router.post('/media/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'file_too_large', message: 'Максимум 500 МБ' });
      }
      console.error('media upload error:', err);
      return res.status(400).json({ error: 'upload_failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'no_file' });
    }

    if (MAX_TOTAL_GB !== null) {
      const limitBytes = MAX_TOTAL_GB * 1024 * 1024 * 1024;
      if (totalStoredBytes() + req.file.size > limitBytes) {
        fs.unlink(req.file.path, () => {});
        return res.status(507).json({ error: 'storage_full' });
      }
    }

    const id = path.parse(req.file.filename).name; // uuid без расширения
    const now = Date.now();
    index[id] = {
      filename: req.file.originalname || req.file.filename,
      storedName: req.file.filename,
      mime: req.file.mimetype || 'application/octet-stream',
      size: req.file.size,
      type: (req.body && req.body.type) || 'file',
      uid: req.authUser.uid,
      uploadedAt: now,
      lastAccess: now,
    };
    saveIndexSoon();

    const safeName = encodeURIComponent(index[id].filename);
    const url = `${req.protocol}://${req.get('host')}/media/${id}/${safeName}`;

    return res.json({
      id,
      url,
      filename: index[id].filename,
      size: index[id].size,
      mime: index[id].mime,
      type: index[id].type,
    });
  });
});

// ---- Раздача файла --------------------------------------------------------
router.get('/media/:id/:filename', (req, res) => {
  const entry = index[req.params.id];
  if (!entry) return res.status(404).json({ error: 'not_found' });

  const filePath = path.join(STORAGE_DIR, entry.storedName);
  if (!fs.existsSync(filePath)) {
    delete index[req.params.id];
    saveIndexSoon();
    return res.status(404).json({ error: 'not_found' });
  }

  entry.lastAccess = Date.now();
  saveIndexSoon();

  res.setHeader('Content-Type', entry.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  const disposition = ['image', 'video', 'voice'].includes(entry.type) ? 'inline' : 'attachment';
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${encodeURIComponent(entry.filename)}"`
  );
  fs.createReadStream(filePath).pipe(res);
});

// ---- Удаление (только автор) ----------------------------------------------
router.delete('/media/:id', requireAuth, (req, res) => {
  const entry = index[req.params.id];
  if (!entry) return res.status(404).json({ error: 'not_found' });
  if (entry.uid !== req.authUser.uid) {
    return res.status(403).json({ error: 'forbidden' });
  }
  fs.unlink(path.join(STORAGE_DIR, entry.storedName), () => {});
  delete index[req.params.id];
  saveIndexSoon();
  return res.json({ ok: true });
});

// ---- Автоочистка неактивных файлов -----------------------------------
function cleanupInactive() {
  const cutoff = Date.now() - MEDIA_TTL_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, entry] of Object.entries(index)) {
    if ((entry.lastAccess || entry.uploadedAt || 0) < cutoff) {
      fs.unlink(path.join(STORAGE_DIR, entry.storedName), () => {});
      delete index[id];
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`media: очистка — удалено ${removed} неактивных файлов (> ${MEDIA_TTL_DAYS} дн.)`);
    saveIndexSoon();
  }
}

setInterval(cleanupInactive, 60 * 60 * 1000); // раз в час
setTimeout(cleanupInactive, 30 * 1000); // и один раз вскоре после старта

module.exports = router;

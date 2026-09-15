/**
 * Medien für das Umkleide-Display: Bilder und Videos werden beim Upload
 * auf 1080×1920 (9:16) gebracht, komprimiert und in GridFS abgelegt.
 * So bleibt alles in MongoDB (mongodump sichert weiterhin alles) und die
 * 16-MB-Grenze eines einzelnen Dokuments spielt keine Rolle mehr.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const mongoose = require('mongoose');
const sharp = require('sharp');

const execFileAsync = promisify(execFile);

const BUCKET_NAME = 'umkleide';
const TARGET_WIDTH = 1080;
const TARGET_HEIGHT = 1920;
const POSTER_WIDTH = 540;
const POSTER_HEIGHT = 960;

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v', 'video/x-matroska', 'video/3gpp'];

const isImage = (mimetype) => IMAGE_TYPES.includes(mimetype);
const isVideo = (mimetype) => VIDEO_TYPES.includes(mimetype);

const getBucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });

const toObjectId = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id));

/**
 * Buffer in GridFS ablegen
 * @returns {Promise<{fileId: ObjectId, size: number}>}
 */
const storeBuffer = (buffer, filename, contentType, metadata = {}) =>
  new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(filename, { contentType, metadata });
    upload.on('error', reject);
    upload.on('finish', () => resolve({ fileId: upload.id, size: buffer.length }));
    upload.end(buffer);
  });

/**
 * Datei von der Platte in GridFS streamen
 * @returns {Promise<{fileId: ObjectId, size: number}>}
 */
const storeFile = (filePath, filename, contentType, metadata = {}) =>
  new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(filename, { contentType, metadata });
    upload.on('error', reject);
    upload.on('finish', () => resolve({ fileId: upload.id, size: upload.length }));
    fs.createReadStream(filePath).on('error', reject).pipe(upload);
  });

const deleteFile = async (fileId) => {
  if (!fileId) return;
  try {
    await getBucket().delete(toObjectId(fileId));
  } catch (error) {
    // Datei fehlt bereits – nichts zu tun
    if (!/FileNotFound|not found/i.test(error.message)) throw error;
  }
};

const findFile = async (fileId) => {
  const files = await getBucket().find({ _id: toObjectId(fileId) }).limit(1).toArray();
  return files[0] || null;
};

/**
 * Datei aus GridFS an den Client streamen, mit Range-Unterstützung
 * (Safari spielt Videos ohne Range-Antworten nicht ab).
 */
const streamToResponse = async (fileId, req, res) => {
  const file = await findFile(fileId);
  if (!file) {
    return res.status(404).end();
  }

  const total = file.length;
  const contentType = file.contentType || 'application/octet-stream';
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('Content-Type', contentType);

  const range = req.headers.range;
  let start = 0;
  let end = total - 1;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      if (match[1]) start = parseInt(match[1], 10);
      if (match[2]) end = parseInt(match[2], 10);
      if (!match[1] && match[2]) {
        start = Math.max(0, total - parseInt(match[2], 10));
        end = total - 1;
      }
    }
    if (start >= total || end >= total || start > end) {
      res.set('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  }

  res.set('Content-Length', String(end - start + 1));

  if (req.method === 'HEAD') {
    return res.end();
  }

  // GridFS erwartet `end` exklusiv
  const stream = getBucket().openDownloadStream(file._id, { start, end: end + 1 });
  stream.on('error', (error) => {
    console.error('Umkleide media stream error:', error);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  req.on('close', () => stream.destroy());
  stream.pipe(res);
};

/**
 * Bild auf 1080×1920 zuschneiden und als WebP in GridFS ablegen
 * @param {Buffer|string} source – Buffer oder Pfad
 */
const processImage = async (source, originalName) => {
  const buffer = await sharp(source, { failOn: 'none' })
    .rotate()
    .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'cover', position: 'center' })
    .webp({ quality: 80, effort: 6 })
    .toBuffer();

  const { fileId, size } = await storeBuffer(buffer, originalName, 'image/webp', { kind: 'image' });
  console.log(`🖼️  Umkleide-Bild verarbeitet: ${originalName} → ${Math.round(size / 1024)} KB`);

  return { kind: 'image', fileId, mimeType: 'image/webp', size };
};

const probeDuration = async (filePath) => {
  try {
    const { stdout } = await execFileAsync(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 10) / 10 : null;
  } catch (error) {
    console.warn('ffprobe fehlgeschlagen:', error.message);
    return null;
  }
};

// Einzelbild bei Sekunde 1 – bei sehr kurzen Clips das erste Bild
const extractPoster = async (videoPath, posterPath) => {
  const grab = (seek) => execFileAsync(FFMPEG, [
    '-y',
    ...(seek ? ['-ss', String(seek)] : []),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '3',
    posterPath
  ], { maxBuffer: 10 * 1024 * 1024 });

  try {
    await grab(1);
    await fs.promises.access(posterPath);
  } catch (error) {
    await grab(0);
  }
};

/**
 * Video auf 1080×1920 bringen (cover, wie die Bilder), H.264 ohne Ton,
 * Bitrate gedeckelt, faststart für sofortiges Abspielen. Dazu ein Poster-Bild.
 */
const processVideo = async (inputPath, originalName) => {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'umkleide-'));
  const outputPath = path.join(workDir, 'out.mp4');
  const posterPath = path.join(workDir, 'poster.jpg');

  try {
    await execFileAsync(FFMPEG, [
      '-y',
      '-i', inputPath,
      '-vf', `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,crop=${TARGET_WIDTH}:${TARGET_HEIGHT},fps=30,format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '26',
      '-maxrate', '3M',
      '-bufsize', '6M',
      '-profile:v', 'high',
      '-level', '4.1',
      '-movflags', '+faststart',
      '-an',
      outputPath
    ], { maxBuffer: 10 * 1024 * 1024 });

    await extractPoster(outputPath, posterPath);

    const duration = await probeDuration(outputPath);

    const posterBuffer = await sharp(posterPath)
      .resize(POSTER_WIDTH, POSTER_HEIGHT, { fit: 'cover' })
      .webp({ quality: 75 })
      .toBuffer();

    const { fileId, size } = await storeFile(outputPath, originalName.replace(/\.[^.]+$/, '') + '.mp4', 'video/mp4', { kind: 'video' });
    const { fileId: posterId } = await storeBuffer(posterBuffer, originalName + '.poster', 'image/webp', { kind: 'poster', videoId: fileId });

    console.log(`🎬 Umkleide-Video verarbeitet: ${originalName} → ${Math.round(size / 1024 / 1024 * 10) / 10} MB, ${duration ?? '?'} s`);

    return { kind: 'video', fileId, posterId, mimeType: 'video/mp4', size, duration };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true });
  }
};

const removeTempFile = async (filePath) => {
  if (!filePath) return;
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
};

/**
 * Bestehende Base64-Bilder aus dem Settings-Dokument einmalig nach GridFS
 * übernehmen. Läuft beim Start, ist idempotent.
 */
const migrateLegacyImages = async () => {
  const collection = mongoose.connection.db.collection('umkleidesettings');
  const settings = await collection.findOne({});
  if (!settings) return;

  const legacyImages = (settings.images || []).filter((img) => typeof img.imageData === 'string');
  const alreadyItems = settings.items || [];
  if (legacyImages.length === 0 && !settings.images) return;

  const migrated = [];
  for (const img of legacyImages) {
    try {
      const base64 = img.imageData.replace(/^data:[^;]+;base64,/, '');
      const item = await processImage(Buffer.from(base64, 'base64'), img.originalName || 'bild');
      migrated.push({
        _id: img._id || new mongoose.Types.ObjectId(),
        kind: item.kind,
        fileId: item.fileId,
        mimeType: item.mimeType,
        size: item.size,
        originalName: img.originalName || 'bild',
        active: img.active !== false,
        createdAt: new Date()
      });
    } catch (error) {
      console.error(`Umkleide-Migration: Bild ${img.originalName} übersprungen –`, error.message);
    }
  }

  // Einträge ohne imageData (bereits im neuen Format) mitnehmen
  const alreadyNew = (settings.images || []).filter((img) => img.fileId);

  await collection.updateOne(
    { _id: settings._id },
    {
      $set: { items: [...alreadyItems, ...alreadyNew, ...migrated] },
      $unset: { images: '' }
    }
  );

  if (migrated.length > 0) {
    console.log(`✅ Umkleide-Migration: ${migrated.length} Bild(er) nach GridFS übernommen`);
  }
};

module.exports = {
  IMAGE_TYPES,
  VIDEO_TYPES,
  isImage,
  isVideo,
  processImage,
  processVideo,
  deleteFile,
  streamToResponse,
  removeTempFile,
  migrateLegacyImages
};

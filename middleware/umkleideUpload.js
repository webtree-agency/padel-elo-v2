const os = require('os');
const multer = require('multer');
const { isImage, isVideo } = require('../utils/umkleideMedia');

// Auf die Platte statt in den RAM – Videos vom Handy sind schnell 100 MB und mehr
const storage = multer.diskStorage({
  destination: os.tmpdir(),
  filename: (req, file, cb) => cb(null, `umkleide-${Date.now()}-${Math.round(Math.random() * 1e9)}`)
});

const fileFilter = (req, file, cb) => {
  if (isImage(file.mimetype) || isVideo(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Nur Bilder (JPEG, PNG, WebP) und Videos (MP4, MOV, WebM) sind erlaubt'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 500 * 1024 * 1024,
    files: 10
  }
});

const handleUploadError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.redirect('/admin/umkleide-display?error=' + encodeURIComponent('Datei ist zu gross (max. 500 MB)'));
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.redirect('/admin/umkleide-display?error=' + encodeURIComponent('Maximal 10 Dateien pro Upload'));
    }
  }
  if (error && error.message && error.message.startsWith('Nur Bilder')) {
    return res.redirect('/admin/umkleide-display?error=' + encodeURIComponent(error.message));
  }
  next(error);
};

module.exports = { upload, handleUploadError };

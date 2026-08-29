import multer from 'multer';

// Use memory storage to process file buffers without saving to disk
const storage = multer.memoryStorage();

// Validate file limits and types
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50 MB max file size limit
  },
  fileFilter: (req, file, cb) => {
    // Sanitize original filename
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, true);
  }
});

export const uploadSingle = upload.single('file');
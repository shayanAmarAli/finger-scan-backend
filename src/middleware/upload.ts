import multer from 'multer';
import type { RequestHandler } from 'express';

import { AppError } from '../lib/errors.js';

/**
 * Accepts exactly one image in the multipart field `image`, kept IN MEMORY
 * only (never written to disk), plus a few small text fields.
 */
export function singleImageUpload(maxBytes: number): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: 5,
      fieldSize: 1024,
      parts: 8,
      headerPairs: 50,
    },
  }).single('image');

  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new AppError(
              413,
              'file_too_large',
              `The image is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
            ),
          );
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
          return next(
            new AppError(400, 'unexpected_file', 'Send exactly one file in the "image" field.'),
          );
        }
        return next(new AppError(400, 'invalid_upload', 'The upload is malformed or too large.'));
      }
      // Malformed multipart bodies (busboy errors).
      return next(new AppError(400, 'invalid_upload', 'The upload is malformed.'));
    });
  };
}

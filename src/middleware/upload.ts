import multer from 'multer';
import type { RequestHandler } from 'express';

import { AppError } from '../lib/errors.js';

/**
 * Accepts one file per named field, kept IN MEMORY only (never written to
 * disk), plus a few small text fields.
 */
export function imageUpload(maxBytes: number, fieldNames: readonly string[]): RequestHandler {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: fieldNames.length,
      fields: 5,
      fieldSize: 1024,
      parts: fieldNames.length + 5,
      headerPairs: 50,
    },
  }).fields(fieldNames.map((name) => ({ name, maxCount: 1 })));

  const expected = fieldNames.map((f) => `"${f}"`).join(' and ');
  return (req, res, next) => {
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(
            new AppError(
              413,
              'file_too_large',
              `Each image must be at most ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
            ),
          );
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
          return next(new AppError(400, 'unexpected_file', `Send exactly one file in each of ${expected}.`));
        }
        return next(new AppError(400, 'invalid_upload', 'The upload is malformed or too large.'));
      }
      return next(new AppError(400, 'invalid_upload', 'The upload is malformed.'));
    });
  };
}

/** The file uploaded in [field], if any. */
export function fileIn(req: { files?: unknown }, field: string): Express.Multer.File | undefined {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  return files?.[field]?.[0];
}

/** Single `image` field (quality check). */
export const singleImageUpload = (maxBytes: number) => imageUpload(maxBytes, ['image']);

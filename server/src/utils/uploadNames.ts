import type multer from 'multer';

/**
 * Multer options for every upload route: read file names as UTF-8, as browsers and Electron send them.
 * Multer's default is Latin-1, which turns 会議.wav into one character per byte. Its types do not list
 * the option yet, hence the cast.
 */
export const utf8FileNames = { defParamCharset: 'utf8' } as multer.Options;

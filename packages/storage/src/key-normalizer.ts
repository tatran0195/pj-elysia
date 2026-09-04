import { normalize } from 'node:path/posix';
import { condenseWhitespace, toUnixSlash } from './utils.js';
import * as errors from './errors.js';

export class KeyNormalizer {
  static allowedCharacterSet = /^[A-Za-z0-9-_!/.\s]*$/;

  #preNormalize(key: string): string {
    const normalizedKey = condenseWhitespace(key);
    return toUnixSlash(normalizedKey)
      .replace(/\/{2,}/g, '/')
      .replace(/\.{3,}\//g, '../');
  }

  #validateCharacterSet(key: string, originalKey: string): void {
    if (!KeyNormalizer.allowedCharacterSet.test(key)) {
      throw new errors.E_UNALLOWED_CHARACTERS([originalKey]);
    }
  }

  #checkForPathTraversal(key: string, originalKey: string): void {
    const tokens = key.split('/');
    for (const token of tokens) {
      if (token === '..') {
        throw new errors.E_PATH_TRAVERSAL_DETECTED([originalKey]);
      }
    }
  }

  #postNormalize(key: string): string {
    const normalizedKey = normalize(key);
    return normalizedKey.replace(/^\/|\/$/g, '').replace(/^\.|\.$/g, '');
  }

  normalize(key: string): string {
    let normalizedKey = this.#preNormalize(key);

    this.#validateCharacterSet(normalizedKey, key);
    this.#checkForPathTraversal(normalizedKey, key);

    normalizedKey = this.#postNormalize(normalizedKey);

    if (normalizedKey.trim() === '') {
      throw new errors.E_INVALID_KEY([key]);
    }

    return normalizedKey;
  }
}

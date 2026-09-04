import etag from 'etag';
import mimeTypes from 'mime-types';
import * as fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { dirname, join, relative } from 'node:path';
import { existsSync, rmSync, createReadStream, type Dirent } from 'node:fs';

import { DriveFile } from '../file.js';
import { DriveDirectory } from '../directory.js';
import { isRangeRequest, validateRangeRequest, validateRangeSatisfiable } from '../range.js';
import type {
  ReadOptions,
  WriteOptions,
  ObjectMetaData,
  DriverContract,
  ObjectVisibility,
  SignedURLOptions,
  StorageStream,
  UploadSignedURLOptions,
} from '../types.js';
import { StorageException } from '../errors.js';
import { toUnixSlash } from '../utils.js';

export type FSDriverOptions = {
  location: URL | string;
  visibility?: ObjectVisibility;
  urlBuilder?: {
    generateURL?(key: string, filePath: string): Promise<string>;
    generateSignedURL?(key: string, filePath: string, options: SignedURLOptions): Promise<string>;
    generateSignedUploadURL?(
      key: string,
      filePath: string,
      options: UploadSignedURLOptions,
    ): Promise<string>;
  };
};

async function retryFs<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if ((code === 'EMFILE' || code === 'ENFILE') && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 25 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return fn();
}

export class FSDriver implements DriverContract {
  #rootUrl: string;

  constructor(public options: FSDriverOptions) {
    this.#rootUrl =
      typeof options.location === 'string' ? options.location : fileURLToPath(options.location);
  }

  #read(key: string): Promise<Buffer> {
    const location = join(this.#rootUrl, key);
    return retryFs(() => fsp.readFile(location));
  }

  async #readDir(location: string, recursive: boolean): Promise<Dirent[]> {
    try {
      return await fsp.readdir(location, {
        recursive,
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return [];
    }
  }

  #write(
    key: string,
    contents: string | Readable | Uint8Array,
    options?: { signal?: AbortSignal },
  ) {
    const location = join(this.#rootUrl, key);
    return retryFs(async () => {
      await fsp.mkdir(dirname(location), { recursive: true });
      await fsp.writeFile(location, contents, options);
    });
  }

  async #createReadStream(key: string, options?: ReadOptions): Promise<Readable> {
    const location = join(this.#rootUrl, key);
    if (isRangeRequest(options?.range)) {
      validateRangeRequest(key, options.range);
      const { size } = await fsp.stat(location);
      validateRangeSatisfiable(key, options.range, size);
    }
    return createReadStream(location, options?.range);
  }

  existsSync(key: string): boolean {
    const location = join(this.#rootUrl, key);
    return existsSync(location);
  }

  async exists(key: string): Promise<boolean> {
    const location = join(this.#rootUrl, key);
    try {
      const object = await fsp.stat(location);
      return object.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async get(key: string): Promise<string> {
    const buf = await this.#read(key);
    return buf.toString('utf-8');
  }

  async readStream(key: string): Promise<StorageStream> {
    const meta = await this.getMetaData(key);
    const stream = await this.getStream(key);
    return {
      body: Readable.toWeb(stream) as ReadableStream,
      contentType: meta.contentType || 'application/octet-stream',
      contentLength: meta.contentLength,
      etag: meta.etag,
    };
  }

  async getStream(key: string, options?: ReadOptions): Promise<Readable> {
    return this.#createReadStream(key, options);
  }

  async getBytes(key: string, options?: ReadOptions): Promise<Uint8Array> {
    if (isRangeRequest(options?.range)) {
      const stream = await this.#createReadStream(key, options);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return new Uint8Array(Buffer.concat(chunks));
    }
    const buf = await this.#read(key);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async getMetaData(key: string): Promise<ObjectMetaData> {
    const location = join(this.#rootUrl, key);
    const stats = await fsp.stat(location);

    if (stats.isDirectory()) {
      throw new StorageException(
        `Cannot get metadata of a directory "${key}"`,
        'E_CANNOT_GET_METADATA',
      );
    }

    return {
      contentLength: stats.size,
      contentType: (mimeTypes.lookup(key) || undefined) as string | undefined,
      etag: etag(stats),
      lastModified: stats.mtime,
    };
  }

  async getVisibility(_: string): Promise<ObjectVisibility> {
    return this.options.visibility || 'private';
  }

  async getUrl(key: string): Promise<string> {
    const location = join(this.#rootUrl, key);
    const generateURL = this.options.urlBuilder?.generateURL;
    if (generateURL) {
      return generateURL(key, location);
    }
    throw new StorageException(
      'Cannot generate URL. The "fs" driver does not support it',
      'E_CANNOT_GENERATE_URL',
    );
  }

  async getSignedUrl(key: string, options?: SignedURLOptions): Promise<string> {
    const location = join(this.#rootUrl, key);
    const normalizedOptions = Object.assign({ expiresIn: '30 mins' }, options);
    const generateSignedURL = this.options.urlBuilder?.generateSignedURL;
    if (generateSignedURL) {
      return generateSignedURL(key, location, normalizedOptions);
    }
    throw new StorageException(
      'Cannot generate signed URL. The "fs" driver does not support it',
      'E_CANNOT_GENERATE_URL',
    );
  }

  async getSignedUploadUrl(key: string, options?: UploadSignedURLOptions): Promise<string> {
    const location = join(this.#rootUrl, key);
    const normalizedOptions = Object.assign({ expiresIn: '30 mins' }, options);
    const generateSignedUploadURL = this.options.urlBuilder?.generateSignedUploadURL;
    if (generateSignedUploadURL) {
      return generateSignedUploadURL(key, location, normalizedOptions);
    }
    throw new StorageException(
      'Cannot generate signed upload URL. The "fs" driver does not support it',
      'E_CANNOT_GENERATE_URL',
    );
  }

  async setVisibility(_: string, __: ObjectVisibility): Promise<void> {}

  put(key: string, contents: string | Uint8Array, options?: WriteOptions): Promise<void> {
    return this.#write(key, contents, { signal: options?.signal as AbortSignal | undefined });
  }

  putStream(key: string, contents: Readable, options?: WriteOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      contents.once('error', reject);
      this.#write(key, contents, { signal: options?.signal as AbortSignal | undefined })
        .then(resolve)
        .catch(reject);
    });
  }

  copy(source: string, destination: string): Promise<void> {
    const sourceLocation = join(this.#rootUrl, source);
    const destinationLocation = join(this.#rootUrl, destination);

    return retryFs(async () => {
      await fsp.mkdir(dirname(destinationLocation), { recursive: true });
      await fsp.copyFile(sourceLocation, destinationLocation);
    });
  }

  move(source: string, destination: string): Promise<void> {
    const sourceLocation = join(this.#rootUrl, source);
    const destinationLocation = join(this.#rootUrl, destination);

    return retryFs(async () => {
      await fsp.mkdir(dirname(destinationLocation), { recursive: true });
      await fsp.copyFile(sourceLocation, destinationLocation);
      await fsp.unlink(sourceLocation);
    });
  }

  delete(key: string): Promise<void> {
    const location = join(this.#rootUrl, key);

    return retryFs(async () => {
      try {
        await fsp.unlink(location);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    });
  }

  deleteAll(prefix: string): Promise<void> {
    const location = join(this.#rootUrl, prefix);

    return retryFs(async () => {
      await fsp.rm(location, { recursive: true, force: true });
    });
  }

  clearSync(): void {
    rmSync(this.#rootUrl, { recursive: true, force: true });
  }

  async listAll(
    prefix: string,
    options?: {
      recursive?: boolean;
      paginationToken?: string;
    },
  ): Promise<{
    paginationToken?: string;
    objects: Iterable<DriveFile | DriveDirectory>;
  }> {
    const location = join(this.#rootUrl, prefix);
    const recursive = options?.recursive ?? false;
    const files = await this.#readDir(location, recursive);

    function* filesGenerator(driver: FSDriver): Iterator<DriveFile | DriveDirectory> {
      for (const file of files) {
        const parent = file.parentPath ?? ('path' in file ? (file as { path: string }).path : '');
        const relativeName = toUnixSlash(relative(driver.#rootUrl, join(parent, file.name)));
        if (file.isFile()) {
          yield new DriveFile(relativeName, driver);
        } else if (!recursive) {
          yield new DriveDirectory(relativeName);
        }
      }
    }

    return {
      paginationToken: undefined,
      objects: {
        [Symbol.iterator]: () => filesGenerator(this),
      },
    };
  }

  bucket(_bucket: string): FSDriver {
    throw new StorageException(
      'Cannot switch bucket. The "fs" driver does not support it.',
      'E_CANNOT_SWITCH_BUCKET',
    );
  }
}

import { unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import * as errors from './errors.js';
import { DriveFile } from './file.js';
import { KeyNormalizer } from './key-normalizer.js';
import { type DriveDirectory } from './directory.js';
import type {
  ReadOptions,
  WriteOptions,
  FileSnapshot,
  ObjectMetaData,
  DriverContract,
  ObjectVisibility,
  SignedURLOptions,
  StorageStream,
  UploadSignedURLOptions,
  CopyMoveOptions,
} from './types.js';

export class Disk {
  #normalizer = new KeyNormalizer();

  constructor(public driver: DriverContract) {}

  file(key: string): DriveFile {
    return new DriveFile(key, this.driver);
  }

  fromSnapshot(snapshot: FileSnapshot): DriveFile {
    return new DriveFile(snapshot.key, this.driver, {
      contentLength: snapshot.contentLength,
      etag: snapshot.etag,
      lastModified: new Date(snapshot.lastModified),
      contentType: snapshot.contentType,
    });
  }

  exists(key: string): Promise<boolean> {
    return this.file(key).exists();
  }

  get(key: string): Promise<string> {
    return this.file(key).get();
  }

  getStream(key: string, options?: ReadOptions): Promise<Readable> {
    return this.file(key).getStream(options);
  }

  async readStream(key: string): Promise<StorageStream> {
    key = this.#normalizer.normalize(key);
    try {
      if (
        'readStream' in this.driver &&
        typeof (this.driver as { readStream: unknown }).readStream === 'function'
      ) {
        return await (
          this.driver as { readStream: (k: string) => Promise<StorageStream> }
        ).readStream(key);
      }
      const meta = await this.driver.getMetaData(key);
      const stream = await this.driver.getStream(key);
      return {
        body: Readable.toWeb(stream) as ReadableStream,
        contentType: meta.contentType || 'application/octet-stream',
        contentLength: meta.contentLength,
        etag: meta.etag,
      };
    } catch (error) {
      throw new errors.E_CANNOT_READ_FILE([key], { cause: error });
    }
  }

  getBytes(key: string, options?: ReadOptions): Promise<Uint8Array> {
    return this.file(key).getBytes(options);
  }

  getMetaData(key: string): Promise<ObjectMetaData> {
    return this.file(key).getMetaData();
  }

  getVisibility(key: string): Promise<ObjectVisibility> {
    return this.file(key).getVisibility();
  }

  getUrl(key: string): Promise<string> {
    return this.file(key).getUrl();
  }

  getSignedUrl(key: string, options?: SignedURLOptions): Promise<string> {
    return this.file(key).getSignedUrl(options);
  }

  getSignedUploadUrl(key: string, options?: UploadSignedURLOptions): Promise<string> {
    return this.file(key).getSignedUploadUrl(options);
  }

  async setVisibility(key: string, visibility: ObjectVisibility): Promise<void> {
    key = this.#normalizer.normalize(key);
    try {
      return await this.driver.setVisibility(key, visibility);
    } catch (error) {
      throw new errors.E_CANNOT_SET_VISIBILITY([key], { cause: error });
    }
  }

  async put(key: string, contents: string | Uint8Array, options?: WriteOptions): Promise<void> {
    key = this.#normalizer.normalize(key);
    try {
      return await this.driver.put(key, contents, options);
    } catch (error) {
      throw new errors.E_CANNOT_WRITE_FILE([key], { cause: error });
    }
  }

  async putStream(key: string, contents: Readable, options?: WriteOptions): Promise<void> {
    key = this.#normalizer.normalize(key);
    try {
      return await this.driver.putStream(key, contents, options);
    } catch (error) {
      throw new errors.E_CANNOT_WRITE_FILE([key], { cause: error });
    }
  }

  async copy(source: string, destination: string, options?: CopyMoveOptions): Promise<void> {
    source = this.#normalizer.normalize(source);
    destination = this.#normalizer.normalize(destination);
    try {
      return await this.driver.copy(source, destination, options);
    } catch (error) {
      throw new errors.E_CANNOT_COPY_FILE([source, destination], { cause: error });
    }
  }

  copyFromFs(source: string | URL, destination: string, options?: WriteOptions) {
    return this.putStream(destination, createReadStream(source), options);
  }

  async move(source: string, destination: string, options?: CopyMoveOptions): Promise<void> {
    source = this.#normalizer.normalize(source);
    destination = this.#normalizer.normalize(destination);
    try {
      return await this.driver.move(source, destination, options);
    } catch (error) {
      throw new errors.E_CANNOT_MOVE_FILE([source, destination], { cause: error });
    }
  }

  async moveFromFs(
    source: string | URL,
    destination: string,
    options?: WriteOptions,
  ): Promise<void> {
    await this.putStream(destination, createReadStream(source), options);
    await unlink(source);
  }

  async delete(key: string): Promise<void> {
    key = this.#normalizer.normalize(key);
    try {
      return await this.driver.delete(key);
    } catch (error) {
      throw new errors.E_CANNOT_DELETE_FILE([key], { cause: error });
    }
  }

  async deleteAll(prefix?: string): Promise<void> {
    prefix = prefix && prefix !== '/' ? this.#normalizer.normalize(prefix) : '/';
    try {
      return await this.driver.deleteAll(prefix);
    } catch (error) {
      throw new errors.E_CANNOT_DELETE_DIRECTORY([prefix], { cause: error });
    }
  }

  listAll(
    prefix?: string,
    options?: {
      recursive?: boolean;
      paginationToken?: string;
    },
  ): Promise<{
    paginationToken?: string;
    objects: Iterable<DriveFile | DriveDirectory>;
  }> {
    prefix = prefix && prefix !== '/' ? this.#normalizer.normalize(prefix) : '/';
    return this.driver.listAll(prefix, options);
  }
}

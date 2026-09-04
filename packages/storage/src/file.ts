import { basename } from 'node:path';
import { type Readable } from 'node:stream';
import * as errors from './errors.js';
import { KeyNormalizer } from './key-normalizer.js';
import type {
  ReadOptions,
  DriverContract,
  FileSnapshot,
  ObjectMetaData,
  ObjectVisibility,
  SignedURLOptions,
  UploadSignedURLOptions,
} from './types.js';

export class DriveFile {
  #driver: DriverContract;
  #metaData?: ObjectMetaData;
  #normalizer = new KeyNormalizer();

  key: string;
  name: string;
  isFile = true;
  isDirectory = false;

  constructor(key: string, driver: DriverContract, metaData?: ObjectMetaData) {
    this.#driver = driver;
    this.#metaData = metaData;
    this.key = this.#normalizer.normalize(key);
    this.name = basename(this.key);
  }

  async exists(): Promise<boolean> {
    try {
      return await this.#driver.exists(this.key);
    } catch (error) {
      throw new errors.E_CANNOT_CHECK_FILE_EXISTENCE([this.key], { cause: error });
    }
  }

  async get(): Promise<string> {
    try {
      return await this.#driver.get(this.key);
    } catch (error) {
      throw new errors.E_CANNOT_READ_FILE([this.key], { cause: error });
    }
  }

  async getStream(options?: ReadOptions): Promise<Readable> {
    try {
      return await this.#driver.getStream(this.key, options);
    } catch (error) {
      throw new errors.E_CANNOT_READ_FILE([this.key], { cause: error });
    }
  }

  async getBytes(options?: ReadOptions): Promise<Uint8Array> {
    try {
      return await this.#driver.getBytes(this.key, options);
    } catch (error) {
      throw new errors.E_CANNOT_READ_FILE([this.key], { cause: error });
    }
  }

  async getMetaData(): Promise<ObjectMetaData> {
    if (this.#metaData) {
      return this.#metaData;
    }

    try {
      return await this.#driver.getMetaData(this.key);
    } catch (error) {
      throw new errors.E_CANNOT_GET_METADATA([this.key], { cause: error });
    }
  }

  async getVisibility(): Promise<ObjectVisibility> {
    try {
      return await this.#driver.getVisibility(this.key);
    } catch (error) {
      throw new errors.E_CANNOT_GET_METADATA([this.key], { cause: error });
    }
  }

  async getUrl(): Promise<string> {
    try {
      return await this.#driver.getUrl(this.key);
    } catch (error) {
      throw new errors.E_CANNOT_GENERATE_URL([this.key], { cause: error });
    }
  }

  async getSignedUrl(options?: SignedURLOptions): Promise<string> {
    try {
      return await this.#driver.getSignedUrl(this.key, options);
    } catch (error) {
      throw new errors.E_CANNOT_GENERATE_URL([this.key], { cause: error });
    }
  }

  async getSignedUploadUrl(options?: UploadSignedURLOptions): Promise<string> {
    try {
      return await this.#driver.getSignedUploadUrl(this.key, options);
    } catch (error) {
      throw new errors.E_CANNOT_GENERATE_URL([this.key], { cause: error });
    }
  }

  async toSnapshot(): Promise<FileSnapshot> {
    const metaData = await this.getMetaData();

    return {
      key: this.key,
      name: this.name,
      contentLength: metaData.contentLength,
      lastModified: metaData.lastModified.toString(),
      etag: metaData.etag,
      contentType: metaData.contentType,
    };
  }
}

export { DriveFile as StorageFile };

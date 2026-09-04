import { type Readable } from 'node:stream';
import { type DriveFile } from './file.js';
import { type DriveDirectory } from './directory.js';

export type ObjectVisibility = 'public' | 'private';

export type ObjectMetaData = {
  contentType?: string;
  contentLength: number;
  etag: string;
  lastModified: Date;
};

export type StorageStream = {
  body: ReadableStream;
  contentType: string;
  contentLength?: number;
  etag?: string;
};

export type WriteOptions = {
  visibility?: ObjectVisibility;
  contentType?: string;
  contentLanguage?: string;
  contentEncoding?: string;
  contentDisposition?: string;
  cacheControl?: string;
  contentLength?: number;
} & Record<string, unknown>;

export type CopyMoveOptions = WriteOptions & {
  destinationBucket?: string;
};

export type SignedURLOptions = {
  expiresIn?: string | number;
  contentType?: string;
  contentDisposition?: string;
} & Record<string, unknown>;

export type UploadSignedURLOptions = {
  expiresIn?: string | number;
  contentType?: string;
  contentSize?: number;
} & Record<string, unknown>;

export type RangeRequest = {
  start?: number;
  end?: number;
};

export type ReadOptions = {
  range?: RangeRequest;
};

export type FileSnapshot = {
  key: string;
  name: string;
  contentLength: number;
  lastModified: string;
  etag: string;
  contentType?: string;
};

export interface DriverContract {
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<string>;
  getStream(key: string, options?: ReadOptions): Promise<Readable>;
  getBytes(key: string, options?: ReadOptions): Promise<Uint8Array>;
  getMetaData(key: string): Promise<ObjectMetaData>;
  getVisibility(key: string): Promise<ObjectVisibility>;
  getUrl(key: string): Promise<string>;
  getSignedUrl(key: string, options?: SignedURLOptions): Promise<string>;
  getSignedUploadUrl(key: string, options?: SignedURLOptions): Promise<string>;
  setVisibility(key: string, visibility: ObjectVisibility): Promise<void>;
  put(key: string, contents: string | Uint8Array, options?: WriteOptions): Promise<void>;
  putStream(key: string, contents: Readable, options?: WriteOptions): Promise<void>;
  copy(source: string, destination: string, options?: CopyMoveOptions): Promise<void>;
  move(source: string, destination: string, options?: CopyMoveOptions): Promise<void>;
  delete(key: string): Promise<void>;
  deleteAll(prefix: string): Promise<void>;
  listAll(
    prefix: string,
    options?: {
      recursive?: boolean;
      paginationToken?: string;
    },
  ): Promise<{
    paginationToken?: string;
    objects: Iterable<DriveFile | DriveDirectory>;
  }>;
  bucket(bucket: string): DriverContract;
}

export interface DriveManagerOptions<Services extends Record<string, () => DriverContract>> {
  default: keyof Services;
  services: Services;
  fakes?: {
    location: URL | string;
    urlBuilder?: {
      generateURL?(key: string, filePath: string): Promise<string>;
      generateSignedURL?(key: string, filePath: string, options: SignedURLOptions): Promise<string>;
    };
  };
}

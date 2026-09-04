import {
  S3Client,
  type S3ClientConfig,
  type ServerSideEncryption,
  HeadObjectCommand,
  type HeadObjectCommandInput,
  type HeadObjectCommandOutput,
  GetObjectCommand,
  type GetObjectCommandInput,
  GetObjectAclCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  PutObjectAclCommand,
  CopyObjectCommand,
  type CopyObjectCommandInput,
  DeleteObjectCommand,
  type DeleteObjectCommandInput,
  DeleteObjectsCommand,
  type DeleteObjectsCommandInput,
  ListObjectsV2Command,
  type _Object,
} from '@aws-sdk/client-s3';
import { type Readable } from 'node:stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
  CopyMoveOptions,
} from '../types.js';
import { parseDurationToSeconds } from '../utils.js';

export type S3DriverBaseOptions = {
  bucket: string;
  visibility?: ObjectVisibility;
  supportsACL?: boolean;
  cdnUrl?: string;
  urlBuilder?: {
    generateURL?(key: string, bucket: string, client: S3Client): Promise<string>;
    generateSignedURL?(
      key: string,
      options: GetObjectCommandInput,
      client: S3Client,
      expiresIn?: number | string,
    ): Promise<string>;
    generateSignedUploadURL?(
      key: string,
      options: PutObjectCommandInput,
      client: S3Client,
      expiresIn?: number | string,
    ): Promise<string>;
  };
  encryption?: ServerSideEncryption;
};

export type S3DriverOptions =
  (S3ClientConfig & S3DriverBaseOptions) | ({ client: S3Client } & S3DriverBaseOptions);

export class S3Driver implements DriverContract {
  #client: S3Client;
  #supportsACL: boolean;
  publicGrantUri = 'http://acs.amazonaws.com/groups/global/AllUsers';

  constructor(public options: S3DriverOptions) {
    this.#supportsACL = options.supportsACL ?? true;
    if ('client' in options) {
      this.#client = options.client;
    } else {
      this.#client = new S3Client(options);
    }
  }

  #createFileMetaData(response: HeadObjectCommandOutput | _Object): ObjectMetaData {
    const contentLength =
      'ContentLength' in response && response.ContentLength !== undefined
        ? response.ContentLength
        : 'Size' in response && response.Size !== undefined
          ? response.Size
          : 0;

    return {
      contentLength,
      lastModified: response.LastModified ?? new Date(),
      etag: response.ETag ?? '',
      contentType: 'ContentType' in response ? response.ContentType : undefined,
    };
  }

  #getSaveOptions(key: string, options?: WriteOptions): Omit<PutObjectCommandInput, 'Body'> {
    const defaultOptions: Omit<PutObjectCommandInput, 'Key' | 'Body'> = {
      Bucket: this.options.bucket,
    };

    if (this.options.encryption) {
      defaultOptions.ServerSideEncryption = this.options.encryption;
    }

    const { visibility, ...rest } = Object.assign(defaultOptions, options);

    if (visibility && this.#supportsACL) {
      rest.ACL = visibility === 'public' ? 'public-read' : 'private';
    }

    return {
      Key: key,
      ...rest,
    };
  }

  async #deleteFilesRecursively(prefix: string): Promise<void> {
    const searchPrefix = prefix && prefix !== '/' ? prefix.replace(/\/$/, '') + '/' : '';

    let nextToken: string | undefined;
    do {
      const response = await this.#client.send(
        this.createListObjectsV2Command(this.#client, {
          Bucket: this.options.bucket,
          ContinuationToken: nextToken,
          ...(searchPrefix ? { Prefix: searchPrefix } : {}),
        }),
      );

      nextToken = response.NextContinuationToken;

      const objectsToDelete = (response.Contents || [])
        .map((file) => ({ Key: file.Key! }))
        .filter((file) => Boolean(file.Key));

      if (objectsToDelete.length > 0) {
        await this.#client.send(
          this.createDeleteObjectsCommand(this.#client, {
            Bucket: this.options.bucket,
            Delete: {
              Objects: objectsToDelete,
            },
          }),
        );
      }
    } while (nextToken);
  }

  createHeadObjectCommand(_: S3Client, options: HeadObjectCommandInput) {
    return new HeadObjectCommand(options);
  }

  createGetObjectCommand(_: S3Client, options: GetObjectCommandInput) {
    return new GetObjectCommand(options);
  }

  createGetObjectAclCommand(_: S3Client, options: { Bucket: string; Key: string }) {
    return new GetObjectAclCommand(options);
  }

  createPutObjectCommand(_: S3Client, options: PutObjectCommandInput) {
    return new PutObjectCommand(options);
  }

  createPutObjectAclCommand(
    _: S3Client,
    options: { Bucket: string; Key: string; ACL?: 'public-read' | 'private' },
  ) {
    return new PutObjectAclCommand(options);
  }

  createCopyObjectCommand(_: S3Client, options: CopyObjectCommandInput) {
    return new CopyObjectCommand(options);
  }

  createListObjectsV2Command(
    _: S3Client,
    options: {
      Bucket: string;
      Delimiter?: string;
      ContinuationToken?: string;
      Prefix?: string;
      MaxKeys?: number;
    },
  ) {
    return new ListObjectsV2Command(options);
  }

  createDeleteObjectCommand(_: S3Client, options: DeleteObjectCommandInput) {
    return new DeleteObjectCommand(options);
  }

  createDeleteObjectsCommand(_: S3Client, options: DeleteObjectsCommandInput) {
    return new DeleteObjectsCommand(options);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const response = await this.#client.send(
        this.createHeadObjectCommand(this.#client, {
          Key: key,
          Bucket: this.options.bucket,
        }),
      );
      return response.$metadata.httpStatusCode === 200;
    } catch (error: unknown) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
      ) {
        return false;
      }
      throw error;
    }
  }

  async get(key: string): Promise<string> {
    const response = await this.#client.send(
      this.createGetObjectCommand(this.#client, {
        Key: key,
        Bucket: this.options.bucket,
      }),
    );
    return response.Body!.transformToString();
  }

  async #getObject(key: string, options?: ReadOptions) {
    let rangeHeader = {};
    if (isRangeRequest(options?.range)) {
      validateRangeRequest(key, options.range);
      const head = await this.#client.send(
        this.createHeadObjectCommand(this.#client, { Key: key, Bucket: this.options.bucket }),
      );
      validateRangeSatisfiable(key, options.range, head.ContentLength!);
      rangeHeader = { Range: `bytes=${options.range.start ?? 0}-${options.range.end ?? ''}` };
    }
    return this.#client.send(
      this.createGetObjectCommand(this.#client, {
        Key: key,
        Bucket: this.options.bucket,
        ...rangeHeader,
      }),
    );
  }

  async readStream(key: string): Promise<StorageStream> {
    const res = await this.#client.send(
      this.createGetObjectCommand(this.#client, {
        Key: key,
        Bucket: this.options.bucket,
      }),
    );
    if (!res.Body) throw new Error(`Object '${key}' has no body`);
    const body = (
      res.Body as { transformToWebStream: () => ReadableStream }
    ).transformToWebStream();
    return {
      body,
      contentType: res.ContentType || 'application/octet-stream',
      contentLength: res.ContentLength,
      etag: res.ETag,
    };
  }

  async getStream(key: string, options?: ReadOptions): Promise<Readable> {
    const { Body } = await this.#getObject(key, options);
    return Body as unknown as Readable;
  }

  async getBytes(key: string, options?: ReadOptions): Promise<Uint8Array> {
    const { Body } = await this.#getObject(key, options);
    return Body!.transformToByteArray();
  }

  async getMetaData(key: string): Promise<ObjectMetaData> {
    const response = await this.#client.send(
      this.createHeadObjectCommand(this.#client, {
        Key: key,
        Bucket: this.options.bucket,
      }),
    );
    return this.#createFileMetaData(response);
  }

  async getVisibility(key: string): Promise<ObjectVisibility> {
    if (!this.#supportsACL) {
      return this.options.visibility || 'private';
    }

    const response = await this.#client.send(
      this.createGetObjectAclCommand(this.#client, {
        Key: key,
        Bucket: this.options.bucket,
      }),
    );

    const isPublic = (response.Grants || []).some((grant) => {
      return (
        grant.Grantee?.URI === this.publicGrantUri &&
        (grant.Permission === 'READ' || grant.Permission === 'FULL_CONTROL')
      );
    });

    return isPublic ? 'public' : 'private';
  }

  async getUrl(key: string): Promise<string> {
    const generateURL = this.options.urlBuilder?.generateURL;
    if (generateURL) {
      return generateURL(key, this.options.bucket, this.#client);
    }

    if (this.options.cdnUrl) {
      return new URL(key, this.options.cdnUrl).toString();
    }

    if (this.#client.config.endpoint) {
      const endpoint = await this.#client.config.endpoint();
      let baseUrl = `${endpoint.protocol}//${endpoint.hostname}`;
      if (endpoint.port) {
        baseUrl += `:${endpoint.port}`;
      }
      return new URL(`/${this.options.bucket}/${key}`, baseUrl).toString();
    }

    return new URL(`/${key}`, `https://${this.options.bucket}.s3.amazonaws.com`).toString();
  }

  async getSignedUrl(key: string, options?: SignedURLOptions): Promise<string> {
    const { contentDisposition, contentType, expiresIn, ...rest } = Object.assign({}, options);
    const expires = parseDurationToSeconds(expiresIn || '30mins');

    const signedURLOptions: GetObjectCommandInput = {
      Key: key,
      Bucket: this.options.bucket,
      ResponseContentType: contentType,
      ResponseContentDisposition: contentDisposition,
      ...rest,
    };

    const generateSignedURL = this.options.urlBuilder?.generateSignedURL;
    if (generateSignedURL) {
      return generateSignedURL(key, signedURLOptions, this.#client, expiresIn);
    }

    return getSignedUrl(
      this.#client as unknown as Parameters<typeof getSignedUrl>[0],
      this.createGetObjectCommand(this.#client, signedURLOptions) as unknown as Parameters<
        typeof getSignedUrl
      >[1],
      { expiresIn: expires },
    );
  }

  async getSignedUploadUrl(key: string, options?: UploadSignedURLOptions): Promise<string> {
    const { contentType, expiresIn, ...rest } = Object.assign({}, options);
    const expires = parseDurationToSeconds(expiresIn || '30mins');

    const signedURLOptions: PutObjectCommandInput = {
      Key: key,
      Bucket: this.options.bucket,
      ContentType: contentType,
      ...rest,
    };

    const generateSignedUploadURL = this.options.urlBuilder?.generateSignedUploadURL;
    if (generateSignedUploadURL) {
      return generateSignedUploadURL(key, signedURLOptions, this.#client, expiresIn);
    }

    return getSignedUrl(
      this.#client as unknown as Parameters<typeof getSignedUrl>[0],
      this.createPutObjectCommand(this.#client, signedURLOptions) as unknown as Parameters<
        typeof getSignedUrl
      >[1],
      { expiresIn: expires },
    );
  }

  async setVisibility(key: string, visibility: ObjectVisibility): Promise<void> {
    if (!this.#supportsACL) {
      return;
    }

    await this.#client.send(
      this.createPutObjectAclCommand(this.#client, {
        Key: key,
        Bucket: this.options.bucket,
        ACL: visibility === 'public' ? 'public-read' : 'private',
      }),
    );
  }

  async put(key: string, contents: string | Uint8Array, options?: WriteOptions): Promise<void> {
    const command = this.createPutObjectCommand(this.#client, {
      ...this.#getSaveOptions(key, options),
      Key: key,
      Body: contents,
    });
    await this.#client.send(command);
  }

  putStream(key: string, contents: Readable, options?: WriteOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      contents.once('error', reject);
      try {
        const command = this.createPutObjectCommand(this.#client, {
          ...this.#getSaveOptions(key, options),
          Key: key,
          Body: contents,
        });
        this.#client
          .send(command)
          .then(() => resolve())
          .catch(reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  async copy(source: string, destination: string, options?: CopyMoveOptions): Promise<void> {
    const { destinationBucket, ...writeOptions } = options || {};
    const targetBucket = destinationBucket || this.options.bucket;

    if (!writeOptions.visibility && this.#supportsACL) {
      writeOptions.visibility = await this.getVisibility(source);
    }

    await this.#client.send(
      this.createCopyObjectCommand(this.#client, {
        ...this.#getSaveOptions(destination, writeOptions),
        Key: destination,
        CopySource: `/${this.options.bucket}/${source}`,
        Bucket: targetBucket,
      }),
    );
  }

  async move(source: string, destination: string, options?: CopyMoveOptions): Promise<void> {
    await this.copy(source, destination, options);
    await this.delete(source);
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(
      this.createDeleteObjectCommand(this.#client, {
        Key: key,
        Bucket: this.options.bucket,
      }),
    );
  }

  async deleteAll(prefix: string): Promise<void> {
    await this.#deleteFilesRecursively(prefix);
  }

  async listAll(
    prefix: string,
    options?: {
      recursive?: boolean;
      paginationToken?: string;
      maxResults?: number;
    },
  ): Promise<{
    paginationToken?: string;
    objects: Iterable<DriveFile | DriveDirectory>;
  }> {
    const recursive = options?.recursive ?? false;
    const paginationToken = options?.paginationToken;
    const maxResults = options?.maxResults;

    let searchPrefix = prefix;
    if (searchPrefix) {
      searchPrefix = !recursive ? `${searchPrefix.replace(/\/$/, '')}/` : searchPrefix;
    }

    const response = await this.#client.send(
      this.createListObjectsV2Command(this.#client, {
        Bucket: this.options.bucket,
        Delimiter: !recursive ? '/' : '',
        ContinuationToken: paginationToken,
        ...(searchPrefix !== '/' ? { Prefix: searchPrefix } : {}),
        ...(maxResults !== undefined ? { MaxKeys: maxResults } : {}),
      }),
    );

    function* filesGenerator(driver: S3Driver): Iterator<DriveFile | DriveDirectory> {
      if (response.CommonPrefixes) {
        for (const directory of response.CommonPrefixes) {
          yield new DriveDirectory(directory.Prefix!.replace(/\/$/, ''));
        }
      }
      if (response.Contents) {
        for (const file of response.Contents) {
          yield new DriveFile(file.Key!, driver, driver.#createFileMetaData(file));
        }
      }
    }

    return {
      paginationToken: response.NextContinuationToken,
      objects: {
        [Symbol.iterator]: () => filesGenerator(this),
      },
    };
  }

  bucket(bucket: string): S3Driver {
    return new S3Driver({ ...this.options, bucket });
  }
}

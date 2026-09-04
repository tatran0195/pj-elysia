import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Disk,
  FSDriver,
  KeyNormalizer,
  DriveManager,
  E_UNALLOWED_CHARACTERS,
  E_PATH_TRAVERSAL_DETECTED,
  E_INVALID_KEY,
} from '../index.js';

describe('KeyNormalizer', () => {
  const normalizer = new KeyNormalizer();

  it('normalizes slashes and whitespace', () => {
    expect(normalizer.normalize('hello   world')).toBe('hello world');
    expect(normalizer.normalize('foo//bar//baz')).toBe('foo/bar/baz');
    expect(normalizer.normalize('foo\\bar\\baz.txt')).toBe('foo/bar/baz.txt');
  });

  it('throws on unallowed characters', () => {
    expect(() => normalizer.normalize('foo/bar?baz')).toThrow(E_UNALLOWED_CHARACTERS);
    expect(() => normalizer.normalize('foo/bar#baz')).toThrow(E_UNALLOWED_CHARACTERS);
  });

  it('throws on path traversal', () => {
    expect(() => normalizer.normalize('foo/../bar')).toThrow(E_PATH_TRAVERSAL_DETECTED);
    expect(() => normalizer.normalize('../foo')).toThrow(E_PATH_TRAVERSAL_DETECTED);
  });

  it('throws on empty normalized key', () => {
    expect(() => normalizer.normalize('/')).toThrow(E_INVALID_KEY);
    expect(() => normalizer.normalize('///')).toThrow(E_INVALID_KEY);
  });
});

describe('Disk with FSDriver', () => {
  let tempDir: string;
  let disk: Disk;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'test-'));
    disk = new Disk(new FSDriver({ location: tempDir }));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes and reads string content', async () => {
    await disk.put('test.txt', 'hello world', { contentType: 'text/plain' });
    expect(await disk.exists('test.txt')).toBe(true);
    expect(await disk.get('test.txt')).toBe('hello world');
  });

  it('writes and reads binary bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await disk.put('binary.bin', bytes);
    const read = await disk.getBytes('binary.bin');
    expect(Array.from(read)).toEqual([1, 2, 3, 4, 5]);
  });

  it('gets metadata with content type and length', async () => {
    await disk.put('doc.json', JSON.stringify({ a: 1 }));
    const meta = await disk.getMetaData('doc.json');
    expect(meta.contentLength).toBeGreaterThan(0);
    expect(meta.contentType).toBe('application/json');
  });

  it('copies and moves files', async () => {
    await disk.put('original.txt', 'copy me');
    await disk.copy('original.txt', 'copied.txt');
    expect(await disk.exists('original.txt')).toBe(true);
    expect(await disk.get('copied.txt')).toBe('copy me');

    await disk.move('copied.txt', 'moved.txt');
    expect(await disk.exists('copied.txt')).toBe(false);
    expect(await disk.get('moved.txt')).toBe('copy me');
  });

  it('deletes files and directories', async () => {
    await disk.put('dir/file1.txt', '1');
    await disk.put('dir/file2.txt', '2');
    expect(await disk.exists('dir/file1.txt')).toBe(true);

    await disk.delete('dir/file1.txt');
    expect(await disk.exists('dir/file1.txt')).toBe(false);

    await disk.deleteAll('dir');
    expect(await disk.exists('dir/file2.txt')).toBe(false);
  });
});

describe('DriveManager with fakes', () => {
  it('manages disks and fakes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mgr-'));
    const manager = new DriveManager({
      default: 'local',
      services: {
        local: () => new FSDriver({ location: tempDir }),
      },
      fakes: {
        location: join(tempDir, 'fakes'),
      },
    });

    const localDisk = manager.use('local');
    await localDisk.put('foo.txt', 'bar');
    expect(await localDisk.get('foo.txt')).toBe('bar');

    const fake = manager.fake('local');
    await fake.put('fake.txt', 'fake content');
    fake.assertExists('fake.txt');
    fake.assertMissing('missing.txt');

    manager.restore('local');
    await rm(tempDir, { recursive: true, force: true });
  });
});

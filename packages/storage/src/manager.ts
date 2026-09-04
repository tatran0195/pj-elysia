import { Disk } from './disk.js';
import { FakeDisk } from './fake-disk.js';
import { type DriveManagerOptions, type DriverContract } from './types.js';
import { StorageException } from './errors.js';

export class DriveManager<Services extends Record<string, () => DriverContract>> {
  #config: DriveManagerOptions<Services>;
  #cachedServices: Map<keyof Services, Disk> = new Map();
  #fakes: Map<keyof Services, FakeDisk> = new Map();

  constructor(config: DriveManagerOptions<Services>) {
    this.#config = config;
  }

  use<K extends keyof Services>(service?: K): Disk {
    const serviceToUse = service || this.#config.default;

    const fake = this.#fakes.get(serviceToUse);
    if (fake) {
      return fake;
    }

    const cachedDisk = this.#cachedServices.get(serviceToUse);
    if (cachedDisk) {
      return cachedDisk;
    }

    const disk = new Disk(this.#config.services[serviceToUse]());
    this.#cachedServices.set(serviceToUse, disk);
    return disk;
  }

  fake<K extends keyof Services>(service?: K): FakeDisk {
    const serviceToUse = service || this.#config.default;

    if (!this.#config.fakes) {
      throw new StorageException(
        'Cannot use "drive.fake". Make sure to define fakes configuration when creating DriveManager instance',
        'E_MISSING_FAKES_CONFIG',
      );
    }

    this.restore(serviceToUse);
    const fake = new FakeDisk(serviceToUse as string, this.#config.fakes);
    fake.onRestore(() => this.restore(serviceToUse));
    this.#fakes.set(serviceToUse, fake);
    return fake;
  }

  restore<K extends keyof Services>(service?: K): void {
    const serviceToUse = service || this.#config.default;
    const fake = this.#fakes.get(serviceToUse);

    if (fake) {
      fake.clear();
      this.#fakes.delete(serviceToUse);
    }
  }
}

export { DriveManager as StorageManager };

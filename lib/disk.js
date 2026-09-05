import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readFileAsync } from './utils.js';

function queryFilesystem(path) {
    return new Promise((resolve) => {
        const file = Gio.File.new_for_path(path);
        file.query_filesystem_info_async(
            'filesystem::size,filesystem::free,filesystem::used',
            GLib.PRIORITY_DEFAULT,
            null,
            (obj, res) => {
                try {
                    const info = obj.query_filesystem_info_finish(res);
                    const size = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    let used = info.has_attribute('filesystem::used')
                        ? info.get_attribute_uint64('filesystem::used')
                        : 0;
                    if (used === 0 && size > free) {
                        used = size - free;
                    }
                    const percent = size > 0 ? (used / size) * 100 : 0;
                    resolve({
                        mount: path,
                        size: size,
                        used: used,
                        free: free,
                        percent: Math.max(0, Math.min(100, percent))
                    });
                } catch (e) {
                    resolve(null);
                }
            }
        );
    });
}

/**
 * Note on Per-Process Disk I/O:
 * Per-process I/O accounting via /proc/[pid]/io requires elevated (root or CAP_SYS_PTRACEE)
 * permissions on Linux (mode 0400 owned by root). Non-root GNOME extension processes
 * cannot access /proc/[pid]/io for other users' processes without root privileges.
 * Therefore, top per-process Disk I/O breakdown is intentionally omitted to comply with the
 * unprivileged GNOME Shell security model, focusing instead on system-wide physical disk throughput and mounts.
 */
export class DiskSampler {
    constructor() {
        this._prevRead = 0;
        this._prevWrite = 0;
        this._prevIoTicks = 0;
        this._prevDiskTicks = new Map();
        this._prevTime = 0;
        this._maxSpeed = 100 * 1024 * 1024; // 100 MB/s initial baseline
        this._cachedMounts = [];
        this._lastMountCheck = 0;
    }

    async _queryMounts(detailed = true) {
        const mountList = [{ device: '', mount: '/' }];
        if (detailed) {
            try {
                const mountsContent = await readFileAsync('/proc/mounts');
                const lines = mountsContent.split('\n');
                const interestingFs = ['ext4', 'btrfs', 'xfs', 'ntfs', 'vfat', 'fuseblk', 'ext3', 'zfs'];
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 3) {
                        const dev = parts[0];
                        const mountPoint = parts[1];
                        const fsType = parts[2];
                        if (interestingFs.includes(fsType)) {
                            if (mountPoint === '/home' ||
                                mountPoint.startsWith('/media/') ||
                                mountPoint.startsWith('/run/media/') ||
                                mountPoint.startsWith('/mnt/') ||
                                mountPoint.startsWith('/data')) {
                                if (!mountList.some(m => m.mount === mountPoint || (dev && m.device === dev))) {
                                    mountList.push({ device: dev, mount: mountPoint });
                                }
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        const spacePromises = mountList.map(m => queryFilesystem(m.mount));
        const rawResults = (await Promise.all(spacePromises)).filter(r => r !== null);
        this._cachedMounts = rawResults;
        this._lastMountCheck = GLib.get_monotonic_time();
    }

    async sample(detailed = true) {
        try {
            const now = GLib.get_monotonic_time();

            // 1. Refresh Mounts Space periodically (every 15 seconds)
            if (this._cachedMounts.length === 0 || (now - this._lastMountCheck) > 15000000) {
                await this._queryMounts(detailed);
            }
            const spaceResults = this._cachedMounts;

            // 2. Parse Disk I/O throughput & hardware active time
            let totalReadBytes = 0;
            let totalWriteBytes = 0;
            let totalIoTicks = 0;
            let physicalDiskCount = 0;
            let maxDiskIoPercent = 0;
            const currentDiskTicks = new Map();

            let deltaTimeMs = 0;
            if (this._prevTime > 0) {
                const deltaTime = (now - this._prevTime) / 1000000;
                deltaTimeMs = deltaTime * 1000;
            }

            try {
                const diskstats = await readFileAsync('/proc/diskstats');
                const lines = diskstats.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 13) {
                        const name = parts[2];
                        // Match physical disk names (e.g. sda, sdaa, nvme0n1, vda, xvda, mmcblk0)
                        const isPhysicalDisk = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/.test(name);
                        if (isPhysicalDisk) {
                            physicalDiskCount++;
                            const sectorsRead = parseInt(parts[5], 10) || 0;
                            const sectorsWrite = parseInt(parts[9], 10) || 0;
                            const ioTicks = parseInt(parts[12], 10) || 0;

                            totalReadBytes += sectorsRead * 512;
                            totalWriteBytes += sectorsWrite * 512;
                            totalIoTicks += ioTicks;
                            currentDiskTicks.set(name, ioTicks);

                            if (this._prevDiskTicks.has(name) && deltaTimeMs > 0) {
                                const deltaTicks = Math.max(0, ioTicks - this._prevDiskTicks.get(name));
                                const util = (deltaTicks / deltaTimeMs) * 100;
                                if (util > maxDiskIoPercent) {
                                    maxDiskIoPercent = util;
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`Failed to read /proc/diskstats: ${e.message}`);
            }

            let readRate = 0;
            let writeRate = 0;
            let diskPercent = 0;

            if (this._prevTime > 0) {
                const deltaTime = (now - this._prevTime) / 1000000;
                if (deltaTime > 0) {
                    readRate = Math.max(0, (totalReadBytes - this._prevRead) / deltaTime);
                    writeRate = Math.max(0, (totalWriteBytes - this._prevWrite) / deltaTime);

                    const totalRate = readRate + writeRate;
                    if (totalRate > this._maxSpeed) {
                        this._maxSpeed = totalRate * 1.2;
                    }

                    const ioPercent = Math.min(100, maxDiskIoPercent);
                    const throughputPercent = this._maxSpeed > 0 ? (totalRate / this._maxSpeed) * 100 : 0;

                    diskPercent = Math.max(0, Math.min(100, Math.max(ioPercent, throughputPercent)));
                }
            }

            this._prevRead = totalReadBytes;
            this._prevWrite = totalWriteBytes;
            this._prevIoTicks = totalIoTicks;
            this._prevDiskTicks = currentDiskTicks;
            this._prevTime = now;

            return {
                mounts: spaceResults,
                readRate: readRate,
                writeRate: writeRate,
                diskPercent: diskPercent,
                maxSpeed: this._maxSpeed
            };
        } catch (e) {
            console.error(`Error in Disk sample: ${e.message}`);
            return {
                mounts: [],
                readRate: 0,
                writeRate: 0,
                diskPercent: 0,
                maxSpeed: 100 * 1024 * 1024
            };
        }
    }
}

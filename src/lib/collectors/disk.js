import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readProcFile, logOnce } from '../common/utils.js';

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

const PHYSICAL_DISK = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/;
const INTERESTING_FS = ['ext4', 'btrfs', 'xfs', 'ntfs', 'ntfs3', 'vfat', 'exfat', 'fuseblk', 'f2fs', 'ext3', 'ext2', 'zfs', 'bcachefs'];

/**
 * Whole physical disks from /proc/diskstats (partitions, loop, dm and zram
 * devices are left out so nothing is counted twice).
 * @returns {{name: string, sectorsRead: number, sectorsWritten: number, ioTicks: number}[]}
 */
export function parseDiskstats(content) {
    const out = [];
    for (const line of content.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 13 || !PHYSICAL_DISK.test(parts[2])) continue;
        out.push({
            name: parts[2],
            sectorsRead: parseInt(parts[5], 10) || 0,
            sectorsWritten: parseInt(parts[9], 10) || 0,
            ioTicks: parseInt(parts[12], 10) || 0
        });
    }
    return out;
}

/**
 * User-facing mounts besides '/', from /proc/mounts: real filesystems under
 * /home, /media, /run/media, /mnt or /data, one entry per device.
 * Octal escapes in mount points (\040 for a space) are decoded.
 * @returns {{device: string, mount: string}[]}
 */
export function parseMounts(content) {
    const list = [];
    for (const line of content.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3 || !INTERESTING_FS.includes(parts[2])) continue;
        const dev = parts[0];
        const mountPoint = parts[1].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
        if (!(mountPoint === '/home' || mountPoint.startsWith('/media/') || mountPoint.startsWith('/run/media/') ||
              mountPoint.startsWith('/mnt/') || mountPoint.startsWith('/data')))
            continue;
        if (!list.some(m => m.mount === mountPoint || m.device === dev))
            list.push({ device: dev, mount: mountPoint });
    }
    return list;
}

/**
 * Busy share of one device: io_ticks (ms the device had I/O in flight)
 * advanced over the elapsed wall time. Counter reset reads 0.
 */
export function ioUtilization(curTicks, prevTicks, elapsedMs) {
    if (!(elapsedMs > 0) || curTicks < prevTicks) return 0;
    return Math.min(100, ((curTicks - prevTicks) / elapsedMs) * 100);
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
        this._cachedDetailed = null;
    }

    async _queryMounts(detailed = true) {
        const mountList = [{ device: '', mount: '/' }];
        if (detailed) {
            try {
                mountList.push(...parseMounts(readProcFile('/proc/mounts')));
            } catch (e) {
                logOnce(`Failed to read /proc/mounts: ${e.message}`, 'error');
            }
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
            // The overview only needs '/'; a switch to the disk tab must not wait
            // for the cache to expire before the other mounts show up.
            if (this._cachedMounts.length === 0 || this._cachedDetailed !== detailed ||
                (now - this._lastMountCheck) > 15000000) {
                await this._queryMounts(detailed);
                this._cachedDetailed = detailed;
            }
            const spaceResults = this._cachedMounts;

            // 2. Parse Disk I/O throughput & hardware active time
            let totalReadBytes = 0;
            let totalWriteBytes = 0;
            let totalIoTicks = 0;
            let maxDiskIoPercent = 0;
            const currentDiskTicks = new Map();

            let deltaTimeMs = 0;
            if (this._prevTime > 0) {
                const deltaTime = (now - this._prevTime) / 1000000;
                deltaTimeMs = deltaTime * 1000;
            }

            try {
                const diskstats = readProcFile('/proc/diskstats');
                for (const disk of parseDiskstats(diskstats)) {
                    totalReadBytes += disk.sectorsRead * 512;
                    totalWriteBytes += disk.sectorsWritten * 512;
                    totalIoTicks += disk.ioTicks;
                    currentDiskTicks.set(disk.name, disk.ioTicks);
                    if (this._prevDiskTicks.has(disk.name)) {
                        const util = ioUtilization(disk.ioTicks, this._prevDiskTicks.get(disk.name), deltaTimeMs);
                        if (util > maxDiskIoPercent) maxDiskIoPercent = util;
                    }
                }
            } catch (e) {
                logOnce(`Failed to read /proc/diskstats: ${e.message}`, 'error');
            }

            let readRate = 0;
            let writeRate = 0;
            let diskPercent = 0;

            if (this._prevTime > 0) {
                const deltaTime = (now - this._prevTime) / 1000000;
                if (deltaTime > 0) {
                    readRate = Math.max(0, (totalReadBytes - this._prevRead) / deltaTime);
                    writeRate = Math.max(0, (totalWriteBytes - this._prevWrite) / deltaTime);

                    // Busiest device's active time (io_ticks), the same figure
                    // iostat reports as %util.
                    diskPercent = Math.max(0, Math.min(100, maxDiskIoPercent));
                }
            }

            this._prevRead = totalReadBytes;
            this._prevWrite = totalWriteBytes;
            this._prevIoTicks = totalIoTicks;
            this._prevDiskTicks = currentDiskTicks;
            this._prevTime = now;

            return {
                mounts: spaceResults,
                // false: only '/' was queried (top bar), not the full mount list
                detailed: this._cachedDetailed === true,
                readRate: readRate,
                writeRate: writeRate,
                diskPercent: diskPercent,
                maxSpeed: this._maxSpeed
            };
        } catch (e) {
            logOnce(`Error in Disk sample: ${e.message}`, 'error');
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

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { readProcFile, logOnce } from '../common/utils.js';
import { counterDelta } from './network.js';

/**
 * How full a filesystem is, as df counts it: used against what is usable.
 * Blocks reserved for root (5 % on ext4 by default) are in neither figure, so
 * a disk an ordinary user can no longer write to reads 100 %, not 95 %.
 */
export function spaceUsedPercent(used, free) {
    const usable = used + free;
    return usable > 0 ? Math.max(0, Math.min(100, (used / usable) * 100)) : 0;
}

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
                    resolve({
                        mount: path,
                        size: size,
                        used: used,
                        free: free,
                        percent: spaceUsedPercent(used, free)
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
    /** @param {string} [proc] /proc, or a fixture in tests */
    constructor(proc = '/proc') {
        this._proc = proc;
        this._prevDisks = new Map(); // name -> its parseDiskstats entry at the last reading
        this._prevTime = 0;
        this._maxSpeed = 100 * 1024 * 1024; // 100 MB/s initial baseline
        this._cachedMounts = [];
        this._lastMountCheck = 0;
        this._cachedDetailed = null;
        this._mountQuery = 0;
        this._refreshing = false;
    }

    async _queryMounts(detailed = true) {
        const query = ++this._mountQuery;
        const mountList = [{ device: '', mount: '/' }];
        if (detailed) {
            try {
                mountList.push(...parseMounts(readProcFile(`${this._proc}/mounts`)));
            } catch (e) {
                logOnce(`Failed to read /proc/mounts: ${e.message}`, 'error');
            }
        }

        const spacePromises = mountList.map(m => queryFilesystem(m.mount));
        const rawResults = (await Promise.all(spacePromises)).filter(r => r !== null);
        // An older query that answers late (a disk spinning up) changes nothing.
        if (query !== this._mountQuery) return;
        this._cachedMounts = rawResults;
        this._lastMountCheck = GLib.get_monotonic_time();
    }

    /** Update the free space behind the readings: a slow disk delays only this figure. */
    _refreshMounts(detailed) {
        if (this._refreshing) return;
        this._refreshing = true;
        this._queryMounts(detailed)
            .catch(e => logOnce(`Failed to query mounts: ${e.message}`, 'error'))
            .finally(() => {
                this._refreshing = false;
            });
    }

    async sample(detailed = true) {
        try {
            // 1. Disk I/O throughput & hardware active time, first and timed
            // at the read: a rate must not include how long the mounts take.
            let readBytes = 0;
            let writeBytes = 0;
            let maxDiskIoPercent = 0;
            const disks = new Map();
            let now = GLib.get_monotonic_time();

            try {
                const diskstats = readProcFile(`${this._proc}/diskstats`);
                now = GLib.get_monotonic_time();
                const deltaTimeMs = this._prevTime > 0 ? (now - this._prevTime) / 1000 : 0;
                for (const disk of parseDiskstats(diskstats)) {
                    disks.set(disk.name, disk);
                    // Per disk: one attached since the last reading counts from
                    // the next, and one removed does not hide the others' traffic.
                    const prev = this._prevDisks.get(disk.name);
                    if (!prev) continue;
                    readBytes += counterDelta(disk.sectorsRead, prev.sectorsRead) * 512;
                    writeBytes += counterDelta(disk.sectorsWritten, prev.sectorsWritten) * 512;
                    const util = ioUtilization(disk.ioTicks, prev.ioTicks, deltaTimeMs);
                    if (util > maxDiskIoPercent) maxDiskIoPercent = util;
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
                    readRate = readBytes / deltaTime;
                    writeRate = writeBytes / deltaTime;

                    // Busiest device's active time (io_ticks), the same figure
                    // iostat reports as %util.
                    diskPercent = Math.max(0, Math.min(100, maxDiskIoPercent));
                }
            }

            this._prevDisks = disks;
            this._prevTime = now;

            // 2. Mounts' space. The overview only needs '/'; a switch to the
            // disk tab must not wait for the cache to expire before the other
            // mounts show up. Otherwise refreshed every 15 seconds, behind the
            // reading: this one shows the last figure.
            if (this._cachedMounts.length === 0 || this._cachedDetailed !== detailed) {
                await this._queryMounts(detailed);
                this._cachedDetailed = detailed;
            } else if ((now - this._lastMountCheck) > 15000000) {
                this._refreshMounts(detailed);
            }
            const spaceResults = this._cachedMounts;

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

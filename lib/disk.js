import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

async function readFileAsync(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (obj, res) => {
            try {
                const [, contents] = obj.load_contents_finish(res);
                const decoder = new TextDecoder('utf-8');
                resolve(decoder.decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function queryFilesystem(path) {
    return new Promise((resolve) => {
        const file = Gio.File.new_for_path(path);
        file.query_filesystem_info_async(
            'filesystem::size,filesystem::free',
            GLib.PRIORITY_DEFAULT,
            null,
            (obj, res) => {
                try {
                    const info = obj.query_filesystem_info_finish(res);
                    const size = info.get_attribute_uint64('filesystem::size');
                    const free = info.get_attribute_uint64('filesystem::free');
                    const used = size - free;
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

export class DiskSampler {
    constructor() {
        this._prevRead = 0;
        this._prevWrite = 0;
        this._prevTime = 0;
    }

    async sample() {
        try {
            // 1. Get Mounted Volumes Space
            const mounts = ['/'];
            try {
                const mountsContent = await readFileAsync('/proc/mounts');
                const lines = mountsContent.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 3) {
                        const mountPoint = parts[1];
                        const fsType = parts[2];
                        const interestingFs = ['ext4', 'btrfs', 'xfs', 'ntfs', 'vfat', 'fuseblk', 'ext3'];
                        if (interestingFs.includes(fsType)) {
                            // Focus on /, /home, or custom media mount points
                            if (mountPoint === '/home' || mountPoint.startsWith('/media/') || mountPoint.startsWith('/run/media/')) {
                                if (!mounts.includes(mountPoint)) {
                                    mounts.push(mountPoint);
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`Failed to parse mounts: ${e.message}`);
            }

            const spacePromises = mounts.map(m => queryFilesystem(m));
            const rawResults = (await Promise.all(spacePromises)).filter(r => r !== null);
            const rootFs = rawResults.find(r => r.mount === '/');
            const spaceResults = rawResults.filter(r => {
                if (r.mount === '/') return true;
                if (rootFs && r.size === rootFs.size && r.free === rootFs.free) return false;
                return true;
            });

            // 2. Parse Disk I/O throughput
            let totalReadBytes = 0;
            let totalWriteBytes = 0;
            const now = GLib.get_monotonic_time();

            try {
                const diskstats = await readFileAsync('/proc/diskstats');
                const lines = diskstats.split('\n');
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 10) {
                        const name = parts[2];
                        // Match physical disk names (e.g. sda, nvme0n1, vda, mmcblk0)
                        const isPhysicalDisk = /^(sd[a-z]|nvme\d+n\d+|vd[a-z]|mmcblk\d+)$/.test(name);
                        if (isPhysicalDisk) {
                            const sectorsRead = parseInt(parts[5], 10) || 0;
                            const sectorsWrite = parseInt(parts[9], 10) || 0;
                            totalReadBytes += sectorsRead * 512;
                            totalWriteBytes += sectorsWrite * 512;
                        }
                    }
                }
            } catch (e) {
                console.error(`Failed to read /proc/diskstats: ${e.message}`);
            }

            let readRate = 0;
            let writeRate = 0;

            if (this._prevTime > 0) {
                const deltaTime = (now - this._prevTime) / 1000000;
                if (deltaTime > 0) {
                    readRate = Math.max(0, (totalReadBytes - this._prevRead) / deltaTime);
                    writeRate = Math.max(0, (totalWriteBytes - this._prevWrite) / deltaTime);
                }
            }

            this._prevRead = totalReadBytes;
            this._prevWrite = totalWriteBytes;
            this._prevTime = now;

            return {
                mounts: spaceResults,
                readRate: readRate,
                writeRate: writeRate
            };
        } catch (e) {
            console.error(`Error in Disk sample: ${e.message}`);
            return {
                mounts: [],
                readRate: 0,
                writeRate: 0
            };
        }
    }
}

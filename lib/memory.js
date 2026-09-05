import GLib from 'gi://GLib';
import { readFileAsync } from './utils.js';

export class MemorySampler {
    constructor() {
        this._prevSwapIn = 0;
        this._prevSwapOut = 0;
        this._prevTime = 0;
    }

    async sample() {
        try {
            const content = await readFileAsync('/proc/meminfo');
            const lines = content.split('\n');

            let memTotal = 0;
            let memFree = 0;
            let memAvailable = 0;
            let buffers = 0;
            let cached = 0;
            let swapTotal = 0;
            let swapFree = 0;

            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 2) {
                    const key = parts[0];
                    const val = parseInt(parts[1], 10) * 1024; // Convert kB to Bytes
                    if (key === 'MemTotal:') {
                        memTotal = val;
                    } else if (key === 'MemFree:') {
                        memFree = val;
                    } else if (key === 'MemAvailable:') {
                        memAvailable = val;
                    } else if (key === 'Buffers:') {
                        buffers = val;
                    } else if (key === 'Cached:') {
                        cached = val;
                    } else if (key === 'SwapTotal:') {
                        swapTotal = val;
                    } else if (key === 'SwapFree:') {
                        swapFree = val;
                    }
                }
            }

            const effectiveAvail = memAvailable > 0 ? memAvailable : (memFree + buffers + cached);
            const memUsed = Math.max(0, memTotal - effectiveAvail);
            const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

            const swapUsed = swapTotal - swapFree;
            const swapPercent = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

            // Swap activity from /proc/vmstat
            let swapInRate = 0;
            let swapOutRate = 0;
            const now = GLib.get_monotonic_time();

            try {
                const vmstat = await readFileAsync('/proc/vmstat');
                let pswpin = 0;
                let pswpout = 0;
                for (const vline of vmstat.split('\n')) {
                    if (vline.startsWith('pswpin ')) {
                        pswpin = parseInt(vline.split(/\s+/)[1], 10) || 0;
                    } else if (vline.startsWith('pswpout ')) {
                        pswpout = parseInt(vline.split(/\s+/)[1], 10) || 0;
                    }
                }

                if (this._prevTime > 0 && this._prevSwapIn !== undefined) {
                    const deltaTime = (now - this._prevTime) / 1000000;
                    if (deltaTime > 0) {
                        swapInRate = Math.max(0, ((pswpin - this._prevSwapIn) * 4096) / deltaTime);
                        swapOutRate = Math.max(0, ((pswpout - this._prevSwapOut) * 4096) / deltaTime);
                    }
                }
                this._prevSwapIn = pswpin;
                this._prevSwapOut = pswpout;
                this._prevTime = now;
            } catch (e) {}

            return {
                total: memTotal,
                used: memUsed,
                free: memFree,
                available: memAvailable,
                buffers: buffers,
                cached: cached,
                percent: Math.max(0, Math.min(100, memPercent)),
                swapTotal: swapTotal,
                swapUsed: swapUsed,
                swapPercent: Math.max(0, Math.min(100, swapPercent)),
                swapInRate: swapInRate,
                swapOutRate: swapOutRate
            };
        } catch (e) {
            console.error(`Error in Memory sample: ${e.message}`);
            return {
                total: 0,
                used: 0,
                free: 0,
                available: 0,
                buffers: 0,
                cached: 0,
                percent: 0,
                swapTotal: 0,
                swapUsed: 0,
                swapPercent: 0,
                swapInRate: 0,
                swapOutRate: 0
            };
        }
    }
}

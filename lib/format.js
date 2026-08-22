const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const BYTE_UNITS_IEC = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const SPEED_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s'];

// Index of the largest unit not exceeding `value`, clamped to the unit table.
function unitIndex(value, base, count) {
    const i = Math.floor(Math.log(value) / Math.log(base));
    return Math.max(0, Math.min(count - 1, i));
}

export function formatBytes(bytes, useGiB = false) {
    if (!(bytes >= 1)) return '0 B';
    const k = useGiB ? 1024 : 1000;
    const units = useGiB ? BYTE_UNITS_IEC : BYTE_UNITS;
    const i = unitIndex(bytes, k, units.length);
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec) {
    if (!(bytesPerSec >= 1)) return '0 B/s';
    const i = unitIndex(bytesPerSec, 1024, SPEED_UNITS.length);
    return `${(bytesPerSec / Math.pow(1024, i)).toFixed(1)} ${SPEED_UNITS[i]}`;
}

export function formatTemp(celsius, unit = 'C') {
    if (unit === 'F') return `${Math.round((celsius * 9) / 5 + 32)}°F`;
    return `${Math.round(celsius)}°C`;
}

export function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

export function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

export function batteryStateLabel(state) {
    switch (state) {
    case 'charging': return 'Charging';
    case 'discharging': return 'Discharging';
    case 'full': return 'Fully Charged';
    case 'not charging': return 'Not Charging';
    case 'empty': return 'Empty';
    default: return 'Unknown';
    }
}

// Rankings from a bounded pair of cgroup snapshots. Stall percentages for
// one app's scopes can overlap, so keep their maximum rather than summing.
export const BOTTLENECK_TOP = 3;
export const BOTTLENECK_ID_LIMIT = 80;

function share(now, before, elapsed) {
    const delta = now - before;
    return now !== null && before !== null && delta >= 0 && delta <= elapsed
        ? 100 * delta / elapsed : null;
}

function rate(now, before, elapsed) {
    return now !== null && before !== null && now >= before ? (now - before) * 1e6 / elapsed : null;
}

function ranked(apps, value) {
    const out = [];
    for (const app of apps.values()) {
        const amount = value(app);
        if (Number.isFinite(amount) && amount > 0 && app.id.length <= BOTTLENECK_ID_LIMIT)
            out.push({ id: app.id, value: amount });
    }
    return out.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id)).slice(0, BOTTLENECK_TOP);
}

export function appBottlenecks(before, after) {
    if (!before || !after || after.time <= before.time || after.time - before.time > 20e6) return null;
    const earlier = new Map(before.units.map(scope => [scope.path, scope]));
    const apps = new Map();
    const observed = Array.from({ length: 3 }, () => [0, 0, 0]);
    let paired = 0;
    let estimated = false;

    const appFor = id => {
        if (!apps.has(id)) apps.set(id, { id, recent: [0, 0, 0], wait: [0, 0, 0], usage: [0, 0, 0] });
        return apps.get(id);
    };
    for (const scope of before.units) {
        for (let i = 0; i < 3; i++) {
            const value = scope.pressure[2 * i];
            if (!(value >= 0 && value <= 100 && value !== null)) continue;
            observed[i][0]++;
            const app = appFor(scope.id);
            app.recent[i] = Math.max(app.recent[i], value);
        }
    }
    for (const scope of after.units) {
        const app = appFor(scope.id);
        if (scope.memory !== null) {
            observed[1][2]++;
            app.usage[1] += scope.memory;
        }
        const old = earlier.get(scope.path);
        if (old?.inode !== scope.inode || scope.at <= old.at) continue;
        paired++;
        const elapsed = scope.at - old.at;
        for (let i = 0; i < 3; i++) {
            const wait = share(scope.pressure[2 * i + 1], old.pressure[2 * i + 1], elapsed);
            if (wait === null) continue;
            observed[i][1]++;
            app.wait[i] = Math.max(app.wait[i], wait);
        }
        const cpu = rate(scope.cpu, old.cpu, elapsed);
        if (cpu !== null) {
            observed[0][2]++;
            app.usage[0] += cpu / 10000; // 100% = one logical core
        }
        const direct = rate(scope.io, old.io, elapsed);
        if (direct !== null) {
            observed[2][2]++;
            app.usage[2] += direct;
        } else {
            const io = after.io.get(scope.path);
            if (io) {
                observed[2][2]++;
                estimated = true;
                app.usage[2] += (io.read + io.write) * 1e6 / (after.time - before.time);
            }
        }
    }
    return {
        scopes: [before.total, paired, after.total],
        estimated,
        resources: observed.map((coverage, i) => ({
            coverage, recent: ranked(apps, a => a.recent[i]),
            wait: ranked(apps, a => a.wait[i]), usage: ranked(apps, a => a.usage[i]),
        })),
    };
}

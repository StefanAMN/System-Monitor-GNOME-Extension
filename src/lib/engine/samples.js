// Collector results and their age. A late result is delivered once on the
// next poll; displaying a held value never turns it into a new measurement.
export const SAMPLE_KEYS = {
    cpu: 'cpu', mem: 'memory', bat: 'battery', dsk: 'disk', net: 'network',
    thm: 'thermal', gpu: 'gpu', pwr: 'power', psi: 'pressure', throttle: 'throttle',
};

export class CollectorSamples {
    constructor(now, outstanding = {}, report = () => {}) {
        this._now = now;
        this.outstanding = outstanding;
        this._report = report;
        this._entries = new Map();
        this._closed = false;
        this._waiters = new Set();
    }

    held(key, fallback) {
        const e = this._entries.get(key);
        return {
            value: e?.value ?? fallback,
            sampledAt: e?.sampledAt ?? null,
            fresh: false,
            status: e?.stale ? 'stale' : e?.sampledAt !== undefined ? 'cached' : 'unavailable',
        };
    }

    async read(key, deadline, start, fallback, context = null) {
        if (this._closed) return this.held(key, fallback);
        let e = this._entries.get(key);
        if (this.outstanding[key]) return e?.context === context ? this.held(key, fallback)
            : { value: fallback, sampledAt: null, fresh: false, status: 'unavailable' };
        if (e?.context !== context) e = null;
        if (e?.ready) {
            e.ready = false;
            return { value: e.value, sampledAt: e.sampledAt, fresh: true, status: 'fresh' };
        }
        if (!e) {
            e = { value: fallback, ready: false, stale: false, context };
            this._entries.set(key, e);
        }
        let sample;
        try {
            sample = Promise.resolve(start());
        } catch (error) {
            e.stale = true;
            this._report(key, error);
            return this.held(key, fallback);
        }
        this.outstanding[key] = sample;
        let settled = false;
        const completed = sample.then(value => {
            settled = true;
            if (this._closed || this.outstanding[key] !== sample) return this.held(key, fallback);
            delete this.outstanding[key];
            e.value = value;
            e.sampledAt = this._now();
            e.ready = true;
            e.stale = false;
            return { value, sampledAt: e.sampledAt, fresh: true, status: 'fresh' };
        }, error => {
            settled = true;
            if (!this._closed && this.outstanding[key] === sample) {
                delete this.outstanding[key];
                e.stale = true;
                this._report(key, error);
            }
            return this.held(key, fallback);
        });
        let cancel;
        const cancelled = new Promise(resolve => {
            cancel = () => resolve(this.held(key, fallback));
            this._waiters.add(cancel);
        });
        const result = await Promise.race([completed, deadline.then(() => {
            if (!settled && !this._closed) {
                e.stale = true;
                this._report(key, null);
            }
            return this.held(key, fallback);
        }), cancelled]);
        this._waiters.delete(cancel);
        if (result.fresh) e.ready = false;
        return result;
    }

    close() {
        this._closed = true;
        for (const cancel of this._waiters) cancel();
        this._waiters.clear();
        this._entries.clear();
        for (const key of Object.keys(this.outstanding)) delete this.outstanding[key];
    }
}

export function freshSample(data, key) {
    return !data.samples || data.samples[key]?.fresh === true;
}

/** Preserve the live time axis, placing a delayed sample into its missing tick. */
export function recordLiveSample(history, value, sampledAt, now, intervalUs, missed = 0) {
    for (let i = 0; i < Math.min(missed, history.capacity - 1); i++) history.pushGap();
    const back = Number.isFinite(sampledAt) && intervalUs > 0
        ? Math.max(0, Math.round((now - sampledAt) / intervalUs)) : 0;
    if (!Number.isFinite(value) || back > 0) history.pushGap();
    else history.push(value);
    if (back > 0) history.fillGap(history.length - 1 - back, value);
}

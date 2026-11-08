// Longer history for the detail charts: fixed-size series of time buckets
// (1 minute over the last hour, 15 minutes over the last day), each holding
// the average and the peak of the samples that fell into it. Engine layer.
//
// Memory is fixed at construction. A bucket
// with no sample, because the metric was not read then, is NaN and drawn as
// a gap, never as a zero.
//
// Time is the monotonic clock, which stops while the machine is suspended:
// buckets on either side of a suspend are adjacent.

import { N_ } from '../common/i18n.js';

export class BucketSeries {
    /**
     * @param {number} bucketUs bucket width in µs
     * @param {number} capacity buckets shown, the open (current) one included
     */
    constructor(bucketUs, capacity) {
        this.bucketUs = bucketUs;
        this.capacity = capacity;
        // Closed buckets, oldest first from (head - closed).
        this._sums = new Float64Array(capacity);
        this._weights = new Float64Array(capacity);
        this._peak = new Float64Array(capacity);
        this._head = 0;
        this._closed = 0;
        this._openIndex = -1;
        this._sum = 0;
        this._weight = 0;
        this._max = -Infinity;
    }

    _pushClosed(sum, weight, peak) {
        this._sums[this._head] = sum;
        this._weights[this._head] = weight;
        this._peak[this._head] = peak;
        this._head = (this._head + 1) % this.capacity;
        if (this._closed < this.capacity) this._closed++;
    }

    /** Close the open bucket and every empty one up to the bucket holding `now`. */
    advance(now) {
        const index = Math.floor(now / this.bucketUs);
        if (this._openIndex < 0) {
            this._openIndex = index;
            return;
        }
        if (index <= this._openIndex) return;
        this._pushClosed(this._sum, this._weight, this._weight > 0 ? this._max : NaN);
        // More empty buckets than fit would only overwrite each other.
        const empty = Math.min(index - this._openIndex - 1, this.capacity);
        for (let i = 0; i < empty; i++) this._pushClosed(0, 0, NaN);
        this._openIndex = index;
        this._sum = 0;
        this._weight = 0;
        this._max = -Infinity;
    }

    /** @param {number} value a sample; non-finite values are ignored */
    add(value, now) {
        // A delayed result cannot be inserted into a bucket already closed.
        if (this._openIndex > Math.floor(now / this.bucketUs)) return;
        this.advance(now);
        if (!Number.isFinite(value)) return;
        this._sum += value;
        this._weight++;
        if (value > this._max) this._max = value;
    }

    /**
     * A per-second rate covers an interval, not just its endpoint. Split the
     * measured time across the retained buckets it overlaps, including one
     * already closed while waiting for the next counter read.
     */
    addRate(value, end, elapsedUs) {
        if (!Number.isFinite(value) || !Number.isFinite(end) || !Number.isFinite(elapsedUs) || elapsedUs <= 0) return;
        const start = Math.max(0, end - elapsedUs);
        if (end <= start) return;
        const width = this.bucketUs;
        if (this._openIndex < 0) this.advance(Math.max(start, (Math.floor(end / width) - this.capacity + 1) * width));
        this.advance(end);
        const first = Math.max(Math.floor(start / width), this._openIndex - this.length + 1);
        const last = Math.ceil(end / width) - 1;
        for (let index = first; index <= last; index++) {
            const time = Math.min(end, (index + 1) * width) - Math.max(start, index * width);
            if (index === this._openIndex) {
                this._sum += value * time;
                this._weight += time;
                this._max = Math.max(this._max, value);
            } else {
                const slot = (this._head - (this._openIndex - index) + this.capacity) % this.capacity;
                this._sums[slot] += value * time;
                this._peak[slot] = this._weights[slot] > 0 ? Math.max(this._peak[slot], value) : value;
                this._weights[slot] += time;
            }
        }
    }

    /** Buckets shown: the closed ones that fit plus the open one. */
    get length() {
        if (this._openIndex < 0) return 0;
        return Math.min(this.capacity, this._closed + 1);
    }

    /** Average of bucket i (0 = oldest shown); NaN for a bucket without samples. */
    get(i) {
        const n = this.length;
        if (i < 0 || i >= n) return NaN;
        if (i === n - 1) return this._weight > 0 ? this._sum / this._weight : NaN;
        const slot = (this._head - (n - 1 - i) + this.capacity) % this.capacity;
        return this._weights[slot] > 0 ? this._sums[slot] / this._weights[slot] : NaN;
    }

    /** Highest sample in bucket i; NaN for a bucket without samples. */
    peakAt(i) {
        const n = this.length;
        if (i < 0 || i >= n) return NaN;
        if (i === n - 1) return this._weight > 0 ? this._max : NaN;
        return this._peak[(this._head - (n - 1 - i) + this.capacity) % this.capacity];
    }

    /** Highest peak shown, for the chart's scale (0 when there is none). */
    max() {
        let m = 0;
        for (let i = 0; i < this.length; i++) {
            const v = this.peakAt(i);
            if (v > m) m = v;
        }
        return m;
    }

    clear() {
        this._head = 0;
        this._closed = 0;
        this._openIndex = -1;
        this._sum = 0;
        this._weight = 0;
        this._max = -Infinity;
    }
}

// The chart ranges: the live ring (one sample per poll) and two bucketed ones.
export const RANGES = {
    live: null,
    // Translators: chart ranges on a chip, kept short: one hour, 24 hours.
    hour: { bucketUs: 60e6, capacity: 61, label: N_('1h') },
    day: { bucketUs: 15 * 60e6, capacity: 97, label: N_('24h') },
};

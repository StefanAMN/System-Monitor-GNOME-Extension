// Longer history for the detail charts: fixed-size series of time buckets
// (1 minute over the last hour, 15 minutes over the last day), each holding
// the average and the peak of the samples that fell into it. Engine layer.
//
// Memory is fixed at construction (two Float64Arrays per series). A bucket
// with no sample, because the metric was not read then, is NaN and drawn as
// a gap, never as a zero.
//
// Time is the monotonic clock, which stops while the machine is suspended:
// buckets on either side of a suspend are adjacent.

export class BucketSeries {
    /**
     * @param {number} bucketUs bucket width in µs
     * @param {number} capacity buckets shown, the open (current) one included
     */
    constructor(bucketUs, capacity) {
        this.bucketUs = bucketUs;
        this.capacity = capacity;
        // Closed buckets, oldest first from (head - closed).
        this._avg = new Float64Array(capacity);
        this._peak = new Float64Array(capacity);
        this._head = 0;
        this._closed = 0;
        this._openIndex = -1;
        this._sum = 0;
        this._n = 0;
        this._max = -Infinity;
    }

    _pushClosed(avg, peak) {
        this._avg[this._head] = avg;
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
        this._pushClosed(this._n > 0 ? this._sum / this._n : NaN, this._n > 0 ? this._max : NaN);
        // More empty buckets than fit would only overwrite each other.
        const empty = Math.min(index - this._openIndex - 1, this.capacity);
        for (let i = 0; i < empty; i++) this._pushClosed(NaN, NaN);
        this._openIndex = index;
        this._sum = 0;
        this._n = 0;
        this._max = -Infinity;
    }

    /** @param {number} value a sample; non-finite values are ignored */
    add(value, now) {
        this.advance(now);
        if (!Number.isFinite(value)) return;
        this._sum += value;
        this._n++;
        if (value > this._max) this._max = value;
    }

    /** Buckets shown: the closed ones that fit plus the open one. */
    get length() {
        if (this._openIndex < 0) return 0;
        return Math.min(this.capacity, this._closed + 1);
    }

    _at(array, open, i) {
        const n = this.length;
        if (i < 0 || i >= n) return NaN;
        if (i === n - 1) return open;
        // n - 1 closed buckets are shown, the newest of them just before head.
        const back = (n - 1) - i;
        return array[(this._head - back + this.capacity) % this.capacity];
    }

    /** Average of bucket i (0 = oldest shown); NaN for a bucket without samples. */
    get(i) {
        return this._at(this._avg, this._n > 0 ? this._sum / this._n : NaN, i);
    }

    /** Highest sample in bucket i; NaN for a bucket without samples. */
    peakAt(i) {
        return this._at(this._peak, this._n > 0 ? this._max : NaN, i);
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
        this._n = 0;
        this._max = -Infinity;
    }
}

// The chart ranges: the live ring (one sample per poll) and two bucketed ones.
export const RANGES = {
    live: null,
    hour: { bucketUs: 60e6, capacity: 61, label: '1h' },
    day: { bucketUs: 15 * 60e6, capacity: 97, label: '24h' },
};

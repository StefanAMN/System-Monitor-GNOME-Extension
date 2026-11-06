/**
 * Fixed-capacity circular buffer of numbers. Never reallocates after construction.
 * Index 0 is the oldest retained sample.
 */
export class RingBuffer {
    constructor(capacity = 60) {
        this._buf = new Float64Array(capacity);
        this._head = 0;
        this.capacity = capacity;
        this.length = 0;
    }

    push(value) {
        this._push(Number.isFinite(value) ? value : 0);
    }

    /** A missing measurement, drawn as a gap rather than an idle reading. */
    pushGap() {
        this._push(NaN);
    }

    _push(value) {
        this._buf[this._head] = value;
        this._head = (this._head + 1) % this.capacity;
        if (this.length < this.capacity) this.length++;
    }

    /** Fill a missing past tick when a delayed measurement finally arrives. */
    fillGap(i, value) {
        if (i < 0 || i >= this.length || !Number.isFinite(value) || Number.isFinite(this.get(i))) return false;
        this._buf[(this._head - this.length + i + this.capacity) % this.capacity] = value;
        return true;
    }

    get(i) {
        return this._buf[(this._head - this.length + i + this.capacity) % this.capacity];
    }

    max() {
        let m = 0;
        for (let i = 0; i < this.length; i++) {
            const v = this.get(i);
            if (v > m) m = v;
        }
        return m;
    }

    clear() {
        this._head = 0;
        this.length = 0;
    }
}

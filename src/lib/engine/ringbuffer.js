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
        this._buf[this._head] = Number.isFinite(value) ? value : 0;
        this._head = (this._head + 1) % this.capacity;
        if (this.length < this.capacity) this.length++;
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

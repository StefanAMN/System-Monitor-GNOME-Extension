/**
 * Running peak and time-weighted mean of a sampled quantity (e.g. watts).
 * Each reading is taken to hold until the next one. An interval longer than
 * maxGapS means the quantity was not being sampled (metric unpinned, menu
 * closed): it is left out of the mean rather than bridged with a stale value.
 */
export class RunningStats {
    constructor(maxGapS = 30) {
        this.maxGapS = maxGapS;
        this.peak = 0;
        this.count = 0;
        this._weighted = 0;
        this._seconds = 0;
        this._lastValue = 0;
        this._lastTime = 0;
    }

    /**
     * @param {number} value the reading
     * @param {number} nowUs monotonic time of the reading, microseconds
     */
    add(value, nowUs) {
        if (!Number.isFinite(value)) return;
        if (this._lastTime > 0) {
            const dt = (nowUs - this._lastTime) / 1000000;
            if (dt > 0 && dt <= this.maxGapS) {
                this._weighted += this._lastValue * dt;
                this._seconds += dt;
            }
        }
        this._lastValue = value;
        this._lastTime = nowUs;
        this.count++;
        if (value > this.peak) this.peak = value;
    }

    /** Mean over the time covered so far; the only reading when there is just one. */
    get mean() {
        if (this._seconds > 0) return this._weighted / this._seconds;
        return this.count > 0 ? this._lastValue : 0;
    }
}

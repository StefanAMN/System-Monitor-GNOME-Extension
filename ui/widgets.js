import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Cairo from 'cairo';

export const ResizeHandle = GObject.registerClass({
    GTypeName: 'ResourcePulseResizeHandle',
}, class ResizeHandle extends St.DrawingArea {
    _init(corner = 'se', size = 32, cursor = Clutter.CursorType.DEFAULT) {
        super._init({
            style_class: `resource-pulse-resize-handle resource-pulse-resize-handle-${corner}`,
            reactive: true,
            track_hover: true,
            can_focus: false,
            width: size,
            height: size
        });
        this.set_cursor_type(cursor);
        this._corner = corner;
        this._hovered = false;
        this._active = false;

        // Set pivot point to corner apex: (1.0, 1.0) for SE, (0.0, 1.0) for SW
        const pivotX = corner === 'se' ? 1.0 : 0.0;
        const pivotY = 1.0;
        this.set_pivot_point(pivotX, pivotY);

        this.connect('notify::hover', () => {
            this._hovered = this.hover;
            this.remove_all_transitions();
            if (!this.get_stage() || !this.is_mapped()) return;
            if (this._hovered && !this._active) {
                this.ease({
                    scale_x: 1.15,
                    scale_y: 1.15,
                    duration: 180,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK
                });
            } else if (!this._active) {
                this.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            }
            this.queue_repaint();
        });
        this.connect('repaint', this._draw.bind(this));
    }

    setActive(active) {
        if (this._active !== active) {
            this._active = active;
            this.remove_all_transitions();
            if (active) {
                this.ease({
                    scale_x: 1.25,
                    scale_y: 1.25,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                });
            } else {
                this.ease({
                    scale_x: this._hovered ? 1.15 : 1.0,
                    scale_y: this._hovered ? 1.15 : 1.0,
                    duration: 250,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK
                });
            }
            if (this.is_mapped()) this.queue_repaint();
        }
    }

    _draw(area) {
        // No static resize icon! The corner only illuminates when hovered or active.
        if (!this._hovered && !this._active) return;

        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.save();

        const cornerX = this._corner === 'se' ? w : 0;
        const cornerY = h;
        const radius = Math.max(w, h);

        // Radiant radial corner illumination
        const glow = new Cairo.RadialGradient(cornerX, cornerY, 0, cornerX, cornerY, radius);
        if (this._active) {
            glow.addColorStopRGBA(0.0, 0.208, 0.518, 0.894, 0.65);
            glow.addColorStopRGBA(0.5, 0.208, 0.518, 0.894, 0.28);
            glow.addColorStopRGBA(1.0, 0.208, 0.518, 0.894, 0.0);
        } else {
            glow.addColorStopRGBA(0.0, 0.208, 0.518, 0.894, 0.40);
            glow.addColorStopRGBA(0.5, 0.208, 0.518, 0.894, 0.15);
            glow.addColorStopRGBA(1.0, 0.208, 0.518, 0.894, 0.0);
        }

        cr.setSource(glow);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        // Sleek corner accent highlight arc matching the panel corner radius
        cr.setLineWidth(2.5);
        cr.setLineCap(Cairo.LineCap.ROUND);
        if (this._active) {
            cr.setSourceRGBA(0.40, 0.70, 1.0, 0.95);
        } else {
            cr.setSourceRGBA(0.40, 0.70, 1.0, 0.70);
        }

        const arcRadius = 14;
        if (this._corner === 'se') {
            cr.arc(w - arcRadius, h - arcRadius, arcRadius - 1, 0, Math.PI / 2);
        } else {
            cr.arc(arcRadius, h - arcRadius, arcRadius - 1, Math.PI / 2, Math.PI);
        }
        cr.stroke();

        cr.restore();
        cr.$dispose();
    }
});

// Round a scale maximum up to 1, 2 or 5 times a power of ten so axis labels stay stable.
function niceCeil(value) {
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    const m = value / pow;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
}

/**
 * Renders a RingBuffer it does not own; the newest sample sits on the right edge.
 * The buffer is filled by the polling engine, this widget only paints.
 */
export const Sparkline = GObject.registerClass({
    GTypeName: 'ResourcePulseSparkline',
}, class Sparkline extends St.DrawingArea {
    _init(history, height = 100, options = {}) {
        super._init({
            style_class: 'resource-pulse-sparkline',
            x_expand: true,
            height: height
        });
        this.history = history;
        this.spanLabel = '';
        this.options = Object.assign({
            showGrid: false,
            color: [0.208, 0.518, 0.894, 1.0], // Default blue
            fillOpacity: 0.12,
            lineWidth: 1.5,
            gridRows: 4,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: options.showGrid ? 12 : 2,
            paddingBottom: 0,
            maxVal: 100,        // top of a fixed scale, floor of an auto scale
            autoScale: false,
            formatValue: v => `${Math.round(v)}%`
        }, options);
        this.connect('repaint', this._draw.bind(this));
        this.connect('notify::mapped', () => this.refresh());
    }

    refresh() {
        if (this.is_mapped()) this.queue_repaint();
    }

    setSpanLabel(label) {
        if (this.spanLabel !== label) {
            this.spanLabel = label;
            this.refresh();
        }
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.save();

        const opt = this.options;
        const color = opt.color;
        const hist = this.history;
        const padL = opt.paddingLeft || 0;
        const padR = opt.paddingRight || 0;
        const padT = opt.paddingTop || 0;
        const padB = opt.paddingBottom || 0;

        const graphW = w - padL - padR;
        const graphH = h - padT - padB;

        let max = opt.maxVal;
        if (opt.autoScale) {
            const localMax = hist.max();
            if (localMax > max) max = niceCeil(localMax);
        }
        if (!(max > 0)) max = 1;

        if (opt.showGrid) {
            cr.setLineWidth(1);
            cr.setSourceRGBA(1, 1, 1, 0.08); // Grid color

            // Border
            cr.rectangle(padL, padT, graphW, graphH);
            cr.stroke();

            // Horizontal lines and labels
            const gridRows = opt.gridRows || 4;
            cr.setFontSize(10);
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);

            for (let i = 0; i <= gridRows; i++) {
                const ratio = i / gridRows;
                const y = padT + graphH - (ratio * graphH);

                if (i > 0 && i < gridRows) {
                    cr.moveTo(padL, y);
                    cr.lineTo(padL + graphW, y);
                    cr.stroke();
                }

                const lbl = opt.formatValue(ratio * max);
                const extents = cr.textExtents(lbl);
                cr.setSourceRGBA(1, 1, 1, 0.6);
                cr.moveTo(padL - extents.width - 6, y + extents.height / 2 - 1);
                cr.showText(lbl);
                cr.setSourceRGBA(1, 1, 1, 0.08); // Reset grid color
            }

            // X-axis labels: real time span on the left, "now" on the right
            cr.setSourceRGBA(1, 1, 1, 0.6);
            if (this.spanLabel) {
                const extL = cr.textExtents(this.spanLabel);
                cr.moveTo(padL, padT + graphH + extL.height + 4);
                cr.showText(this.spanLabel);
            }

            const lblRight = 'now';
            const extR = cr.textExtents(lblRight);
            cr.moveTo(padL + graphW - extR.width, padT + graphH + extR.height + 4);
            cr.showText(lblRight);
        }

        const n = hist.length;
        if (n >= 2) {
            const step = graphW / (hist.capacity - 1);
            const right = padL + graphW;
            const base = padT + graphH;
            const firstX = right - (n - 1) * step;

            // Filled area
            cr.moveTo(firstX, base);
            for (let i = 0; i < n; i++) {
                const v = Math.min(max, Math.max(0, hist.get(i)));
                cr.lineTo(firstX + i * step, base - (v / max) * graphH);
            }
            cr.lineTo(right, base);
            cr.closePath();
            cr.setSourceRGBA(color[0], color[1], color[2], opt.fillOpacity);
            cr.fill();

            // Line
            cr.setLineWidth(opt.lineWidth);
            cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
            for (let i = 0; i < n; i++) {
                const v = Math.min(max, Math.max(0, hist.get(i)));
                const x = firstX + i * step;
                const y = base - (v / max) * graphH;
                if (i === 0) cr.moveTo(x, y);
                else cr.lineTo(x, y);
            }
            cr.stroke();
        }

        cr.restore();
        cr.$dispose();
    }
});

export const ProgressBar = GObject.registerClass({
    GTypeName: 'ResourcePulseProgressBar',
}, class ProgressBar extends St.DrawingArea {
    _init(height = 6, r = 0.2, g = 0.51, b = 0.89) {
        super._init({ style_class: 'resource-pulse-progress-track', height, x_expand: true });
        this.pct = 0;
        this.r = r; this.g = g; this.b = b;
        this.connect('repaint', this._draw.bind(this));
        this.connect('notify::mapped', () => {
            if (this.is_mapped()) this.queue_repaint();
        });
    }
    setColor(r, g, b) {
        if (this.r !== r || this.g !== g || this.b !== b) {
            this.r = r; this.g = g; this.b = b;
            if (this.is_mapped()) this.queue_repaint();
        }
    }
    setPercent(pct) {
        pct = Math.max(0, Math.min(100, pct));
        if (this.pct !== pct) {
            this.pct = pct;
            if (this.is_mapped()) this.queue_repaint();
        }
    }
    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        cr.save();
        
        // Track
        cr.setSourceRGBA(0, 0, 0, 0.3);
        cr.arc(h/2, h/2, h/2, Math.PI/2, Math.PI*1.5);
        cr.arc(w - h/2, h/2, h/2, -Math.PI/2, Math.PI/2);
        cr.fill();

        // Fill
        const fillW = Math.max(h, w * (this.pct / 100));
        cr.setSourceRGBA(this.r, this.g, this.b, 1.0);
        cr.arc(h/2, h/2, h/2, Math.PI/2, Math.PI*1.5);
        cr.arc(fillW - h/2, h/2, h/2, -Math.PI/2, Math.PI/2);
        cr.fill();

        cr.restore();
        cr.$dispose();
    }
});


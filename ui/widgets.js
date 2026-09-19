import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Cairo from 'cairo';

import { hoverIndex, agoLabel } from '../lib/present.js';

/**
 * Colours a Cairo widget should paint with, taken from its CSS so light and
 * dark variants need no code: `color` for text/grid/track and the custom
 * `-rp-darken` factor (1 = unchanged) applied to series colours.
 */
function themeColors(actor) {
    const node = actor.get_theme_node();
    const c = node.get_foreground_color();
    const [found, factor] = node.lookup_double('-rp-darken', false);
    return {
        fg: [c.red / 255, c.green / 255, c.blue / 255],
        fgAlpha: c.alpha / 255,
        darken: found ? factor : 1
    };
}

/**
 * Give an actor a pointer cursor for as long as the pointer is over it.
 * GNOME Shell 50 has a per-actor cursor (Clutter.CursorType); on 45-49 the
 * display cursor is switched on hover instead. Meta.Cursor took the CSS-style
 * names (NWSE_RESIZE) in 48; before that the same cursors were SE_RESIZE and
 * SW_RESIZE.
 * @param {St.Widget} actor a widget with track_hover
 * @param {'NWSE_RESIZE'|'NESW_RESIZE'} name
 */
function setHoverCursor(actor, name) {
    if (Clutter.CursorType) {
        actor.set_cursor_type(Clutter.CursorType[name]);
        return;
    }
    const legacy = { NWSE_RESIZE: 'SE_RESIZE', NESW_RESIZE: 'SW_RESIZE' };
    const cursor = Meta.Cursor[name] ?? Meta.Cursor[legacy[name]];
    if (cursor === undefined) return;
    let shown = false;
    const update = () => {
        const want = actor.hover && actor.mapped;
        if (want === shown) return;
        shown = want;
        global.display.set_cursor(want ? cursor : Meta.Cursor.DEFAULT);
    };
    actor.connect('notify::hover', update);
    actor.connect('notify::mapped', update);
    actor.connect('destroy', () => {
        if (shown) global.display.set_cursor(Meta.Cursor.DEFAULT);
    });
}

export const ResizeHandle = GObject.registerClass({
    GTypeName: 'ResourcePulseResizeHandle',
}, class ResizeHandle extends St.DrawingArea {
    _init(corner = 'se', size = 32) {
        super._init({
            style_class: `resource-pulse-resize-handle resource-pulse-resize-handle-${corner}`,
            reactive: true,
            track_hover: true,
            can_focus: false,
            width: size,
            height: size
        });
        setHoverCursor(this, corner === 'se' ? 'NWSE_RESIZE' : 'NESW_RESIZE');
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
        this.sampleSeconds = 0;
        this._hoverX = -1;
        this.connect('repaint', this._draw.bind(this));
        this.connect('notify::mapped', () => this.refresh());
        this.connect('style-changed', () => this.refresh());

        // Readout of the sample under the pointer, on the gridded (detail)
        // graphs only; the small card graphs sit on draggable cards.
        if (this.options.showGrid) {
            this.reactive = true;
            this.connect('motion-event', (actor, event) => {
                const [stageX, stageY] = event.get_coords();
                const [ok, x] = this.transform_stage_point(stageX, stageY);
                this._setHoverX(ok ? x : -1);
                return Clutter.EVENT_PROPAGATE;
            });
            this.connect('leave-event', () => {
                this._setHoverX(-1);
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    _setHoverX(x) {
        if (this._hoverX !== x) {
            this._hoverX = x;
            this.refresh();
        }
    }

    setSampleSeconds(seconds) {
        this.sampleSeconds = seconds;
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

        // Axis and grid take the themed text colour; series colours are
        // darkened by the theme's -rp-darken factor on light backgrounds.
        const { fg, darken } = themeColors(this);
        const gridAlpha = darken < 1 ? 0.14 : 0.08;
        const color = [opt.color[0] * darken, opt.color[1] * darken, opt.color[2] * darken, opt.color[3]];

        if (opt.showGrid) {
            cr.setLineWidth(1);
            cr.setSourceRGBA(fg[0], fg[1], fg[2], gridAlpha);

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
                cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.65);
                cr.moveTo(padL - extents.width - 6, y + extents.height / 2 - 1);
                cr.showText(lbl);
                cr.setSourceRGBA(fg[0], fg[1], fg[2], gridAlpha);
            }

            // X-axis labels: real time span on the left, "now" on the right
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.65);
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

        const hover = this._hoverX >= 0 ? hoverIndex(this._hoverX, padL, graphW, hist.capacity, n) : -1;
        if (hover >= 0) {
            const step = graphW / (hist.capacity - 1);
            const raw = hist.get(hover);
            const x = padL + graphW - (n - 1 - hover) * step;
            const y = padT + graphH - (Math.min(max, Math.max(0, raw)) / max) * graphH;

            cr.setLineWidth(1);
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.35);
            cr.moveTo(x, padT);
            cr.lineTo(x, padT + graphH);
            cr.stroke();
            cr.setSourceRGBA(color[0], color[1], color[2], 1);
            cr.arc(x, y, 3, 0, 2 * Math.PI);
            cr.fill();

            const ago = this.sampleSeconds > 0 ? ` · ${agoLabel(n - 1 - hover, this.sampleSeconds)}` : '';
            const text = `${opt.formatValue(raw)}${ago}`;
            cr.setFontSize(10);
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            const ext = cr.textExtents(text);
            const boxW = ext.width + 10;
            const boxH = ext.height + 8;
            // Keep the label inside the graph, flipping to the left of the cursor near the right edge.
            let bx = x + 8;
            if (bx + boxW > padL + graphW) bx = x - 8 - boxW;
            if (bx < padL) bx = padL;
            const by = padT + 2;
            cr.setSourceRGBA(1 - fg[0], 1 - fg[1], 1 - fg[2], 0.85);
            cr.rectangle(bx, by, boxW, boxH);
            cr.fill();
            cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.95);
            cr.moveTo(bx + 5, by + boxH - 4);
            cr.showText(text);
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
        this.connect('style-changed', () => {
            if (this.is_mapped()) this.queue_repaint();
        });
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
        const { fg, fgAlpha, darken } = themeColors(this);
        cr.setSourceRGBA(fg[0], fg[1], fg[2], fgAlpha);
        cr.arc(h/2, h/2, h/2, Math.PI/2, Math.PI*1.5);
        cr.arc(w - h/2, h/2, h/2, -Math.PI/2, Math.PI/2);
        cr.fill();

        // Fill
        const fillW = Math.max(h, w * (this.pct / 100));
        cr.setSourceRGBA(this.r * darken, this.g * darken, this.b * darken, 1.0);
        cr.arc(h/2, h/2, h/2, Math.PI/2, Math.PI*1.5);
        cr.arc(fillW - h/2, h/2, h/2, -Math.PI/2, Math.PI/2);
        cr.fill();

        cr.restore();
        cr.$dispose();
    }
});


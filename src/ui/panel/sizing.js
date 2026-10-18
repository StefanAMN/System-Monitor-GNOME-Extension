// The panel's size: default and stored dimensions, and the corner resize handles.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ResizeHandle } from './widgets.js';

export class SizingMethods {
    _updateMenuDimensions() {
        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.currentMonitor || { width: 1920, height: 1080 };
        const screenW = monitor.width || (global.screen_width || 1920);
        const screenH = monitor.height || (global.screen_height || 1080);

        const savedW = this._settings?.get_int('menu-custom-width') || 0;
        const savedH = this._settings?.get_int('menu-custom-height') || 0;

        const defaultWidth = Math.min(Math.max(380, Math.round(screenW * 0.28)), 600);
        const defaultMaxHeight = Math.max(380, Math.round(screenH * 0.80));
        this._defaultMaxHeight = defaultMaxHeight;

        if (savedW > 0 && savedH > 0) {
            const minW = 360;
            const maxW = Math.min(Math.round(screenW * 0.90), 1200);
            const minH = 320;
            const maxH = Math.min(Math.round(screenH * 0.90), screenH - 60);
            const w = Math.max(minW, Math.min(maxW, savedW));
            const h = Math.max(minH, Math.min(maxH, savedH));
            this._applyDimensions(w, h);
        } else {
            this._currentWidth = defaultWidth;
            this._currentHeight = 0;
            if (this._menuViewport) {
                this._menuViewport.width = defaultWidth;
                this._menuViewport.height = -1;
                this._menuViewport.style = `width: ${defaultWidth}px; min-width: ${defaultWidth}px; max-width: ${defaultWidth}px;`;
            }
            if (this._scrollView) {
                this._scrollView.width = defaultWidth;
                this._scrollView.height = -1;
                this._scrollView.style = `width: ${defaultWidth}px; max-height: ${defaultMaxHeight}px;`;
            }
            if (this._popupStack) {
                this._popupStack.width = defaultWidth;
                this._popupStack.height = -1;
                this._popupStack.style = `width: ${defaultWidth}px;`;
            }
            if (this._menuSection) {
                this._menuSection.width = defaultWidth;
                this._menuSection.height = -1;
                this._menuSection.style = `width: ${defaultWidth}px;`;
            }
        }
    }

    _applyResizeDelta(corner, deltaX, deltaY, startW, startH) {
        const monitor = Main.layoutManager.primaryMonitor || Main.layoutManager.currentMonitor || { width: 1920, height: 1080 };
        const screenW = monitor.width || (global.screen_width || 1920);
        const screenH = monitor.height || (global.screen_height || 1080);
        const minW = 360;
        const maxW = Math.min(Math.round(screenW * 0.90), 1200);
        const minH = 320;
        const maxH = Math.min(Math.round(screenH * 0.90), screenH - 60);

        let newW = startW;
        let newH = startH;

        if (corner === 'se') {
            newW = startW + deltaX;
            newH = startH + deltaY;
        } else if (corner === 'sw') {
            newW = startW - deltaX;
            newH = startH + deltaY;
        }

        newW = Math.max(minW, Math.min(maxW, Math.round(newW)));
        newH = Math.max(minH, Math.min(maxH, Math.round(newH)));

        this._applyDimensions(newW, newH);
    }

    _applyDimensions(w, h) {
        this._currentWidth = w;
        this._currentHeight = h;
        if (this._menuViewport) {
            this._menuViewport.width = w;
            this._menuViewport.style = `width: ${w}px; min-width: ${w}px; max-width: ${w}px; min-height: ${h}px;`;
        }
        if (this._scrollView) {
            this._scrollView.width = w;
            this._scrollView.height = h;
            this._scrollView.style = `width: ${w}px; height: ${h}px; min-height: ${h}px; max-height: ${h}px;`;
        }
        if (this._popupStack) {
            this._popupStack.width = w;
            this._popupStack.height = h;
            this._popupStack.style = `width: ${w}px; height: ${h}px; min-width: ${w}px; min-height: ${h}px;`;
        }
        if (this._menuSection) {
            this._menuSection.width = w;
            this._menuSection.height = h;
            this._menuSection.style = `width: ${w}px; height: ${h}px; min-width: ${w}px; min-height: ${h}px;`;
        }
    }

    /** Settings changed elsewhere (Reset in the preferences window): apply once, after both keys. */
    _queueDimensionsUpdate() {
        if (this._sizeIdleId || this._activeResizeCorner) return;
        this._sizeIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._sizeIdleId = 0;
            this._updateMenuDimensions();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveCustomDimensions() {
        if (this._settings && this._currentWidth > 0 && this._currentHeight > 0) {
            this._settings.set_int('menu-custom-width', this._currentWidth);
            this._settings.set_int('menu-custom-height', this._currentHeight);
        }
    }

    _resetMenuDimensions() {
        if (this._settings) {
            this._settings.set_int('menu-custom-width', 0);
            this._settings.set_int('menu-custom-height', 0);
        }
        this._updateMenuDimensions();
    }

    _buildCornerResizeHandles() {
        this._resizeHandles = {};
        const corners = [
            { id: 'se', xAlign: Clutter.ActorAlign.END,   yAlign: Clutter.ActorAlign.END, size: 32 },
            { id: 'sw', xAlign: Clutter.ActorAlign.START, yAlign: Clutter.ActorAlign.END, size: 32 }
        ];

        corners.forEach(c => {
            const handle = new ResizeHandle(c.id, c.size);
            handle.x_align = c.xAlign;
            handle.y_align = c.yAlign;
            handle.x_expand = true;
            handle.y_expand = true;

            let isDragging = false;
            let startX = 0, startY = 0;
            let startWidth = 0, startHeight = 0;
            let lastClickTime = 0;

            const startDrag = (event) => {
                const now = event.get_time();
                if (now - lastClickTime < 350) {
                    handle.remove_all_transitions();
                    handle.ease({
                        scale_x: 0.85,
                        scale_y: 0.85,
                        duration: 90,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => {
                            handle.ease({
                                scale_x: 1.0,
                                scale_y: 1.0,
                                duration: 250,
                                mode: Clutter.AnimationMode.EASE_OUT_BACK
                            });
                        }
                    });
                    this._resetMenuDimensions();
                    lastClickTime = 0;
                    return Clutter.EVENT_STOP;
                }
                lastClickTime = now;

                const [x, y] = event.get_coords();
                startX = x;
                startY = y;

                // Safely read real rendered allocation size
                let curW = (this._currentWidth && this._currentWidth > 100) ? this._currentWidth : 0;
                let curH = (this._currentHeight && this._currentHeight > 100) ? this._currentHeight : 0;

                if (!curW || !curH) {
                    if (this._menuSection && this._menuSection.has_allocation()) {
                        const box = this._menuSection.get_allocation_box();
                        if (box) {
                            if (!curW && box.get_width() > 100) curW = box.get_width();
                            if (!curH && box.get_height() > 100) curH = box.get_height();
                        }
                    }
                    if (!curW || !curH) {
                        if (this._scrollView && this._scrollView.has_allocation()) {
                            const box = this._scrollView.get_allocation_box();
                            if (box) {
                                if (!curW && box.get_width() > 100) curW = box.get_width();
                                if (!curH && box.get_height() > 100) curH = box.get_height();
                            }
                        }
                    }
                    if (!curW || !curH) {
                        if (this._menuContainer && this._menuContainer.has_allocation()) {
                            const box = this._menuContainer.get_allocation_box();
                            if (box) {
                                if (!curW && box.get_width() > 100) curW = box.get_width();
                                if (!curH && box.get_height() > 100) curH = box.get_height();
                            }
                        }
                    }
                }
                if (!curW) curW = 420;
                if (!curH) curH = 500;

                startWidth = Math.round(curW);
                startHeight = Math.round(curH);

                isDragging = true;
                this._activeResizeCorner = c.id;
                this._dragGrab = global.stage.grab(handle);
                handle.setActive(true);
                return Clutter.EVENT_STOP;
            };

            handle.connect('button-press-event', (actor, event) => {
                if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
                return startDrag(event);
            });

            handle.connect('touch-event', (actor, event) => {
                if (event.type() === Clutter.EventType.TOUCH_BEGIN) {
                    return startDrag(event);
                }
                return Clutter.EVENT_PROPAGATE;
            });

            const finishDrag = () => {
                if (!isDragging) return Clutter.EVENT_PROPAGATE;
                if (this._dragGrab) {
                    this._dragGrab.dismiss();
                    this._dragGrab = null;
                }
                isDragging = false;
                this._activeResizeCorner = null;
                handle.setActive(false);
                this._saveCustomDimensions();
                return Clutter.EVENT_STOP;
            };

            handle.connect('button-release-event', finishDrag);

            handle.connect('event', (actor, event) => {
                if (!isDragging) return Clutter.EVENT_PROPAGATE;
                const type = event.type();
                if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                    const [currX, currY] = event.get_coords();
                    const deltaX = currX - startX;
                    const deltaY = currY - startY;
                    this._applyResizeDelta(c.id, deltaX, deltaY, startWidth, startHeight);
                    return Clutter.EVENT_STOP;
                } else if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END || type === Clutter.EventType.TOUCH_CANCEL) {
                    return finishDrag();
                }
                return Clutter.EVENT_PROPAGATE;
            });

            this._resizeHandles[c.id] = handle;
            this._popupStack.add_child(handle);
        });
    }
}

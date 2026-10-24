// The overview page: metric cards and reordering them by dragging.
// Methods of the extension (installed by extension.js); `this` is the extension.
import GLib from 'gi://GLib';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import { ProgressBar } from './widgets.js';
import { CARD_SLOT_HEIGHT } from './constants.js';
import { _ } from '../../lib/common/i18n.js';

export class OverviewMethods {
    _sanitizeCardOrder(list) {
        const defaultOrder = ['cpu', 'memory', 'battery', 'disk', 'network', 'thermal', 'power', 'gpu'];
        const result = [];
        if (Array.isArray(list)) {
            for (const key of list) {
                if (defaultOrder.includes(key) && !result.includes(key)) {
                    result.push(key);
                }
            }
        }
        for (const key of defaultOrder) {
            if (!result.includes(key)) {
                result.push(key);
            }
        }
        return result;
    }

    _saveCardOrder() {
        if (!this._settings || !this._cardOrder) return;
        this._isInternalOrderUpdate = true;
        try {
            this._settings.set_strv('overview-card-order', this._cardOrder);

            const pinned = this._pinnedMetrics();
            if (pinned && pinned.length > 1) {
                pinned.sort((a, b) => this._cardOrder.indexOf(a) - this._cardOrder.indexOf(b));
                this._settings.set_strv('pinned-metrics', pinned);
            }
        } finally {
            this._isInternalOrderUpdate = false;
        }
    }

    _onCardOrderChanged() {
        if (this._isInternalOrderUpdate) return;
        const saved = this._getStrv('overview-card-order', null);
        if (saved && saved.length > 0) {
            this._cardOrder = this._sanitizeCardOrder(saved);
            this._attachCardsToGrid(this._cardOrder);
        }
    }

    _buildMetricCard({ key, label, color, placeholder = '--', spark = null }) {
        const [r, g, b] = color;
        const box = new St.BoxLayout({
            style_class: `resource-pulse-metric-card tint-${key}`,
            vertical: true, reactive: true, can_focus: true, x_expand: true,
            // Named with its value by _nameValues (a11y.js).
            accessible_name: label, accessible_role: Atk.Role.PUSH_BUTTON
        });

        const head = new St.BoxLayout({ style: 'spacing: 6px; margin-bottom: 2px;', y_align: Clutter.ActorAlign.CENTER });
        head.add_child(this._setMetricIcon(new St.Icon({ style_class: `rp-c-${key}`, style: 'icon-size: 16px;' }), key));
        head.add_child(new St.Label({ text: label, style_class: 'rp-fg-dim', style: 'font-size: 0.9em; font-weight: 600;', x_expand: true }));
        head.add_child(new St.Icon({ icon_name: 'view-grid-symbolic', style_class: 'rp-grip', style: 'icon-size: 13px;' }));
        box.add_child(head);

        const valueLabel = new St.Label({ text: placeholder, style_class: 'rp-fg', style: 'font-size: 1.7em; font-weight: bold;' });
        box.add_child(valueLabel);

        // The slot keeps its height whether it holds a graph, a line of
        // text or (a metric with nothing to add) nothing visible at all.
        const slot = new St.Bin({ style_class: 'rp-card-slot', x_expand: true, height: CARD_SLOT_HEIGHT });
        let sparkline = null;
        let subLabel = null;
        if (spark) {
            sparkline = this._newSparkline(spark, CARD_SLOT_HEIGHT, { color: [r, g, b, 1.0], fillOpacity: 0.15 });
            sparkline.x_expand = true;
            slot.set_child(sparkline);
        } else {
            // x_expand: a bin centres a child that does not expand.
            subLabel = new St.Label({
                text: '', style_class: 'rp-fg-muted rp-card-detail',
                x_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER
            });
            slot.set_child(subLabel);
        }
        box.add_child(slot);

        const pbar = new ProgressBar(4, r, g, b);
        box.add_child(pbar);

        this._makeCardDraggable(box, key);
        return { box, title: label, valueLabel, subLabel, pbar, spark: sparkline };
    }

    _attachCardsToGrid(order) {
        if (!this._overviewGrid || !this._overviewGridLayout || !this._summaryCards) return;

        for (const key of Object.keys(this._summaryCards)) {
            const box = this._summaryCards[key]?.box;
            if (box && box.get_parent() === this._overviewGrid) {
                this._overviewGrid.remove_child(box);
            }
        }

        order.forEach((key, idx) => {
            const cardObj = this._summaryCards[key];
            if (cardObj?.box) {
                const col = idx % 2;
                const row = Math.floor(idx / 2);
                this._overviewGridLayout.attach(cardObj.box, col, row, 1, 1);
            }
        });
    }

    _handleCardDragMotion(draggedKey, cardCenterX, cardCenterY) {
        if (!this._cardOrder || !this._summaryCards || !this._overviewGrid) return;
        const currentOrder = this._cardOrder;
        const currentIndex = currentOrder.indexOf(draggedKey);
        if (currentIndex === -1) return;

        const [gridX, gridY] = this._overviewGrid.get_transformed_position();
        const [gridW, gridH] = this._overviewGrid.get_transformed_size();

        const sampleCard = this._summaryCards[draggedKey]?.box;
        const [cardW, cardH] = sampleCard ? sampleCard.get_size() : [0, 0];

        const stepX = (gridW > cardW && cardW > 0) ? (gridW - cardW) : (gridW > 0 ? gridW / 2 : 190);
        const stepY = (gridH > cardH && cardH > 0) ? (gridH - cardH) / 3 : (gridH > 0 ? gridH / 4 : 95);

        let targetIndex = currentIndex;
        let minDistance = Infinity;

        for (let i = 0; i < currentOrder.length; i++) {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const slotCenterX = gridX + col * stepX + (cardW > 0 ? cardW / 2 : stepX / 2);
            const slotCenterY = gridY + row * stepY + (cardH > 0 ? cardH / 2 : stepY / 2);
            const dist = Math.hypot(cardCenterX - slotCenterX, cardCenterY - slotCenterY);
            if (dist < minDistance) {
                minDistance = dist;
                targetIndex = i;
            }
        }

        if (this._previewTargetIndex === targetIndex) return;
        this._previewTargetIndex = targetIndex;

        const previewOrder = [...currentOrder];
        previewOrder.splice(currentIndex, 1);
        previewOrder.splice(targetIndex, 0, draggedKey);
        this._pendingPreviewOrder = previewOrder;

        for (let i = 0; i < currentOrder.length; i++) {
            const k = currentOrder[i];
            if (k === draggedKey) continue;
            const box = this._summaryCards[k]?.box;
            if (!box) continue;

            const previewIdx = previewOrder.indexOf(k);
            const deltaCol = (previewIdx % 2) - (i % 2);
            const deltaRow = Math.floor(previewIdx / 2) - Math.floor(i / 2);

            const targetTx = deltaCol * stepX;
            const targetTy = deltaRow * stepY;

            box.ease({
                translation_x: targetTx,
                translation_y: targetTy,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });
        }
    }

    _makeCardDraggable(card, key) {
        if (!card) return;
        card.set_pivot_point(0.5, 0.5);
        card.reactive = true;
        card.track_hover = true;

        let isCandidate = false;
        let isDragging = false;
        let startX = 0, startY = 0;
        let holdTimerId = null;

        let cardOrigX = 0, cardOrigY = 0;
        let cardW = 0, cardH = 0;
        let currentDeltaX = 0, currentDeltaY = 0;

        card.connect('enter-event', () => {
            if (!this._activeCardDrag) {
                card.add_style_class_name('rp-hover');
            }
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('leave-event', () => {
            if (!this._activeCardDrag) {
                card.remove_style_class_name('rp-hover');
                if (!isDragging) {
                    card.ease({
                        scale_x: 1.0,
                        scale_y: 1.0,
                        duration: 120,
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                    });
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        const cancelHoldTimer = () => {
            if (holdTimerId) {
                if (this._dragHoldTimerId === holdTimerId)
                    this._dragHoldTimerId = null;
                GLib.source_remove(holdTimerId);
                holdTimerId = null;
            }
        };

        const startDrag = () => {
            if (isDragging) return;
            cancelHoldTimer();
            isDragging = true;
            isCandidate = false;
            this._activeCardDrag = key;
            this._draggedCardActor = card;
            this._cardDragGrab = global.stage.grab(card);

            // Normalize transitions and get unscaled layout coordinates
            card.remove_all_transitions();
            card.remove_style_class_name('resource-pulse-metric-card-snapping');
            card.set_scale(1.0, 1.0);
            card.set_translation(0, 0, 0);
            [cardOrigX, cardOrigY] = card.get_transformed_position();
            [cardW, cardH] = card.get_transformed_size();
            currentDeltaX = 0;
            currentDeltaY = 0;

            // Safety net: stage-level button release listener
            if (!this._stageReleaseId) {
                this._stageReleaseId = global.stage.connect('button-release-event', () => {
                    if (isDragging) {
                        finishDrag(true);
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                });
            }

            card.add_style_class_name('resource-pulse-metric-card-dragging');
            if (card.get_parent()) {
                card.get_parent().set_child_above_sibling(card, null);
            }
            card.ease({
                scale_x: 1.04,
                scale_y: 1.04,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });
        };

        const finishDrag = (wasDrag) => {
            cancelHoldTimer();
            if (this._stageReleaseId) {
                global.stage.disconnect(this._stageReleaseId);
                this._stageReleaseId = null;
            }

            if (wasDrag && isDragging) {
                if (this._cardDragGrab) {
                    this._cardDragGrab.dismiss();
                    this._cardDragGrab = null;
                }
                isDragging = false;
                this._activeCardDrag = null;
                this._draggedCardActor = null;

                const oldOrder = this._cardOrder || [];
                const origIndex = oldOrder.indexOf(key);
                const newOrder = this._pendingPreviewOrder || oldOrder;
                const targetIndex = newOrder.indexOf(key);

                this._cardOrder = newOrder;
                this._pendingPreviewOrder = null;
                this._previewTargetIndex = null;

                const [gridW, gridH] = this._overviewGrid ? this._overviewGrid.get_transformed_size() : [0, 0];
                const stepX = (gridW > cardW && cardW > 0) ? (gridW - cardW) : (gridW > 0 ? gridW / 2 : 190);
                const stepY = (gridH > cardH && cardH > 0) ? (gridH - cardH) / 3 : (gridH > 0 ? gridH / 4 : 95);

                const origCol = origIndex >= 0 ? origIndex % 2 : 0;
                const origRow = origIndex >= 0 ? Math.floor(origIndex / 2) : 0;
                const targetCol = targetIndex >= 0 ? targetIndex % 2 : 0;
                const targetRow = targetIndex >= 0 ? Math.floor(targetIndex / 2) : 0;

                const slotShiftX = (targetCol - origCol) * stepX;
                const slotShiftY = (targetRow - origRow) * stepY;

                // Relative to the new slot, compute the card's current visual offset to prevent jumping
                const initialSnapTx = currentDeltaX - slotShiftX;
                const initialSnapTy = currentDeltaY - slotShiftY;

                // For all other cards, calculate their visual offset relative to their new slot
                const otherCardOffsets = {};
                for (const k of Object.keys(this._summaryCards)) {
                    if (k === key) continue;
                    const b = this._summaryCards[k]?.box;
                    if (!b) continue;

                    const oldIdx = oldOrder.indexOf(k);
                    const newIdx = this._cardOrder.indexOf(k);
                    if (oldIdx !== -1 && newIdx !== -1) {
                        const shiftCol = (newIdx % 2) - (oldIdx % 2);
                        const shiftRow = Math.floor(newIdx / 2) - Math.floor(oldIdx / 2);
                        const expectedTx = shiftCol * stepX;
                        const expectedTy = shiftRow * stepY;
                        otherCardOffsets[k] = {
                            tx: b.translation_x - expectedTx,
                            ty: b.translation_y - expectedTy
                        };
                    } else {
                        otherCardOffsets[k] = { tx: 0, ty: 0 };
                    }
                    b.remove_all_transitions();
                }

                // Reattach all cards to grid in final order
                this._attachCardsToGrid(this._cardOrder);

                // Now ease all other cards seamlessly into (0, 0)
                for (const k of Object.keys(this._summaryCards)) {
                    if (k === key) continue;
                    const b = this._summaryCards[k]?.box;
                    const offset = otherCardOffsets[k];
                    if (b && offset) {
                        b.set_translation(offset.tx, offset.ty, 0);
                        if (Math.abs(offset.tx) > 0.5 || Math.abs(offset.ty) > 0.5) {
                            b.ease({
                                translation_x: 0,
                                translation_y: 0,
                                duration: 360,
                                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
                            });
                        } else {
                            b.set_translation(0, 0, 0);
                        }
                    }
                }

                // Transition dragged card styling to snapping state
                card.remove_style_class_name('resource-pulse-metric-card-dragging');
                card.add_style_class_name('resource-pulse-metric-card-snapping');

                // Seamless snap ease into destination slot with silky cubic deceleration
                card.remove_all_transitions();
                card.set_translation(initialSnapTx, initialSnapTy, 0);
                card.ease({
                    translation_x: 0,
                    translation_y: 0,
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 360,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    onComplete: () => {
                        card.remove_style_class_name('resource-pulse-metric-card-snapping');
                        card.remove_style_class_name('rp-hover');
                    }
                });

                // Finalize order in GSettings
                this._saveCardOrder();
                return Clutter.EVENT_STOP;
            }

            isDragging = false;
            isCandidate = false;
            return Clutter.EVENT_PROPAGATE;
        };

        // Keyboard: a focused card shows the hover highlight and opens its
        // details page on Return or Space, as a click does.
        card.connect('key-focus-in', () => card.add_style_class_name('rp-hover'));
        card.connect('key-focus-out', () => {
            if (!card.hover) card.remove_style_class_name('rp-hover');
        });
        card.connect('key-press-event', (actor, event) => {
            const sym = event.get_key_symbol();
            if (sym !== Clutter.KEY_Return && sym !== Clutter.KEY_KP_Enter && sym !== Clutter.KEY_space)
                return Clutter.EVENT_PROPAGATE;
            this._activeTab = key;
            this._updateTabVisibility();
            return Clutter.EVENT_STOP;
        });

        card.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            startX = x;
            startY = y;
            isCandidate = true;
            isDragging = false;

            card.ease({
                scale_x: 0.98,
                scale_y: 0.98,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });

            cancelHoldTimer();
            holdTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                holdTimerId = null;
                this._dragHoldTimerId = null;
                if (isCandidate && !isDragging) {
                    startDrag();
                }
                return GLib.SOURCE_REMOVE;
            });
            this._dragHoldTimerId = holdTimerId;

            return Clutter.EVENT_STOP;
        });

        card.connect('button-release-event', (actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            cancelHoldTimer();

            if (isDragging) {
                return finishDrag(true);
            }

            if (isCandidate) {
                isCandidate = false;
                card.ease({
                    scale_x: 1.0,
                    scale_y: 1.0,
                    duration: 100,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
                // Quick click -> open details page
                this._activeTab = key;
                this._updateTabVisibility();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('event', (actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.MOTION || type === Clutter.EventType.TOUCH_UPDATE) {
                if (type === Clutter.EventType.MOTION) {
                    const state = event.get_state();
                    // If button 1 is no longer held, finish drag immediately
                    if ((state & Clutter.ModifierType.BUTTON1_MASK) === 0) {
                        if (isDragging) {
                            return finishDrag(true);
                        }
                        cancelHoldTimer();
                        isCandidate = false;
                        return Clutter.EVENT_PROPAGATE;
                    }
                }

                const [currX, currY] = event.get_coords();
                const dist = Math.hypot(currX - startX, currY - startY);

                if (isCandidate && !isDragging && dist > 8) {
                    startDrag();
                }

                if (isDragging) {
                    const rawDeltaX = currX - startX;
                    const rawDeltaY = currY - startY;

                    let clampedDeltaX = rawDeltaX;
                    let clampedDeltaY = rawDeltaY;

                    if (this._overviewGrid) {
                        const [gx, gy] = this._overviewGrid.get_transformed_position();
                        const [gw, gh] = this._overviewGrid.get_transformed_size();
                        if (gw > 0 && gh > 0 && cardW > 0 && cardH > 0) {
                            const minDeltaX = gx - cardOrigX;
                            const maxDeltaX = Math.max(minDeltaX, (gx + gw - cardW) - cardOrigX);
                            const minDeltaY = gy - cardOrigY;
                            const maxDeltaY = Math.max(minDeltaY, (gy + gh - cardH) - cardOrigY);

                            clampedDeltaX = Math.max(minDeltaX, Math.min(rawDeltaX, maxDeltaX));
                            clampedDeltaY = Math.max(minDeltaY, Math.min(rawDeltaY, maxDeltaY));
                        }
                    }

                    currentDeltaX = clampedDeltaX;
                    currentDeltaY = clampedDeltaY;
                    card.set_translation(clampedDeltaX, clampedDeltaY, 0);

                    // Compute center of clamped card for slot targeting
                    const cardCenterX = cardOrigX + clampedDeltaX + (cardW > 0 ? cardW / 2 : 0);
                    const cardCenterY = cardOrigY + clampedDeltaY + (cardH > 0 ? cardH / 2 : 0);

                    // Find hover target slot among cards
                    this._handleCardDragMotion(key, cardCenterX, cardCenterY);
                    return Clutter.EVENT_STOP;
                }
            } else if (type === Clutter.EventType.TOUCH_END ||
                       type === Clutter.EventType.TOUCH_CANCEL) {
                // BUTTON_RELEASE is deliberately not handled here: Clutter
                // emits 'event' before 'button-release-event', so clearing
                // isCandidate at this point made every quick click a no-op.
                if (isDragging) {
                    return finishDrag(true);
                }
                cancelHoldTimer();
                isCandidate = false;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _addCardInteractions(card) {
        if (!card) return;
        card.set_pivot_point(0.5, 0.5);

        card.connect('enter-event', () => {
            card.add_style_class_name('rp-hover');
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('leave-event', () => {
            card.remove_style_class_name('rp-hover');
            card.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('button-press-event', () => {
            card.ease({
                scale_x: 0.98,
                scale_y: 0.98,
                duration: 80,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });

        card.connect('button-release-event', () => {
            card.ease({
                scale_x: 1.0,
                scale_y: 1.0,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD
            });
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _buildOverview() {
        this._overviewPage = new St.BoxLayout({ vertical: true, x_expand: true, y_expand: true });

        // Header container (System Overview, Refresh, Menu)
        const headerBox = new St.BoxLayout({ style: 'margin-bottom: 12px;', y_align: Clutter.ActorAlign.CENTER });
        const titleLbl = new St.Label({ text: _('System Overview'), style_class: 'rp-fg', style: 'font-size: 1.3em; font-weight: bold;', x_expand: true });
        headerBox.add_child(titleLbl);

        const refreshBtn = new St.Button({ style_class: 'rp-chip-bg', style: 'border-radius: 99px; padding: 6px;', reactive: true, accessible_name: _('Refresh now') });
        const refreshIcon = new St.Icon({ icon_name: 'view-refresh-symbolic', style_class: 'rp-fg', style: 'icon-size: 16px;' });
        refreshIcon.set_pivot_point(0.5, 0.5);
        refreshBtn.add_child(refreshIcon);
        refreshBtn.connect('clicked', () => {
            this._poll();
            refreshIcon.rotation_angle_z = 0;
            refreshIcon.ease({
                rotation_angle_z: 360,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });
        });

        const menuBtn = new St.Button({ style_class: 'rp-chip-bg', style: 'border-radius: 99px; padding: 6px; margin-left: 6px;', reactive: true, accessible_name: _('Settings') });
        const menuIcon = new St.Icon({ icon_name: 'view-more-symbolic', style_class: 'rp-fg', style: 'icon-size: 16px;' });
        menuIcon.set_pivot_point(0.5, 0.5);
        menuBtn.add_child(menuIcon);
        // All settings live in the preferences window.
        menuBtn.connect('clicked', () => this._openDetailsWindow('settings'));
        this._overviewMenuBtn = menuBtn;
        this._overviewMenuIcon = menuIcon;

        this._addClickAnimations(refreshBtn);
        headerBox.add_child(refreshBtn);
        this._addClickAnimations(menuBtn);
        headerBox.add_child(menuBtn);
        this._overviewPage.add_child(headerBox);

        // Unified 2-Column Reorderable Card Grid
        const grid = new Clutter.GridLayout({ column_homogeneous: true, row_homogeneous: false });
        this._overviewGridLayout = grid;
        this._overviewGrid = new St.Widget({ layout_manager: grid, style_class: 'resource-pulse-overview-grid', x_expand: true });
        this._overviewPage.add_child(this._overviewGrid);

        this._summaryCards = {};

        // One template for all eight cards, so the grid is even: name,
        // value, a slot of fixed height (trend graph or one line of detail)
        // and a bar. `spark` names the history a card's trend graph draws.
        const cards = [
            { key: 'cpu', label: _('CPU'), color: [0.208, 0.518, 0.894], placeholder: '--%', spark: 'cpu' },
            { key: 'memory', label: _('Memory'), color: [0.569, 0.255, 0.675], placeholder: '--%', spark: 'mem' },
            { key: 'battery', label: _('Battery'), color: [0.18, 0.76, 0.494], placeholder: '--%' },
            { key: 'disk', label: _('Disk'), color: [0.96, 0.83, 0.18] },
            { key: 'network', label: _('Network'), color: [0.88, 0.11, 0.14] },
            { key: 'thermal', label: _('Thermal'), color: [1.0, 0.47, 0.0] },
            { key: 'power', label: _('Power'), color: [0.96, 0.83, 0.18] },
            { key: 'gpu', label: _('GPU'), color: [0.2, 0.82, 0.48] }
        ];
        for (const card of cards) this._summaryCards[card.key] = this._buildMetricCard(card);
        // The battery card's detail line is its charging state.
        this._summaryCards.battery.statusLbl = this._summaryCards.battery.subLabel;

        // Initialize and attach cards according to saved/default order
        this._cardOrder = this._sanitizeCardOrder(this._getStrv('overview-card-order', null));
        this._attachCardsToGrid(this._cardOrder);

        // Hardware Info Card
        this._hwCard = new St.BoxLayout({ style_class: 'rp-surface', style: 'border-radius: 12px; padding: 12px; margin-top: 10px;', vertical: true, x_expand: true });

        const hwTop = new St.BoxLayout({ style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });

        // Dynamic Chip badge
        this._chipBox = new St.BoxLayout({ style: 'background-color: #0e5fa6; border-radius: 6px; padding: 6px 10px;', vertical: true });
        this._chipLabel1 = new St.Label({ text: 'intel', style: 'font-size: 0.65em; color: #a0c8f0; font-weight: 300;' });
        this._chipLabel2 = new St.Label({ text: 'CORE', style: 'font-size: 0.9em; color: #ffffff; font-weight: bold;' });
        this._chipLabel3 = new St.Label({ text: 'i5', style: 'font-size: 1.1em; color: #5bc3ff; font-weight: bold;' });
        this._chipBox.add_child(this._chipLabel1);
        this._chipBox.add_child(this._chipLabel2);
        this._chipBox.add_child(this._chipLabel3);
        hwTop.add_child(this._chipBox);

        const hwDesc = new St.BoxLayout({ vertical: true, style: 'spacing: 4px;', x_expand: true });
        this._hwName = new St.Label({ text: _('Intel Processor'), style_class: 'rp-fg', style: 'font-size: 1.05em; font-weight: bold;' });
        this._hwStats = new St.Label({ text: _('Cores & Threads'), style_class: 'rp-fg-dim', style: 'font-size: 0.8em;' });
        hwDesc.add_child(this._hwName);
        hwDesc.add_child(this._hwStats);
        hwTop.add_child(hwDesc);
        this._hwCard.add_child(hwTop);

        // Hardware Sub Stats (Uptime, Load Average, OS)
        const hwStatsRow = new St.BoxLayout({ style: 'margin-top: 10px; spacing: 16px;', x_expand: true });

        const uptimeBox = new St.BoxLayout({ vertical: true });
        uptimeBox.add_child(new St.Label({ text: _('Uptime'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._hwUptimeVal = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 1.0em; font-weight: bold;' });
        uptimeBox.add_child(this._hwUptimeVal);

        const loadBox = new St.BoxLayout({ vertical: true, x_expand: true });
        loadBox.add_child(new St.Label({ text: _('Load Average'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._hwLoadVal = new St.Label({ text: '--', style_class: 'rp-fg', style: 'font-size: 1.0em; font-weight: bold;' });
        loadBox.add_child(this._hwLoadVal);

        const osBox = new St.BoxLayout({ vertical: true });
        osBox.add_child(new St.Label({ text: _('OS'), style_class: 'rp-fg-dim', style: 'font-size: 0.75em;' }));
        this._hwOsVal = new St.Label({ text: `GNOME ${Config.PACKAGE_VERSION.split('.')[0]}`, style_class: 'rp-fg', style: 'font-size: 1.0em; font-weight: bold;' });
        osBox.add_child(this._hwOsVal);

        hwStatsRow.add_child(uptimeBox);
        hwStatsRow.add_child(loadBox);
        hwStatsRow.add_child(osBox);
        this._hwCard.add_child(hwStatsRow);

        this._addCardInteractions(this._hwCard);
        this._overviewPage.add_child(this._hwCard);

        // The foot: About Resource Pulse, in the window's About tab.
        const aboutBtn = new St.Button({
            style_class: 'resource-pulse-about-button',
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER
        });
        const aboutBox = new St.BoxLayout({ style: 'spacing: 12px;', y_align: Clutter.ActorAlign.CENTER });
        aboutBox.add_child(new St.Icon({ gicon: this._bundledIcon('rp-cpu'), style_class: 'resource-pulse-about-mark', style: 'icon-size: 18px;', y_align: Clutter.ActorAlign.CENTER }));
        const aboutText = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        const aboutTitle = new St.Label({ text: _('About Resource Pulse'), style_class: 'resource-pulse-about-title' });
        aboutText.add_child(aboutTitle);
        aboutText.add_child(new St.Label({ text: _('What it tracks, what it finds, links and credits'), style_class: 'resource-pulse-about-sub' }));
        aboutBox.add_child(aboutText);
        aboutBox.add_child(new St.Icon({ icon_name: 'go-next-symbolic', style_class: 'resource-pulse-about-arrow', style: 'icon-size: 14px;', y_align: Clutter.ActorAlign.CENTER }));
        aboutBtn.add_child(aboutBox);
        aboutBtn.accessible_name = aboutTitle.text;
        aboutBtn.connect('clicked', () => this._openDetailsWindow('about'));
        this._addClickAnimations(aboutBtn);
        this._aboutBtn = aboutBtn;
        this._overviewPage.add_child(aboutBtn);

        this._menuContainer.add_child(this._overviewPage);
    }
}

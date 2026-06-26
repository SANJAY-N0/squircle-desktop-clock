import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'; 
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import Cairo from 'gi://cairo';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

const WIDTH = 200;
const HEIGHT = 250;
const MARGIN = 14;
const CORNER_RADIUS = 45;       
const CIRCLE_PAD = 10;          
const DASH_LENGTH = 8;          
const DASH_WIDTH = 2.5;         
const NUM_DASHES = 60;          

function _arcPoint(cx, cy, r, theta0_deg, theta1_deg, frac) {
    let theta = (theta0_deg + (theta1_deg - theta0_deg) * frac) * Math.PI / 180;
    let x = cx + r * Math.cos(theta);
    let y = cy + r * Math.sin(theta);
    return [x, y, (theta * 180 / Math.PI)];
}

function _pointAtDistance(segments, s) {
    let remaining = s;
    for (let [length, point_fn] of segments) {
        if (remaining <= length) {
            return point_fn(remaining);
        }
        remaining -= length;
    }
    let [length, point_fn] = segments[segments.length - 1];
    return point_fn(length);
}

function getRoundedRectanglePoints(x, y, w, h, r, count) {
    let straight_w = w - 2 * r;
    let straight_h = h - 2 * r;
    let arc_len = (Math.PI / 2) * r;

    let segments = [
        [straight_w, (d) => [x + r + d, y, -90]],
        [arc_len,    (d) => _arcPoint(x + w - r, y + r, r, -90, 0, d / arc_len)],
        [straight_h, (d) => [x + w, y + r + d, 0]],
        [arc_len,    (d) => _arcPoint(x + w - r, y + h - r, r, 0, 90, d / arc_len)],
        [straight_w, (d) => [x + w - r - d, y + h, 90]],
        [arc_len,    (d) => _arcPoint(x + r, y + h - r, r, 90, 180, d / arc_len)],
        [straight_h, (d) => [x, y + h - r - d, 180]],
        [arc_len,    (d) => _arcPoint(x + r, y + r, r, 180, 270, d / arc_len)],
    ];

    let perimeter = segments.reduce((sum, seg) => sum + seg[0], 0);
    let start_offset = w / 2 - r;

    let points = [];
    for (let i = 0; i < count; i++) {
        let s = (start_offset + i * (perimeter / count)) % perimeter;
        points.push(_pointAtDistance(segments, s));
    }
    return points;
}

export default class SquircleClockExtension extends Extension {
    enable() {
        this._configFile = GLib.build_filenamev([GLib.get_user_config_dir(), 'squircle-desktop-clock.json']);
        
        this._bgIsWhite = false;
        this._is24h = false;
        this._dragMode = false;
        this._timezone = "Local";
        this._fontSize = 32; 
        this._savedX = -1;
        this._savedY = -1;

        this._cachedPoints = null;
        this._cachedFormatter = null;
        this._cachedFormatterTz = "";

        this._stageMotionId = 0;
        this._stageReleaseId = 0;
        this._containerButtonPressId = 0;
        this._isDragging = false;

        this._container = new St.Widget({
            style_class: 'clock-menu-frame',
            width: WIDTH,
            height: HEIGHT,
            clip_to_allocation: true,
            reactive: true,
            layout_manager: new Clutter.BinLayout()
        });

        let drawingArea = new St.DrawingArea({ x_expand: true, y_expand: true, reactive: false });
        drawingArea.connect('repaint', (area) => this._onDraw(area.get_context()));
        this._container.add_child(drawingArea);

        this._timeLabel = new St.Label({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
            reactive: false
        });
        this._container.add_child(this._timeLabel);

        let offsetOffsetX = 0, offsetOffsetY = 0;

        // Assigned connection ID to tracking variable to satisfy the static linter
        this._containerButtonPressId = this._container.connect('button-press-event', (actor, event) => {
            if (event.get_click_count() === 2) {
                this._cleanupStageDrag(); 
                try {
                    let appInfo = Gio.AppInfo.create_from_commandline('gnome-clocks', null, Gio.AppInfoCreateFlags.NONE);
                    if (appInfo) appInfo.launch([], null);
                } catch (e) {
                    logError(e);
                }
                return Clutter.EVENT_STOP;
            }

            if (!this._dragMode) return Clutter.EVENT_PROPAGATE;
            
            this._isDragging = true;
            let [x, y] = event.get_coords();
            let [ax, ay] = actor.get_position();
            offsetOffsetX = x - ax;
            offsetOffsetY = y - ay;

            if (!this._stageMotionId) {
                this._stageMotionId = global.stage.connect('motion-event', (stage, motionEvent) => {
                    if (!this._isDragging) return Clutter.EVENT_PROPAGATE;
                    let [mx, my] = motionEvent.get_coords();
                    this._container.set_position(mx - offsetOffsetX, my - offsetOffsetY);
                    return Clutter.EVENT_STOP;
                });
            }

            if (!this._stageReleaseId) {
                this._stageReleaseId = global.stage.connect('button-release-event', () => {
                    if (!this._isDragging) return Clutter.EVENT_PROPAGATE;
                    let [ax, ay] = this._container.get_position();
                    this._writePositionToConfig(ax, ay);
                    this._cleanupStageDrag();
                    return Clutter.EVENT_STOP;
                });
            }

            return Clutter.EVENT_STOP;
        });

        if (Main.layoutManager._backgroundGroup) {
            Main.layoutManager._backgroundGroup.add_child(this._container);
        } else {
            Main.layoutManager.uiGroup.add_child(this._container);
        }

        this._readConfigAsync();

        try {
            let file = Gio.File.new_for_path(this._configFile);
            this._fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._fileMonitorId = this._fileMonitor.connect('changed', (monitor, f, other_f, event_type) => {
                if (event_type === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event_type === Gio.FileMonitorEvent.CHANGED) {
                    this._readConfigAsync();
                    drawingArea.queue_repaint();
                }
            });
        } catch (e) {}

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            drawingArea.queue_repaint();
            this._updateTimeText();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _cleanupStageDrag() {
        if (this._stageMotionId) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = 0;
        }
        if (this._stageReleaseId) {
            global.stage.disconnect(this._stageReleaseId);
            this._stageReleaseId = 0;
        }
        this._isDragging = false;
    }

    disable() {
        if (this._timeoutId) { GLib.Source.remove(this._timeoutId); this._timeoutId = null; }
        
        this._cleanupStageDrag();

        if (this._fileMonitorId && this._fileMonitor) {
            this._fileMonitor.disconnect(this._fileMonitorId);
            this._fileMonitorId = null;
        }
        if (this._fileMonitor) {
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }

        if (this._timeLabel) {
            this._timeLabel.destroy();
            this._timeLabel = null;
        }

        if (this._container) {
            // Explicitly disconnect container button signals before tearing it down
            if (this._containerButtonPressId) {
                this._container.disconnect(this._containerButtonPressId);
                this._containerButtonPressId = 0;
            }
            let parent = this._container.get_parent();
            if (parent) parent.remove_child(this._container);
            this._container.destroy();
            this._container = null;
        }

        this._cachedPoints = null;
        this._cachedFormatter = null;
    }

    _readConfigAsync() {
        let file = Gio.File.new_for_path(this._configFile);
        file.load_contents_async(null, (obj, res) => {
            try {
                let [success, contents] = obj.load_contents_finish(res);
                if (!success) return;
                let data = JSON.parse(new TextDecoder().decode(contents));
                
                this._bgIsWhite = data.bg_is_white ?? false;
                this._is24h = data.is_24h ?? false;
                this._dragMode = data.drag_mode ?? false;
                this._timezone = data.timezone || "Local";
                this._fontSize = data.font_size || 32;

                if (data.x !== undefined && data.y !== undefined && data.x !== -1 && data.y !== -1) {
                    if (this._savedX !== data.x || this._savedY !== data.y) {
                        this._savedX = data.x;
                        this._savedY = data.y;
                        if (this._container) {
                            this._container.set_position(this._savedX, this._savedY);
                        }
                    }
                } else if (this._container) {
                    let monitor = Main.layoutManager.primaryMonitor;
                    this._container.set_position(monitor.width - WIDTH - 40, 80);
                }
                this._updateTimeText();
            } catch (e) {
                if (this._container && this._savedX === -1) {
                    let monitor = Main.layoutManager.primaryMonitor;
                    this._container.set_position(monitor.width - WIDTH - 40, 80);
                }
            }
        });
    }

    _writePositionToConfig(posX, posY) {
        let data = {
            bg_is_white: this._bgIsWhite,
            is_24h: this._is24h,
            drag_mode: this._dragMode,
            timezone: this._timezone,
            font_size: this._fontSize,
            x: posX,
            y: posY
        };
        let file = Gio.File.new_for_path(this._configFile);
        let bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(data, null, 2)));
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, null, (obj, res) => {
            try {
                obj.replace_contents_finish(res);
                this._savedX = posX;
                this._savedY = posY;
            } catch (e) {}
        });
    }

    _updateTimeText() {
        let now = new Date();
        let hours = now.getHours();
        let minutes = String(now.getMinutes()).padStart(2, '0');

        if (this._timezone && this._timezone !== "Local") {
            try {
                if (!this._cachedFormatter || this._cachedFormatterTz !== this._timezone) {
                    this._cachedFormatter = new Intl.DateTimeFormat('en-US', {
                        timeZone: this._timezone,
                        hour: 'numeric',
                        minute: '2-digit',
                        hourCycle: 'h23'
                    });
                    this._cachedFormatterTz = this._timezone;
                }
                let parts = this._cachedFormatter.formatToParts(now);
                hours = parseInt(parts.find(p => p.type === 'hour').value, 10);
                minutes = parts.find(p => p.type === 'minute').value;
            } catch (e) {}
        }

        if (!this._is24h) {
            hours = hours % 12;
            hours = hours ? hours : 12;
        } else {
            hours = String(hours).padStart(2, '0');
        }

        if (this._timeLabel) {
            this._timeLabel.set_text(`${hours}:${minutes}`);
            let textHexColor = this._bgIsWhite ? '#0f0f0f' : '#ffffff';
            this._timeLabel.set_style(`color: ${textHexColor}; font-size: ${this._fontSize}pt; font-weight: bold; font-family: sans-serif; text-shadow: 0px 1px 2px rgba(0,0,0,0.1);`);
        }
    }

    _onDraw(cr) {
        cr.setAntialias(Cairo.Antialias.BEST);
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const cardColor = this._bgIsWhite ? [1, 1, 1] : [0.06, 0.06, 0.06];
        const dashDone = this._bgIsWhite ? [0.06, 0.06, 0.06] : [1, 1, 1];
        const dashPending = this._bgIsWhite ? [0.88, 0.88, 0.90] : [0.22, 0.22, 0.24];

        let side = Math.min(WIDTH, HEIGHT) - 2 * MARGIN;
        let x0 = (WIDTH - side) / 2;
        let y0 = (HEIGHT - side) / 2;
        let now = new Date();

        cr.save();
        this._roundedRectPath(cr, x0 + 3, y0 + 4, side, side, CORNER_RADIUS);
        cr.setSourceRGBA(0, 0, 0, this._bgIsWhite ? 0.15 : 0.35);
        cr.fill();
        cr.restore();

        this._roundedRectPath(cr, x0, y0, side, side, CORNER_RADIUS);
        cr.setSourceRGB(...cardColor);
        cr.fill();

        this._drawSecondsBorder(cr, x0, y0, side, now.getSeconds(), dashDone, dashPending);
    }

    _roundedRectPath(cr, x, y, w, h, r) {
        cr.newSubPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    }

    _drawSecondsBorder(cr, x0, y0, side, currentSecond, dashDone, dashPending) {
        let inset_x = x0 + CIRCLE_PAD;
        let inset_y = y0 + CIRCLE_PAD;
        let inset_side = side - 2 * CIRCLE_PAD;
        let inset_radius = Math.max(CORNER_RADIUS - CIRCLE_PAD, 1);
        
        if (!this._cachedPoints) {
            this._cachedPoints = getRoundedRectanglePoints(inset_x, inset_y, inset_side, inset_side, inset_radius, NUM_DASHES);
        }

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(DASH_WIDTH);

        this._cachedPoints.forEach(([px, py, angle_deg], i) => {
            let theta = angle_deg * Math.PI / 180;
            let ix = px - DASH_LENGTH * Math.cos(theta);
            let iy = py - DASH_LENGTH * Math.sin(theta);
            let color = (i <= currentSecond) ? dashDone : dashPending;
            cr.setSourceRGB(...color);
            cr.moveTo(px, py);
            cr.lineTo(ix, iy);
            cr.stroke();
        });
    }
}
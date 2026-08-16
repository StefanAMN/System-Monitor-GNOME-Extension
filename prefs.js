import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ResourcePulsePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // 1. Create a preferences page
        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic'
        });
        window.add(page);

        // Intercept window close to trigger the extension to open
        window.connect('close-request', () => {
            settings.set_boolean('action-open-menu', true);
            return false; // propagate so window still closes
        });

        // 1.5. Inject a small back button into the top-left HeaderBar
        function findHeaderBar(w) {
            if (!w) return null;
            if (w.constructor.name === 'HeaderBar' || w.constructor.$gtype?.name === 'AdwHeaderBar') return w;
            let child = w.get_first_child();
            while (child) {
                let res = findHeaderBar(child);
                if (res) return res;
                child = child.get_next_sibling();
            }
            return null;
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            const headerBar = findHeaderBar(window);
            if (headerBar) {
                const backBtn = new Gtk.Button({
                    icon_name: 'go-previous-symbolic',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER
                });
                backBtn.connect('clicked', () => {
                    settings.set_boolean('action-open-menu', true);
                    window.close();
                });
                headerBar.pack_start(backBtn);
            }
            return GLib.SOURCE_REMOVE;
        });

        // 2. Group: Pinned Metrics
        const pinGroup = new Adw.PreferencesGroup({
            title: 'Pinned Metrics',
            description: 'Choose which metrics are displayed permanently in the top bar'
        });
        page.add(pinGroup);

        const availableMetrics = [
            { key: 'cpu', label: 'CPU Usage' },
            { key: 'memory', label: 'Memory Usage' },
            { key: 'battery', label: 'Battery Status' },
            { key: 'power', label: 'Power Draw' },
            { key: 'disk', label: 'Disk Space and I/O' },
            { key: 'network', label: 'Network Throughput' },
            { key: 'thermal', label: 'Thermal Sensors and Fans' },
            { key: 'gpu', label: 'GPU Status (NVIDIA / AMD / Intel)' }
        ];

        availableMetrics.forEach(metric => {
            const row = new Adw.SwitchRow({
                title: metric.label,
                subtitle: `Display ${metric.label.toLowerCase()} summary in the top bar`
            });

            // Initial active state
            const pinned = settings.get_strv('pinned-metrics');
            row.active = pinned.includes(metric.key);

            // Connect to switch changes
            row.connect('notify::active', () => {
                let current = settings.get_strv('pinned-metrics');
                if (row.active) {
                    if (!current.includes(metric.key)) {
                        current.push(metric.key);
                        settings.set_strv('pinned-metrics', current);
                    }
                } else {
                    current = current.filter(k => k !== metric.key);
                    settings.set_strv('pinned-metrics', current);
                }
            });

            pinGroup.add(row);
        });

        // 3. Group: General Settings
        const generalGroup = new Adw.PreferencesGroup({
            title: 'General Settings',
            description: 'Configure update rate, layout, and sensor units'
        });
        page.add(generalGroup);

        // Poll interval
        const pollRow = new Adw.SpinRow({
            title: 'Update Interval (seconds)',
            subtitle: 'Frequency of data sampling (1 to 10 seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10,
                step_increment: 1,
                page_increment: 2
            })
        });
        settings.bind('poll-interval', pollRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(pollRow);

        // Compact Mode
        const compactRow = new Adw.SwitchRow({
            title: 'Compact Top Bar Mode',
            subtitle: 'Show only icons in the top bar, hiding the text percent/unit labels'
        });
        settings.bind('compact-label', compactRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(compactRow);

        // Tooltips
        const tooltipRow = new Adw.SwitchRow({
            title: 'Show Hover Tooltips',
            subtitle: 'Display rich information overlays when hovering over top bar metrics'
        });
        settings.bind('show-tooltips', tooltipRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(tooltipRow);

        // Battery Top Bar Format
        const batFmtRow = new Adw.ComboRow({
            title: 'Battery Top Bar Format',
            subtitle: 'Choose between percentage only or percentage with estimated time',
            model: Gtk.StringList.new(['Percentage Only (e.g. 85%)', 'Percentage + Time (e.g. 85% · 2h 15m)']),
            selected: settings.get_string('battery-top-format') === 'percent-time' ? 1 : 0
        });
        batFmtRow.connect('notify::selected', () => {
            settings.set_string('battery-top-format', batFmtRow.selected === 1 ? 'percent-time' : 'percent');
        });
        generalGroup.add(batFmtRow);

        // Network Top Bar Format
        const netFmtRow = new Adw.ComboRow({
            title: 'Network Top Bar Format',
            subtitle: 'Display download rate, upload rate, or both in the top bar',
            model: Gtk.StringList.new(['Download Only (↓)', 'Upload Only (↑)', 'Both Download & Upload (↓ ↑)']),
            selected: settings.get_string('network-top-format') === 'both' ? 2 : (settings.get_string('network-top-format') === 'upload' ? 1 : 0)
        });
        netFmtRow.connect('notify::selected', () => {
            const val = netFmtRow.selected === 2 ? 'both' : (netFmtRow.selected === 1 ? 'upload' : 'download');
            settings.set_string('network-top-format', val);
        });
        generalGroup.add(netFmtRow);

        // Temperature Unit
        const tempUnitRow = new Adw.ComboRow({
            title: 'Temperature Unit',
            subtitle: 'Select between Celsius and Fahrenheit',
            model: Gtk.StringList.new(['Celsius (°C)', 'Fahrenheit (°F)']),
            selected: settings.get_string('unit-temp') === 'F' ? 1 : 0
        });
        tempUnitRow.connect('notify::selected', () => {
            settings.set_string('unit-temp', tempUnitRow.selected === 1 ? 'F' : 'C');
        });
        generalGroup.add(tempUnitRow);

        // Memory Unit
        const memUnitRow = new Adw.ComboRow({
            title: 'Memory Unit',
            subtitle: 'Select between decimal GB and binary GiB',
            model: Gtk.StringList.new(['Gigabytes (GB)', 'Gibibytes (GiB)']),
            selected: settings.get_string('unit-mem') === 'GiB' ? 1 : 0
        });
        memUnitRow.connect('notify::selected', () => {
            settings.set_string('unit-mem', memUnitRow.selected === 1 ? 'GiB' : 'GB');
        });
        generalGroup.add(memUnitRow);

        // 4. Group: Alerts and Thresholds
        const alertGroup = new Adw.PreferencesGroup({
            title: 'Warning Thresholds',
            description: 'Set thresholds for system alerts. Transgressing values turn orange/red.'
        });
        page.add(alertGroup);

        // CPU Alert Threshold
        const cpuAlertRow = new Adw.SpinRow({
            title: 'CPU Warning Threshold (%)',
            subtitle: 'Turns red if overall CPU exceeds this value',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 100,
                step_increment: 1,
                page_increment: 5
            })
        });
        settings.bind('threshold-cpu', cpuAlertRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        alertGroup.add(cpuAlertRow);

        // Memory Alert Threshold
        const memAlertRow = new Adw.SpinRow({
            title: 'Memory Warning Threshold (%)',
            subtitle: 'Turns red if physical memory usage exceeds this value',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 100,
                step_increment: 1,
                page_increment: 5
            })
        });
        settings.bind('threshold-mem', memAlertRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        alertGroup.add(memAlertRow);

        // Temperature Alert Threshold
        const tempAlertRow = new Adw.SpinRow({
            title: 'Temperature Warning Threshold (°C)',
            subtitle: 'Turns red if CPU package temp exceeds this value',
            adjustment: new Gtk.Adjustment({
                lower: 40,
                upper: 100,
                step_increment: 1,
                page_increment: 5
            })
        });
        settings.bind('threshold-temp', tempAlertRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        alertGroup.add(tempAlertRow);
        // 5. Group: Advanced Settings
        const advancedGroup = new Adw.PreferencesGroup({
            title: 'Advanced Settings',
            description: 'Advanced features and system troubleshooting'
        });
        page.add(advancedGroup);

        const powerFixRow = new Adw.ActionRow({
            title: 'Enable CPU Power Monitoring',
            subtitle: 'Fixes 0W reading by granting permission to Intel/AMD RAPL sensors (Requires Admin)'
        });
        
        const powerFixButton = new Gtk.Button({
            label: 'Fix Permissions',
            valign: Gtk.Align.CENTER,
            has_frame: true
        });
        
        powerFixButton.connect('clicked', () => {
            try {
                const script = `
echo 'SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod a+r /sys/class/powercap/%k/energy_uj"' | tee /etc/udev/rules.d/99-powercap-read.rules
udevadm control --reload-rules
udevadm trigger
chmod a+r /sys/class/powercap/intel-rapl*/energy_uj 2>/dev/null || true
`;
                const proc = Gio.Subprocess.new(['pkexec', 'bash', '-c', script], Gio.SubprocessFlags.NONE);
                proc.wait_async(null, (obj, res) => {
                    try {
                        obj.wait_finish(res);
                        powerFixRow.subtitle = 'Permissions successfully updated!';
                        powerFixButton.sensitive = false;
                    } catch (e) {
                        powerFixRow.subtitle = `Failed: ${e.message}`;
                    }
                });
            } catch (e) {
                console.error(e);
            }
        });
        
        powerFixRow.add_suffix(powerFixButton);
        powerFixRow.activatable_widget = powerFixButton;
        advancedGroup.add(powerFixRow);
    }
}

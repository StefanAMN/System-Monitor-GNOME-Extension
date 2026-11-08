// Compare two completed ranges in the existing Tracking history.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { WORKLOAD_METRICS, WORKLOAD_MINUTES, WORKLOAD_MIN_COVERAGE, workloadStarts, compareWorkloads } from '../../lib/engine/workload.js';
import { formatBytes } from '../../lib/common/format.js';
import { _, fill, ngettext } from '../../lib/common/i18n.js';

function spanLabel(minutes) {
    const n = minutes < 60 ? minutes : minutes / 60;
    return fill(minutes < 60 ? ngettext('{n} minute', '{n} minutes', n) : ngettext('{n} hour', '{n} hours', n), { n });
}

function startLabel(ms) {
    const date = GLib.DateTime.new_from_unix_local(ms / 1000);
    return fill(_('{date} at {time}'), { date: date.format('%x'), time: date.format('%H:%M %Z') });
}

function formatMetric(key, value, useGiB) {
    if (key === 'cpu') return fill(_('{value} s/min'), { value: value.toFixed(1) });
    if (key === 'battery') return fill(_('{value} W'), { value: value.toFixed(1) });
    const bytes = formatBytes(value, useGiB);
    return key === 'memory' ? bytes : fill(_('{value}/min'), { value: bytes });
}

export function buildWorkloadComparison(settings, history) {
    const group = new Adw.PreferencesGroup();
    const expander = new Adw.ExpanderRow({ title: _('Compare workloads'), subtitle: _('Compare equal periods before and after a change') });
    group.add(expander);
    const duration = new Adw.ComboRow({ title: _('Duration'), model: Gtk.StringList.new(WORKLOAD_MINUTES.map(spanLabel)), selected: 2 });
    const before = new Adw.ComboRow({ title: _('Before starts'), model: Gtk.StringList.new([]) });
    const after = new Adw.ComboRow({ title: _('After starts'), model: Gtk.StringList.new([]) });
    expander.add_row(duration);
    expander.add_row(before);
    expander.add_row(after);
    const guidance = new Adw.ActionRow({ title: _('Measured time'), subtitle: fill(
        _('Changes are shown when both periods have at least {percent}% coverage. Earlier history may lack CPU or battery coverage.'),
        { percent: Math.round(WORKLOAD_MIN_COVERAGE * 100) }) });
    expander.add_row(guidance);
    const notice = new Adw.ActionRow({ visible: false });
    expander.add_row(notice);
    const titles = [_('CPU time'), _('Average memory'), _('Disk read'), _('Disk written'), _('Battery drain')];
    const metrics = Object.fromEntries(WORKLOAD_METRICS.map((key, i) => {
        const row = new Adw.ActionRow({ title: titles[i], use_markup: false });
        expander.add_row(row);
        return [key, row];
    }));

    let starts = [];
    let lastDuration = null;
    let changingChoices = false;
    let result = null;
    const refresh = () => {
        if (!expander.expanded || changingChoices) return;
        const minutes = WORKLOAD_MINUTES[duration.selected];
        const now = Date.now();
        const choices = workloadStarts(history.ledger, minutes, now);
        const durationChanged = minutes !== lastDuration;
        if (durationChanged || choices.length !== starts.length || choices.some((time, i) => time !== starts[i])) {
            lastDuration = minutes;
            const keepBefore = starts[before.selected];
            const keepAfter = starts[after.selected];
            starts = choices;
            const model = Gtk.StringList.new(starts.map(startLabel));
            changingChoices = true;
            before.model = after.model = model;
            const afterIndex = Math.max(0, starts.indexOf(keepAfter));
            after.selected = starts.length ? afterIndex : Gtk.INVALID_LIST_POSITION;
            const keepLeft = starts.includes(keepBefore) && (!durationChanged || keepBefore + minutes * 60000 <= starts[afterIndex]);
            const beforeIndex = keepLeft ? starts.indexOf(keepBefore)
                : starts.findIndex(time => time + minutes * 60000 <= starts[afterIndex]);
            before.selected = beforeIndex >= 0 ? beforeIndex : Gtk.INVALID_LIST_POSITION;
            changingChoices = false;
        }
        const left = starts[before.selected];
        const right = starts[after.selected];
        before.sensitive = after.sensitive = starts.length > 0;
        result = history.problem ? null : compareWorkloads(history.ledger, { before: left, after: right, minutes, now });
        notice.visible = result === null;
        if (!result) notice.title = history.problem ? _('Saved history is unavailable') : starts.length < 2
            ? _('Two completed periods are needed') : _('Choose a before period that ends by the start of the after period');
        const useGiB = settings.get_string('unit-mem') === 'GiB';
        for (const [key, row] of Object.entries(metrics)) {
            row.visible = !!result;
            if (!result) continue;
            const metric = result.metrics[key];
            const describe = sample => {
                const percent = Math.min(100, Math.floor(sample.seconds / result.seconds * 100 + 1e-9));
                const value = sample.value === null ? _('No measurement') : formatMetric(key, sample.value, useGiB);
                return fill(_('{value} · {percent}% measured'), { value, percent });
            };
            let change;
            if (metric.change === null) change = _('Change unavailable');
            else if (Math.abs(metric.change) < 1e-9) change = _('No change');
            else {
                const value = metric.percent === null
                    ? formatMetric(key, Math.abs(metric.change), useGiB) : `${Math.abs(metric.percent).toFixed(1)}%`;
                change = fill(metric.change > 0 ? _('Increase of {value}') : _('Decrease of {value}'), { value });
            }
            row.subtitle = fill(_('Before: {before}\nAfter: {after}\n{change}'),
                { before: describe(metric.before), after: describe(metric.after), change });
        }
    };
    expander.connect('notify::expanded', () => {
        if (expander.expanded) {
            if (lastDuration === null && !history.ledger.fine?.length && history.ledger.buckets.length > 0) duration.selected = 3;
            history.requestFlush();
        }
        refresh();
    });
    for (const row of [duration, before, after]) row.connect('notify::selected', refresh);
    return { group, expander, duration, before, after, notice, metrics, refresh, get result() { return result; } };
}

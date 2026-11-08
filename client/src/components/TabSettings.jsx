// Settings → Tabs: choose which tabs show and their order, in the left bar (and the phone's bottom
// bar) and along the top of the Inbox. Each change applies and is saved straight away.
import { ordered } from '../tabLayout.js';
import Icon from './Icon.jsx';

function TabList({ items, prefs, onChange, keepOne }) {
  const list = ordered(items, prefs);
  const hidden = new Set(prefs?.hidden || []);
  const shownCount = list.filter((item) => item.locked || !hidden.has(item.id)).length;
  const save = (nextList, nextHidden) => onChange({ order: nextList.map((item) => item.id), hidden: [...nextHidden] });

  const move = (index, by) => {
    const next = [...list];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    save(next, hidden);
  };
  const toggle = (item) => {
    const next = new Set(hidden);
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    save(list, next);
  };

  return (
    <ul className="tab-settings-list">
      {list.map((item, index) => {
        const shown = item.locked || !hidden.has(item.id);
        // At least one stays, or there'd be nothing to click.
        const lastOne = keepOne && shown && shownCount === 1;
        return (
          <li key={item.id} className={shown ? '' : 'off'}>
            <Icon name={item.icon} size={20} />
            <span className="tab-settings-name">
              {item.label}
              {item.locked && <small>Always shown</small>}
            </span>
            <span className="tab-settings-move">
              <button type="button" className="icon-btn" disabled={index === 0} aria-label={`Move ${item.label} up`} title="Move up" onClick={() => move(index, -1)}>
                <Icon name="expandMore" size={20} className="up" />
              </button>
              <button type="button" className="icon-btn" disabled={index === list.length - 1} aria-label={`Move ${item.label} down`} title="Move down" onClick={() => move(index, 1)}>
                <Icon name="expandMore" size={20} />
              </button>
            </span>
            <label className="tab-settings-switch" title={item.locked ? 'Always shown' : lastOne ? 'At least one tab stays' : shown ? 'Hide' : 'Show'}>
              <input type="checkbox" role="switch" checked={shown} disabled={item.locked || lastOne} onChange={() => toggle(item)} aria-label={`Show ${item.label}`} />
              <span aria-hidden="true" />
            </label>
          </li>
        );
      })}
    </ul>
  );
}

export default function TabSettings({ layout, rail, pinned, inbox, onChange }) {
  const update = (group, prefs) => onChange({ ...layout, [group]: prefs });
  // The two parts of the left bar share one setting: the order within each part is kept apart.
  const railPrefs = layout.rail || {};
  const saveRail = (part, others) => (prefs) => update('rail', {
    order: part === 'main' ? [...prefs.order, ...ordered(others, railPrefs).map((item) => item.id)] : [...ordered(others, railPrefs).map((item) => item.id), ...prefs.order],
    hidden: [...new Set([...(railPrefs.hidden || []).filter((id) => !(part === 'main' ? rail : pinned).some((item) => item.id === id)), ...prefs.hidden])],
  });
  const customised = Boolean(layout.rail || layout.inbox);

  return (
    <div className="tab-settings">
      <section>
        <h3>Left bar</h3>
        <p className="muted small">On a phone, the first four of these are in the bar along the bottom.</p>
        <TabList items={rail} prefs={railPrefs} onChange={saveRail('main', pinned)} />
        {pinned.length > 0 && (
          <>
            <h4>At the bottom of the left bar</h4>
            <TabList items={pinned} prefs={railPrefs} onChange={saveRail('pinned', rail)} />
          </>
        )}
      </section>
      <section>
        <h3>Inbox tabs</h3>
        <p className="muted small">Mail in a hidden tab still shows in All, and in search.</p>
        <TabList items={inbox} prefs={layout.inbox} onChange={(prefs) => update('inbox', prefs)} keepOne />
      </section>
      {customised && (
        <button type="button" className="btn btn-outline tab-settings-reset" onClick={() => onChange({})}>
          <Icon name="refresh" size={18} /> Back to the usual tabs
        </button>
      )}
    </div>
  );
}

// Which tabs someone shows, and in what order: { order: [ids], hidden: [ids] } for each group of
// tabs. Saved on their account (Settings → Tabs), so it follows them from device to device.

/** Every tab in the person's order. Tabs new since they arranged theirs keep their usual place. */
export function ordered(items, prefs) {
  const order = Array.isArray(prefs?.order) ? prefs.order : [];
  const rank = (item, i) => {
    const at = order.indexOf(item.id);
    // Not in their order yet: just after whatever came before it by default.
    return at >= 0 ? at : (order.indexOf(items[i - 1]?.id) + 0.5) || i + 1000;
  };
  return items.map((item, i) => ({ item, at: rank(item, i), i })).sort((a, b) => a.at - b.at || a.i - b.i).map(({ item }) => item);
}

/** The tabs to show, in order. A locked tab is always shown, and if nothing would be left, all are. */
export function arrange(items, prefs) {
  const hidden = new Set(Array.isArray(prefs?.hidden) ? prefs.hidden : []);
  const shown = ordered(items, prefs).filter((item) => item.locked || !hidden.has(item.id));
  return shown.length ? shown : items;
}

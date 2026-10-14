// The sidebar "Search menu" box: filters the menu items in place as you type (case- and spacing-insensitive
// substring of the item's name). Empty shows everything.
export function menuItemMatches(query: string, label: string) {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return true;
  return label.toLowerCase().replace(/\s+/g, ' ').includes(q);
}

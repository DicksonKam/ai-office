// Taking you from a worker to its chat. Each reader may say how its agent can be opened by giving it an `openUrl`; the page
// only ever sends an agent's id, and the link is looked up here, so nothing a page says can launch an arbitrary address.
// A link must also match a shape listed here: these are links checked by hand to show a chat and change nothing in it.
import { execFile } from 'node:child_process';

const SAFE_LINKS = [
  /^claude:\/\/code\/continue\?session=local_[A-Za-z0-9-]{1,64}$/, // Claude Desktop goes to that chat; nothing is written to it
  /^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // Codex opens the thread: it notes that, as when you click it there, and sends nothing
];
export const isSafeLink = url => typeof url === 'string' && SAFE_LINKS.some(re => re.test(url));

/** Claude Desktop's own id for a chat (`local_…`) is what its link wants. */
export const codexThreadLink = id => (typeof id === 'string' ? `codex://threads/${id}` : null);
export const claudeDesktopLink = hostId => (typeof hostId === 'string' ? `claude://code/continue?session=${hostId}` : null);

/** Who can be opened, and how. A helper has no chat of its own, so it opens the one it works for. Removes each `openUrl`
 *  from the agents (the page has no use for it) and leaves `open: { label }`. Returns Map(id -> { url, label }). */
export function resolveOpens(agents) {
  const byId = new Map(agents.map(a => [a.id, a])), out = new Map();
  for (const a of agents) {
    let root = a; const seen = new Set();
    while (root && !isSafeLink(root.openUrl) && root.parentId && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.parentId); }
    if (root && isSafeLink(root.openUrl)) out.set(a.id, { url: root.openUrl, label: root === a ? 'Open this chat' : 'Open the lead’s chat' });
  }
  for (const a of agents) { delete a.openUrl; const t = out.get(a.id); if (t) a.open = { label: t.label }; else delete a.open; }
  return out;
}

export function openLink(url, run = execFile) {
  return new Promise((resolve, reject) => {
    if (!isSafeLink(url)) return reject(new Error('not a known link'));
    if (process.platform !== 'darwin') return reject(new Error('macOS only'));
    run('open', [url], { timeout: 5000 }, err => (err ? reject(err) : resolve()));
  });
}

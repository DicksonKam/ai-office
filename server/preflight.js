// The Codex and Cursor readers load node:sqlite only when they first need it, so a Node without it would run with those
// agents silently missing. Better to stop and say why. (22.13 is where it stopped needing a flag.)
try {
  await import('node:sqlite');
} catch {
  console.error(`AI Office needs Node 22.13 or newer, and this is Node ${process.versions.node}. Get a newer one at https://nodejs.org`);
  process.exit(1);
}

// Who may talk to the office. Listening on 127.0.0.1 keeps other machines out, but every web page open in this Mac's
// browser is on this machine too, and could otherwise read the agents' tasks and folders. So:
//   Host    must name this server. A site that points its own domain at 127.0.0.1 (DNS rebinding) is refused here.
//   Origin  browsers add it to WebSocket and cross-site requests; when present it must be this server too.
// Tools with no Origin (curl, the check scripts) are already on the machine and can read the same files themselves.
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function namesThisServer(host, port) {
  if (!host) return false;
  let u;
  try { u = new URL(`http://${host}`); } catch { return false; }
  return LOCAL_NAMES.has(u.hostname) && Number(u.port || 80) === Number(port);
}

/** May a request with these headers reach the office on this port? */
export function isLocalRequest(headers, port) {
  if (!namesThisServer(headers.host, port)) return false;
  if (headers.origin === undefined) return true;
  let u;
  try { u = new URL(headers.origin); } catch { return false; } // includes "null": a sandboxed frame or a file:// page
  return u.protocol === 'http:' && namesThisServer(u.host, port);
}

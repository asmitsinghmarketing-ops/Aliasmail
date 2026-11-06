// Opens a remote desktop in the computer's own Remote Desktop app. Browsers can't speak RDP, so
// this builds a .rdp file, which that app opens. It holds only where to connect: never a password.
//
// A .rdp file can also hand the far computer this computer's drives and clipboard, which is why
// attackers send them by email. Everything here comes from a fixed list of settings, and a
// connection someone else shared gets none of that access at all.

const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const HOST = /^[a-z0-9.:-]{1,253}$/i;

const clean = (value) => {
  const text = String(value ?? '').trim();
  if (UNSAFE.test(text)) throw new Error('This remote desktop has invalid details.');
  return text;
};

const hostForFile = (host) => (host.includes(':') ? `[${host}]` : host);

/** The file's text. `shared`: it came from another person, so nothing of this computer is offered. */
export function rdpText({ host, port = 3389, username = '', domain = '', gateway = '' }, { shared = false } = {}) {
  const target = clean(host);
  const via = clean(gateway);
  const number = Number(port);
  if (!HOST.test(target) || (via && !HOST.test(via)) || !Number.isInteger(number) || number < 1 || number > 65535) {
    throw new Error('This remote desktop has invalid details.');
  }
  const lines = [
    `full address:s:${hostForFile(target)}:${number}`,
    'prompt for credentials:i:1',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    'screen mode id:i:2',
    'smart sizing:i:1',
    'dynamic resolution:i:1',
    'audiomode:i:0',
    'remoteapplicationmode:i:0',
    `redirectclipboard:i:${shared ? 0 : 1}`,
    'redirectprinters:i:0',
    'redirectcomports:i:0',
    'redirectsmartcards:i:0',
    'redirectposdevices:i:0',
    'redirectwebauthn:i:0',
    'redirectlocation:i:0',
    'drivestoredirect:s:',
    'devicestoredirect:s:',
    'camerastoredirect:s:',
    'usbdevicestoredirect:s:',
    ...(via
      ? [`gatewayhostname:s:${hostForFile(via)}`, 'gatewayusagemethod:i:1', 'gatewayprofileusagemethod:i:1', 'gatewaycredentialssource:i:0']
      : ['gatewayusagemethod:i:0', 'gatewayprofileusagemethod:i:0']),
  ];
  if (!shared) {
    const user = clean(username);
    const realm = clean(domain);
    if (user) lines.push(`username:s:${realm ? `${realm}\\` : ''}${user}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Download the file; opening it starts the Remote Desktop app. */
export function openRemoteDesktop(connection, options) {
  const text = rdpText(connection, options);
  // Remote Desktop's own files are UTF-16 with a byte order mark, which keeps accented names right.
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-rdp' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${String(connection.name || connection.host).replace(/[^\w.-]+/g, '-').slice(0, 60) || 'remote-desktop'}.rdp`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

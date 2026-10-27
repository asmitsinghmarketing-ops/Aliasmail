// Google's own Drive file picker. Picking a file grants AliasMail access to just that file
// (drive.file scope), which is how files can then be shared with an email's recipients.
let loading = null;

function loadPicker() {
  if (window.google?.picker) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true;
    script.onload = () => window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('Google Drive didn’t load. Try again.')) });
    script.onerror = () => {
      loading = null;
      reject(new Error('Couldn’t reach Google Drive. Check your connection.'));
    };
    document.head.append(script);
  });
  return loading;
}

// Only links to Google's own Drive/Docs pages go into an email.
const safeUrl = (file) =>
  /^https:\/\/(docs|drive)\.google\.com\//.test(file.url || '') ? file.url : `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`;

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The message body with links to the picked Drive files added at the end (like Gmail's Drive chips). */
export function withDriveLinks({ html, text }, files = []) {
  if (!files.length) return { html, text };
  return {
    html: `${html}<p>${files.map((f) => `<a href="${escapeHtml(f.url)}">${escapeHtml(f.name)}</a>`).join('<br>')}</p>`,
    text: `${text}\n\n${files.map((f) => `${f.name}: ${f.url}`).join('\n')}`,
  };
}

/** Opens the picker; resolves to the chosen files (empty when cancelled). */
export async function pickDriveFiles({ accessToken, apiKey, appId }) {
  await loadPicker();
  const g = window.google.picker;
  return new Promise((resolve) => {
    const files = new g.DocsView(g.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
    new g.PickerBuilder()
      .addView(files)
      .addView(new g.DocsUploadView())
      .enableFeature(g.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(accessToken)
      .setDeveloperKey(apiKey)
      .setAppId(appId)
      .setOrigin(window.location.origin)
      .setTitle('Insert files using Google Drive')
      .setCallback((data) => {
        const action = data[g.Response.ACTION];
        if (action === g.Action.PICKED) {
          resolve(
            data[g.Response.DOCUMENTS].map((d) => {
              const file = { id: d[g.Document.ID], name: d[g.Document.NAME], url: d[g.Document.URL], mimeType: d[g.Document.MIME_TYPE] };
              return { ...file, url: safeUrl(file) };
            }),
          );
        } else if (action === g.Action.CANCEL) {
          resolve([]);
        }
      })
      .build()
      .setVisible(true);
  });
}

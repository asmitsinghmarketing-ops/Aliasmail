import test from 'node:test';
import assert from 'node:assert/strict';
import { embedDataImages } from '../src/mailbox.js';

// A reply or forward keeps the original's pictures as data: URLs; they go out as inline parts.
test('data: pictures in the HTML become inline attachments the HTML points to', () => {
  const png = Buffer.from('fake-png').toString('base64');
  const mail = { html: `<p>Hi</p><img src="data:image/png;base64,${png}" alt="logo"><img src='https://example.com/a.png'>`, attachments: [{ filename: 'a.pdf' }] };
  const out = embedDataImages(mail);
  assert.equal(out.attachments.length, 2);
  const [, inline] = out.attachments;
  assert.equal(inline.contentType, 'image/png');
  assert.equal(inline.contentDisposition, 'inline');
  assert.equal(inline.content.toString(), 'fake-png');
  assert.match(out.html, new RegExp(`<img src="cid:${inline.cid}" alt="logo">`));
  assert.match(out.html, /https:\/\/example\.com\/a\.png/);
  assert.equal(embedDataImages({ html: '<p>no pictures</p>' }).attachments, undefined);
});

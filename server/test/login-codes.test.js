import test from 'node:test';
import assert from 'node:assert/strict';
import { findLoginCode, mightHaveCode, serviceName } from '../src/login-codes.js';

test('login codes are found in the usual wordings', () => {
  assert.equal(findLoginCode('Your Claude login code', 'Enter this code to sign in: 482913. It expires in 10 minutes.'), '482913');
  assert.equal(findLoginCode('Secure link to log in to Claude.ai', 'Open https://claude.ai/magic-link#abc123456 or use verification code 732-581'), '732581');
  assert.equal(findLoginCode('G-284913 is your Google verification code', ''), '284913');
  assert.equal(findLoginCode('Your verification code', 'Your code is K7Q2PZ. Do not share it.'), 'K7Q2PZ');
  assert.equal(findLoginCode('Sign in', '', '<p>Your one-time code is <b>553 201</b></p>'), '553201');
  assert.equal(findLoginCode('Sign in to Canva', 'Your code: 4821'), '4821');
});

test('numbers that are not codes are ignored', () => {
  assert.equal(findLoginCode('Invoice', 'Total $1234 for order 99887766'), null); // no "code" at all
  assert.equal(findLoginCode('Your code', 'Visit https://x.com/r?id=123456 or call +91 98765 43210'), null);
  assert.equal(findLoginCode('Promo code inside', 'Offer ends 2026. Use the code at checkout.'), null);
  assert.equal(findLoginCode('Your code', 'Enter it here. © 2026 Anthropic, 548 Market St, San Francisco, CA 94104. code'), null);
});

test('services get a recognisable name', () => {
  assert.equal(serviceName({ address: 'no-reply@mail.anthropic.com', name: 'Anthropic' }), 'Claude');
  assert.equal(serviceName({ address: 'no-reply@accounts.google.com', name: 'Google' }), 'Google');
  assert.equal(serviceName({ address: 'hello@zoom.us', name: 'Zoom Team' }), 'Zoom');
  assert.equal(serviceName({ address: 'x@acme.io', name: '' }), 'Acme');
  assert.equal(mightHaveCode({ subject: 'Weekly newsletter', snippet: 'Our top stories' }), false);
  assert.equal(mightHaveCode({ subject: 'Your sign-in code', snippet: '' }), true);
});

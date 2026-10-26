import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newVerifier, challengeFor, authorizeUrl, SCOPES } from '../src/canva.js';

test('the verifier is inside the length Canva accepts and is never reused', () => {
  const a = newVerifier(), b = newVerifier();
  for (const v of [a, b]) {
    assert.ok(v.length >= 43 && v.length <= 128, `length was ${v.length}`);
    assert.match(v, /^[A-Za-z0-9\-._~]+$/, 'must be unreserved characters only');
  }
  assert.notEqual(a, b, 'a fresh verifier is required per request');
});

test('the challenge is the base64url SHA256 of the verifier', () => {
  // Known value for the string "abc".
  assert.equal(challengeFor('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  assert.doesNotMatch(challengeFor('abc'), /[+/=]/, 'base64url, not standard base64');
});

test('the authorize URL carries everything Canva requires', () => {
  const u = new URL(authorizeUrl({
    clientId: 'OC-123', verifier: 'v'.repeat(50), state: 'abc123',
    redirectUri: 'https://example.com/oauth/redirect',
  }));
  assert.equal(u.origin + u.pathname, 'https://www.canva.com/api/oauth/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'OC-123');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code_challenge'), challengeFor('v'.repeat(50)));
  assert.equal(u.searchParams.get('state'), 'abc123');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://example.com/oauth/redirect');
});

test('every scope the workflow needs is requested, read and write separately', () => {
  for (const scope of [
    'design:content:read', 'design:content:write', 'design:meta:read',
    'asset:read', 'asset:write',
    'brandtemplate:meta:read', 'brandtemplate:content:read', 'profile:read',
  ]) {
    assert.ok(SCOPES.split(' ').includes(scope), `missing scope ${scope}`);
  }
});

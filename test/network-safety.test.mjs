import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicUrl } from '../src/public-fetch.mjs';
import { fetchPluginArchive } from '../src/zip.mjs';
import { discoverOAuth } from '../src/mcp-oauth.mjs';
import { isPrivateBrowserRequest } from '../src/browser-tool.mjs';

const nonPublicIpv6 = [
  '100::1',                 // IANA discard-only range: 100::/64
  '100:0:0:1::1',          // IANA dummy prefix: 100:0:0:1::/64
  'fe00::1',                // Reserved IPv6 space outside global unicast
  'fec1::1',                // Deprecated site-local space: fec0::/10
  '5f00::1',                // SRv6 special-purpose space, not globally reachable
  '2001:5::1',              // IANA 2001::/23 protocol-assignment space
  '2001:100::1',            // Middle of the same special-purpose block
  '2001:1ff::1'             // Upper edge of the same special-purpose block
];

test('all network-facing features consistently block non-public IPv6 destinations', async () => {
  let publicFetchCalls = 0;
  let archiveFetchCalls = 0;
  let oauthFetchCalls = 0;

  for (const address of nonPublicIpv6) {
    const url = 'https://[' + address + ']/resource';

    assert.equal(isPrivateBrowserRequest(url), true, 'browser policy: ' + address);

    await assert.rejects(
      fetchPublicUrl(url, {
        requestImpl: async () => {
          publicFetchCalls++;
          return {
            status: 200,
            headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/plain' : null },
            body: 'should not be fetched'
          };
        }
      }),
      /Private-network addresses are blocked/,
      'public URL fetch: ' + address
    );

    await assert.rejects(
      fetchPluginArchive(url, {
        fetchImpl: async () => {
          archiveFetchCalls++;
          return new Response('should not be fetched');
        }
      }),
      /private or special-purpose/,
      'plugin archive: ' + address
    );

    await assert.rejects(
      discoverOAuth(url, {
        fetch: async () => {
          oauthFetchCalls++;
          return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
      }),
      /private or special-purpose/,
      'MCP OAuth: ' + address
    );
  }

  assert.equal(publicFetchCalls, 0, 'public URL fetch must reject before making a request');
  assert.equal(archiveFetchCalls, 0, 'plugin archive import must reject before making a request');
  assert.equal(oauthFetchCalls, 0, 'OAuth discovery must reject before making a request');
});

test('shared IP policy continues to allow ordinary public IPv4 and IPv6 addresses', async () => {
  for (const url of ['https://93.184.216.34/resource', 'https://[2606:4700:4700::1111]/resource']) {
    let called = false;
    await fetchPublicUrl(url, {
      requestImpl: async () => {
        called = true;
        return {
          status: 200,
          headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'text/plain' : null },
          body: 'ok'
        };
      }
    });
    assert.equal(called, true, 'public destination remains fetchable: ' + url);
  }
});

/**
 * Test Suite for Cloudflare Stream Proxy Worker
 * Simulates Cloudflare Worker execution locally using native Node.js Fetch API.
 */

const path = require('path');
const fs = require('fs');

async function runWorkerTests() {
  console.log('=== Testing Cloudflare Stream Proxy Worker ===\n');

  // Load the worker module
  const workerPath = path.join(__dirname, '../../cloudflare-proxy/worker.js');
  const workerModule = await import('file:///' + workerPath.replace(/\\/g, '/'));
  const worker = workerModule.default;

  let passed = 0;
  let failed = 0;

  // Test 1: Health check
  try {
    const req = new Request('https://stream-proxy.workers.dev/', { method: 'GET' });
    const res = await worker.fetch(req, {}, {});
    const data = await res.json();
    if (res.status === 200 && data.status === 'ok') {
      console.log('✅ Test 1 Passed: Worker health check returned 200 OK');
      passed++;
    } else {
      console.error('❌ Test 1 Failed:', res.status, data);
      failed++;
    }
  } catch (e) {
    console.error('❌ Test 1 Error:', e.message);
    failed++;
  }

  // Test 2: CORS Preflight
  try {
    const req = new Request('https://stream-proxy.workers.dev/', { method: 'OPTIONS' });
    const res = await worker.fetch(req, {}, {});
    const cors = res.headers.get('access-control-allow-origin');
    if (res.status === 204 && cors === '*') {
      console.log('✅ Test 2 Passed: CORS preflight returned 204 with Access-Control-Allow-Origin: *');
      passed++;
    } else {
      console.error('❌ Test 2 Failed:', res.status, cors);
      failed++;
    }
  } catch (e) {
    console.error('❌ Test 2 Error:', e.message);
    failed++;
  }

  // Test 3: MovieBox Stream with Range & Desktop Chrome User-Agent
  try {
    // Fresh MovieBox stream URL
    const targetUrl = 'https://bcdn.hakunaymatata.com/resource/h265/aaa12951001564fcf5c218814a771228.mp4?sign=e7d8835fe2527e57650ce435290a895b&t=1795261887';
    const proxyUrl = `https://stream-proxy.workers.dev/?url=${encodeURIComponent(targetUrl)}`;

    const req = new Request(proxyUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'http://localhost:3000',
        'Referer': 'http://localhost:3000/',
        'Range': 'bytes=0-100',
      },
    });

    const res = await worker.fetch(req, {}, {});
    const ct = res.headers.get('content-type');
    const cr = res.headers.get('content-range');
    const cors = res.headers.get('access-control-allow-origin');

    if (res.status === 206 && ct?.includes('video/mp4') && cr && cors === '*') {
      console.log('✅ Test 3 Passed: MovieBox proxy stream returned 206 Partial Content (video/mp4)!');
      console.log('   Content-Range:', cr);
      console.log('   Content-Type:', ct);
      console.log('   CORS Origin:', cors);
      passed++;
    } else {
      console.error('❌ Test 3 Failed: Status', res.status, 'Type:', ct, 'Range:', cr);
      failed++;
    }
  } catch (e) {
    console.error('❌ Test 3 Error:', e.message);
    failed++;
  }

  // Test 4: Backend processStreamsForProxy integration
  try {
    const { processStreamsForProxy } = require('../proxy/proxyServer');

    // Without Cloudflare proxy URL
    delete process.env.CLOUDFLARE_STREAM_PROXY_URL;
    const s1 = [{ url: 'https://bcdn.hakunaymatata.com/test.mp4', provider: 'MovieBox' }];
    const res1 = processStreamsForProxy(s1, 'http://localhost:8787');
    const usedLocal = res1[0].url.startsWith('http://localhost:8787/ts-proxy');

    // With Cloudflare proxy URL
    process.env.CLOUDFLARE_STREAM_PROXY_URL = 'https://embed-gibox-stream-proxy.test.workers.dev';
    const res2 = processStreamsForProxy(s1, 'http://localhost:8787');
    const usedCf = res2[0].url.startsWith('https://embed-gibox-stream-proxy.test.workers.dev/?url=');

    if (usedLocal && usedCf) {
      console.log('✅ Test 4 Passed: processStreamsForProxy seamlessly switches between local Node.js proxy and Cloudflare Edge proxy!');
      passed++;
    } else {
      console.error('❌ Test 4 Failed:', { usedLocal, usedCf, res1: res1[0].url, res2: res2[0].url });
      failed++;
    }
  } catch (e) {
    console.error('❌ Test 4 Error:', e.message);
    failed++;
  }

  console.log(`\n=== Results: ${passed} Passed, ${failed} Failed ===`);
}

runWorkerTests().catch(console.error);

#!/usr/bin/env node
/**
 * DocMap local proxy — routes requests from the browser to AWS Bedrock.
 * Run: node server.js  (credentials come from ~/.aws/credentials or env vars)
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');

const PORT   = Number(process.env.PORT   || 3001);
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

const bedrock = new BedrockRuntimeClient({ region: REGION });

// ── Static file MIME types ────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ── Request body reader ───────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

// ── CORS headers ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Health check ──
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, region: REGION }));
    return;
  }

  // ── Bedrock proxy ──
  if (req.method === 'POST' && req.url === '/api/bedrock') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }));
      return;
    }

    const { modelId, messages, system, max_tokens } = body;

    if (!modelId || !messages) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'modelId and messages are required' } }));
      return;
    }

    const payload = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: max_tokens || 4096,
      system:     system || '',
      messages,
    });

    try {
      const command = new InvokeModelWithResponseStreamCommand({
        modelId,
        body:        payload,
        contentType: 'application/json',
        accept:      'application/json',
      });

      const response = await bedrock.send(command);

      // Stream response as SSE — same format the browser already parses
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });

      for await (const event of response.body) {
        if (event.chunk?.bytes) {
          try {
            const decoded = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf-8'));
            res.write(`data: ${JSON.stringify(decoded)}\n\n`);
          } catch {}
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();

    } catch (err) {
      console.error('[Bedrock error]', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    }
    return;
  }

  // ── Static files ──
  const reqPath  = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(__dirname, reqPath);

  // Prevent path traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'text/plain');
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  DocMap proxy is running');
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  Region: ${REGION}`);
  console.log('');
  console.log('  AWS credentials loaded from:');
  console.log('  · Environment variables  (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)');
  console.log('  · Credentials file       (~/.aws/credentials)');
  console.log('  · SSO / assumed role     (if you ran: aws sso login)');
  console.log('');
});

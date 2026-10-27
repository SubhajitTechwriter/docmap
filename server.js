#!/usr/bin/env node
/**
 * DocMap local proxy
 * - Routes to AWS Bedrock (with SigV4 auth)
 * - Fetches Jira tickets
 * - Reads local files (txt, md, docx, pdf, json, yaml, csv, xml…)
 * - Fetches Google Docs (publicly shared)
 *
 * Run: node server.js
 * Credentials: ~/.aws/credentials or AWS_* env vars
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const { BedrockClient, ListFoundationModelsCommand } = require('@aws-sdk/client-bedrock');

let mammoth   = null;
let pdfParse  = null;
try { mammoth  = require('mammoth');   } catch {}
try { pdfParse = require('pdf-parse'); } catch {}

const PORT   = Number(process.env.PORT   || 3001);
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

const bedrock     = new BedrockRuntimeClient({ region: REGION });
const bedrockMgmt = new BedrockClient({ region: REGION });

// ── Helpers ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── httpsGet — wraps https/http.get as a Promise ─────────────────────────────
function httpsGet(url, headersObj = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, { headers: headersObj }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location, headersObj));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

// ── Jira: extract text from Atlassian Document Format (ADF) ──────────────────
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  let out = '';
  if (node.type === 'text') out += node.text || '';
  if (node.type === 'hardBreak') out += '\n';
  if (node.content) {
    out += node.content.map(adfToText).join('');
    if (['paragraph','heading','bulletList','orderedList','listItem','blockquote','codeBlock'].includes(node.type)) {
      out += '\n';
    }
  }
  return out;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── Health ──────────────────────────────────────────────────────────────────
  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true, region: REGION,
      mammoth: !!mammoth, pdf: !!pdfParse,
    });
  }

  // ── docs.snaplogic.com sitemap ──────────────────────────────────────────────
  if (pathname === '/api/sitemap') {
    try {
      // Fetch the sitemap (may be an index pointing to sub-sitemaps)
      const UA = 'Mozilla/5.0 (compatible; DocMap/1.0; +http://localhost)';
      async function fetchSitemapUrls(sitemapUrl, depth = 0) {
        const r = await httpsGet(sitemapUrl, { 'User-Agent': UA });
        if (r.status !== 200) throw new Error(`${sitemapUrl} returned ${r.status}`);
        const xml = r.body.toString('utf-8');
        if (xml.includes('<sitemapindex') && depth === 0) {
          // It's an index — fetch each sub-sitemap (limit 10)
          const subUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim()).slice(0, 10);
          const all = [];
          for (const su of subUrls) {
            try { all.push(...await fetchSitemapUrls(su, depth + 1)); } catch {}
          }
          return all;
        }
        return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
      }

      const allUrls = await fetchSitemapUrls('https://docs.snaplogic.com/sitemap.xml');

      // Group by first path segment
      const sections = {};
      for (const u of allUrls) {
        try {
          const parts = new URL(u).pathname.replace(/^\//, '').split('/');
          const sec = parts[0] || 'root';
          if (!sections[sec]) sections[sec] = [];
          sections[sec].push(u);
        } catch {}
      }

      // Build a concise summary for Claude's context
      const summary = Object.entries(sections)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([sec, urls]) => {
          const examples = urls.slice(0, 4).map(u => new URL(u).pathname).join('\n    ');
          return `/${sec}/  (${urls.length} pages)\n    ${examples}`;
        })
        .join('\n\n');

      return json(res, 200, { totalPages: allUrls.length, summary, urls: allUrls });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // ── List Bedrock models ──────────────────────────────────────────────────────
  if (pathname === '/api/models') {
    try {
      const result = await bedrockMgmt.send(new ListFoundationModelsCommand({ byProvider: 'Anthropic' }));
      const models = (result.modelSummaries || [])
        .filter(m => m.modelId.toLowerCase().includes('claude') && m.responseStreamingSupported)
        .map(m => ({ id: m.modelId, name: m.modelName || m.modelId }))
        .sort((a, b) => b.id.localeCompare(a.id));
      return json(res, 200, models);
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // ── Bedrock streaming ────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/bedrock') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: { message: 'Invalid JSON' } }); }

    const { modelId, messages, system, max_tokens } = body;
    if (!modelId || !messages) return json(res, 400, { error: { message: 'modelId and messages are required' } });

    console.log(`[Bedrock] invoking model: ${modelId}`);
    try {
      const command = new InvokeModelWithResponseStreamCommand({
        modelId,
        contentType: 'application/json',
        accept:      'application/json',
        body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: max_tokens || 4096, system: system || '', messages }),
      });
      const response = await bedrock.send(command);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      for await (const event of response.body) {
        if (event.chunk?.bytes) {
          try { res.write(`data: ${JSON.stringify(JSON.parse(Buffer.from(event.chunk.bytes).toString('utf-8')))}\n\n`); } catch {}
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('[Bedrock]', err.message);
      if (!res.headersSent) json(res, 502, { error: { message: err.message } });
    }
    return;
  }

  // ── Jira ticket fetch ────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/jira') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }

    const { jiraUrl, email, token, ticketId } = body;
    if (!jiraUrl || !email || !token || !ticketId) {
      return json(res, 400, { error: 'jiraUrl, email, token, and ticketId are required' });
    }

    try {
      const auth    = Buffer.from(`${email}:${token}`).toString('base64');
      const apiUrl  = `${jiraUrl.replace(/\/$/, '')}/rest/api/3/issue/${ticketId}?fields=summary,description,status,priority,assignee,reporter,issuetype,labels,comment,attachment`;
      const result  = await httpsGet(apiUrl, { Authorization: `Basic ${auth}`, Accept: 'application/json' });

      if (result.status === 401) return json(res, 401, { error: 'Invalid Jira credentials' });
      if (result.status === 404) return json(res, 404, { error: `Ticket ${ticketId} not found` });
      if (result.status !== 200) return json(res, result.status, { error: `Jira returned ${result.status}` });

      const data   = JSON.parse(result.body.toString('utf-8'));
      const fields = data.fields;
      const comments = (fields.comment?.comments || []).slice(-10).map(c => ({
        author: c.author?.displayName || 'Unknown',
        date:   c.created?.slice(0, 10),
        text:   adfToText(c.body).trim(),
      })).filter(c => c.text);

      // Auto-fetch linked tickets (up to 4) so Claude gets full context
      const linkedTickets = [];
      for (const link of (fields.issuelinks || []).slice(0, 4)) {
        const linked = link.inwardIssue || link.outwardIssue;
        if (!linked) continue;
        try {
          const lUrl = `${jiraUrl.replace(/\/$/, '')}/rest/api/3/issue/${linked.key}?fields=summary,description,status,issuetype,labels`;
          const lr = await httpsGet(lUrl, { Authorization: `Basic ${auth}`, Accept: 'application/json' });
          if (lr.status === 200) {
            const ld = JSON.parse(lr.body.toString('utf-8'));
            const lf = ld.fields;
            linkedTickets.push({
              id:           ld.key,
              relationship: link.type?.name || 'relates to',
              summary:      lf.summary || '',
              description:  adfToText(lf.description).trim(),
              status:       lf.status?.name || '',
              type:         lf.issuetype?.name || '',
              url:          `${jiraUrl.replace(/\/$/, '')}/browse/${ld.key}`,
            });
          }
        } catch {}
      }

      const ticket = {
        id:          data.key,
        summary:     fields.summary || '',
        description: adfToText(fields.description).trim(),
        status:      fields.status?.name || '',
        priority:    fields.priority?.name || '',
        type:        fields.issuetype?.name || '',
        assignee:    fields.assignee?.displayName || 'Unassigned',
        reporter:    fields.reporter?.displayName || '',
        labels:      fields.labels || [],
        comments,
        linkedTickets,
        url:         `${jiraUrl.replace(/\/$/, '')}/browse/${data.key}`,
      };
      return json(res, 200, ticket);
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // ── Local file read ──────────────────────────────────────────────────────────
  if (pathname === '/api/file') {
    const filePath = decodeURIComponent(url.searchParams.get('path') || '');
    if (!filePath) return json(res, 400, { error: 'path parameter required' });

    const ext = path.extname(filePath).toLowerCase();
    const textExts = ['.txt','.md','.markdown','.json','.yaml','.yml','.csv','.xml','.html','.htm','.js','.ts','.py','.java','.cs','.go','.rb','.sh','.sql','.log'];

    try {
      if (textExts.includes(ext)) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        return json(res, 200, { name: path.basename(filePath), content, type: 'text' });
      }

      if (ext === '.docx') {
        if (!mammoth) return json(res, 415, { error: 'Install mammoth to read .docx files: npm install mammoth' });
        const result = await mammoth.extractRawText({ path: filePath });
        return json(res, 200, { name: path.basename(filePath), content: result.value, type: 'text' });
      }

      if (ext === '.pdf') {
        if (!pdfParse) return json(res, 415, { error: 'Install pdf-parse to read .pdf files: npm install pdf-parse' });
        const buf  = await fs.promises.readFile(filePath);
        const data = await pdfParse(buf);
        return json(res, 200, { name: path.basename(filePath), content: data.text, type: 'text' });
      }

      return json(res, 415, { error: `Unsupported file type: ${ext}` });
    } catch (err) {
      const code = err.code === 'ENOENT' ? 404 : 500;
      return json(res, code, { error: err.message });
    }
  }

  // ── Google Docs fetch ────────────────────────────────────────────────────────
  if (pathname === '/api/gdoc') {
    const docUrl = decodeURIComponent(url.searchParams.get('url') || '');
    const match  = docUrl.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    if (!match) return json(res, 400, { error: 'Invalid Google Docs URL' });

    const docId     = match[1];
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;

    try {
      const result = await httpsGet(exportUrl);
      if (result.status === 403 || result.status === 401) {
        return json(res, 403, { error: 'Document is private. In Google Docs → Share → set to "Anyone with the link" → Viewer.' });
      }
      if (result.status !== 200) return json(res, result.status, { error: `Google returned ${result.status}` });

      // Get title from a separate metadata request
      let title = docId;
      try {
        const meta = await httpsGet(`https://docs.google.com/document/d/${docId}/pub?embedded=true`);
        const titleMatch = meta.body.toString().match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) title = titleMatch[1].replace(' - Google Docs', '').trim();
      } catch {}

      return json(res, 200, { title, content: result.body.toString('utf-8'), url: docUrl });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // ── GitHub file fetch ────────────────────────────────────────────────────────
  if (pathname === '/api/github') {
    const repo     = decodeURIComponent(url.searchParams.get('repo')   || '');
    const filePath = decodeURIComponent(url.searchParams.get('path')   || '');
    const branch   = url.searchParams.get('branch') || 'main';
    const token    = url.searchParams.get('token')  || '';

    if (!repo || !filePath) return json(res, 400, { error: 'repo (owner/name) and path are required' });

    const apiUrl  = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`;
    const headers = { 'User-Agent': 'DocMap/1.0', 'Accept': 'application/vnd.github.v3+json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const result = await httpsGet(apiUrl, headers);
      if (result.status === 404) return json(res, 404, { error: `Not found in ${repo}: ${filePath}` });
      if (result.status === 403) return json(res, 403, { error: 'GitHub rate-limited or needs auth — add a token in Connections → GitHub' });
      if (result.status !== 200) return json(res, result.status, { error: `GitHub returned ${result.status}` });

      const data = JSON.parse(result.body.toString('utf-8'));
      if (Array.isArray(data)) {
        return json(res, 200, { type: 'directory', path: filePath, files: data.map(f => ({ name: f.name, path: f.path, type: f.type })) });
      }
      const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
      return json(res, 200, { type: 'file', name: data.name, path: data.path, content });
    } catch (err) {
      return json(res, 502, { error: err.message });
    }
  }

  // ── Static files ──────────────────────────────────────────────────────────────
  const reqPath  = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(__dirname, reqPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'text/plain');
    res.writeHead(200);
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  DocMap proxy running');
  console.log(`  ➜  http://localhost:${PORT}`);
  console.log(`  Region : ${REGION}`);
  console.log(`  .docx  : ${mammoth  ? '✓' : '✗  (run: npm install mammoth)'}`);
  console.log(`  .pdf   : ${pdfParse ? '✓' : '✗  (run: npm install pdf-parse)'}`);
  console.log('');
});

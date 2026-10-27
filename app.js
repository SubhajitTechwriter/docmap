/* ── DocMap application ── */

const API_URL = 'https://api.anthropic.com/v1/messages';
const STORAGE_KEY_API           = 'docmap_api_key';
const STORAGE_KEY_MODEL         = 'docmap_model';
const STORAGE_KEY_PROVIDER      = 'docmap_provider';
const STORAGE_KEY_PROXY_URL     = 'docmap_proxy_url';
const STORAGE_KEY_BEDROCK_MODEL = 'docmap_bedrock_model';
const STORAGE_KEY_JIRA_URL      = 'docmap_jira_url';
const STORAGE_KEY_JIRA_EMAIL    = 'docmap_jira_email';
const STORAGE_KEY_JIRA_TOKEN    = 'docmap_jira_token';
const STORAGE_KEY_GITHUB_TOKEN  = 'docmap_github_token';
const STORAGE_KEY_GITHUB_REPO   = 'docmap_github_repo';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  apiKey:        localStorage.getItem(STORAGE_KEY_API)           || null,
  model:         localStorage.getItem(STORAGE_KEY_MODEL)         || 'claude-sonnet-5-5',
  provider:      localStorage.getItem(STORAGE_KEY_PROVIDER)      || 'anthropic',
  proxyUrl:      localStorage.getItem(STORAGE_KEY_PROXY_URL)     || 'http://localhost:3001',
  bedrockModel:  localStorage.getItem(STORAGE_KEY_BEDROCK_MODEL) || 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  jira: {
    url:   localStorage.getItem(STORAGE_KEY_JIRA_URL)   || '',
    email: localStorage.getItem(STORAGE_KEY_JIRA_EMAIL) || '',
    token: localStorage.getItem(STORAGE_KEY_JIRA_TOKEN) || '',
  },
  github: {
    token: localStorage.getItem(STORAGE_KEY_GITHUB_TOKEN) || '',
    repo:  localStorage.getItem(STORAGE_KEY_GITHUB_REPO)  || '',
  },
  docsSitemap:   null, // { totalPages, summary, urls[] } — loaded on launch
  messages:      [],
  pendingFiles:  [],
  detections:    {},   // key → { type, value, status: 'pending'|'fetched'|'dismissed' }
  cy:            null,
  activeNode:    null,
  isStreaming:   false,
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

// ── System prompt ─────────────────────────────────────────────────────────────
// Built dynamically — includes the live docs sitemap when available
function buildSystemPrompt() {
  const base = `You are DocMap, an expert documentation strategist for SnapLogic. You help technical writers plan content changes for docs.snaplogic.com. You combine the insight of a senior doc lead with deep knowledge of the SnapLogic documentation structure.

ROLE: Analyze any input (Jira tickets, GitHub repos, release notes, specs, images, or plain descriptions) and tell the writer exactly what documentation needs to be created, modified, removed, or cross-referenced — including the specific page URLs on docs.snaplogic.com.`;

  const docsCtx = state.docsSitemap
    ? `\n\nDOCS.SNAPLOGIC.COM STRUCTURE (live index — ${state.docsSitemap.totalPages} pages):\n${state.docsSitemap.summary}\n\nFull URL list is available. When suggesting pages to update or create, always reference specific paths from this structure. Do NOT ask the writer where content lives — look it up from the index above.`
    : '\n\n(Documentation site index not loaded — proxy may not be running.)';

  return base + docsCtx + SYSTEM_PROMPT_TAIL;
}

const SYSTEM_PROMPT_TAIL = `

CONVERSATION STYLE:

CONVERSATION STYLE:
- Be warm but concise. Ask focused clarifying questions (1-2 at a time, never a list of 5).
- When you have enough context (usually after 2-4 exchanges), generate the mind map.
- The user can say "show the map" or "generate map" at any time to get it immediately.
- After generating a map, stay in conversation to refine it based on follow-up questions.
- If the user pastes a URL, acknowledge it and use it as context (you cannot fetch URLs directly, but the user may paste content from them).
- If the user mentions Jira ticket IDs or GitHub repos without pasting content, ask them to paste the relevant text/screenshot.

MIND MAP GENERATION:
When you decide to generate or update the mind map, include it at the END of your message using this exact format (nothing before the opening tag, nothing after the closing tag on that portion):

<mindmap>
{
  "center": {
    "id": "center",
    "label": "Change title (4-6 words)",
    "description": "One concise sentence describing the change"
  },
  "nodes": [
    {
      "id": "n1",
      "label": "Node label (3-4 words max)",
      "type": "create",
      "priority": "high",
      "url": null,
      "action_summary": "One-sentence action item",
      "what": "Detailed description of what content to add, change, or remove",
      "where": "Exact location in the documentation (path, section, nav level)",
      "how": "Step-by-step guidance for making the change",
      "content_hints": "Key points, warnings, examples, or related topics to include",
      "effort": "low",
      "group": "optional category label"
    }
  ],
  "edges": [
    { "source": "center", "target": "n1", "label": "requires" }
  ]
}
</mindmap>

NODE TYPES:
- "create"    — new page, section, or topic to add (green)
- "modify"    — existing content to update (amber)
- "delete"    — content to deprecate or remove (red)
- "reference" — add cross-links, mentions, or see-alsos (blue)

RULES:
- Generate 6-14 nodes per map. Include both primary and secondary impacts.
- priority: "high" | "medium" | "low"
- effort: "low" (<1h), "medium" (1-4h), "high" (>4h)
- url: real URL if you know it, otherwise null
- All text fields must be plain text (no markdown inside JSON).
- Always include edges connecting nodes to the center or to each other when there's a dependency.
- After the </mindmap> tag, add a brief 1-2 sentence summary of what the map shows.`;

// ── Setup screen ──────────────────────────────────────────────────────────────
function initSetup() {
  // If already configured, skip setup
  const alreadyConfigured = state.provider === 'anthropic' ? !!state.apiKey
                          : !!state.bedrockModel;
  if (alreadyConfigured) { launchApp(); return; }

  // Restore saved provider tab
  setProviderTab(state.provider);

  // Provider toggle
  document.querySelectorAll('.provider-btn').forEach(btn => {
    btn.addEventListener('click', () => setProviderTab(btn.dataset.provider));
  });

  // Anthropic: model selector
  if ($('setup-model')) {
    $('setup-model').value = state.model;
    $('setup-model').addEventListener('change', () => { state.model = $('setup-model').value; });
  }

  // Bedrock: text field is always visible; quick-pick fills it
  $('bedrock-model-custom').value = state.bedrockModel || '';
  $('bedrock-model-select').addEventListener('change', () => {
    if ($('bedrock-model-select').value) {
      $('bedrock-model-custom').value = $('bedrock-model-select').value;
      $('bedrock-model-select').value = ''; // reset to placeholder
    }
  });

  $('bedrock-fetch-models').addEventListener('click', async () => {
    const proxyUrl = $('bedrock-proxy').value.trim().replace(/\/$/, '') || 'http://localhost:3001';
    const btn = $('bedrock-fetch-models');
    btn.disabled = true;
    btn.textContent = '…';
    const errEl = $('setup-error');
    errEl.classList.add('hidden');
    try {
      const res  = await fetch(`${proxyUrl}/api/models`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.length) throw new Error('No Claude models found. Check your Bedrock model access permissions.');
      const sel = $('bedrock-model-select');
      // Remove old dynamic options
      Array.from(sel.options).filter(o => o.dataset.dynamic).forEach(o => o.remove());
      // Prepend fetched models
      data.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        opt.dataset.dynamic = '1';
        sel.insertBefore(opt, sel.options[1]); // after the placeholder
      });
      // Fill the text field with the best model
      $('bedrock-model-custom').value = data[0].id;
    } catch (e) {
      errEl.textContent = 'Load failed: ' + e.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Load';
    }
  });

  $('setup-btn').addEventListener('click', saveSettings);
  $('setup-key').addEventListener('keydown', e => { if (e.key === 'Enter') saveSettings(); });
}

function setProviderTab(provider) {
  state.provider = provider;
  document.querySelectorAll('.provider-btn').forEach(b => b.classList.toggle('active', b.dataset.provider === provider));
  $('setup-anthropic').classList.toggle('hidden', provider !== 'anthropic');
  $('setup-bedrock').classList.toggle('hidden',   provider !== 'bedrock');
}

async function saveSettings() {
  const errEl = $('setup-error');
  errEl.classList.add('hidden');
  const btn = $('setup-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  try {
    if (state.provider === 'anthropic') {
      const key = $('setup-key').value.trim();
      if (!key.startsWith('sk-ant-')) throw new Error('Key should start with sk-ant-');

      // Quick validation ping
      try {
        const resp = await fetch(API_URL, {
          method: 'POST',
          headers: buildHeaders(key),
          body: JSON.stringify({ model: state.model, max_tokens: 3, messages: [{ role: 'user', content: 'Hi' }] }),
        });
        if (resp.status === 401) throw new Error('Invalid API key — check and try again.');
      } catch (e) {
        if (e.message.includes('Invalid API')) throw e;
        // Network error etc — proceed
      }

      state.apiKey = key;
      state.model  = $('setup-model')?.value || state.model;
      localStorage.setItem(STORAGE_KEY_API,   state.apiKey);
      localStorage.setItem(STORAGE_KEY_MODEL, state.model);

    } else {
      // Bedrock via local proxy
      const proxyUrl = $('bedrock-proxy').value.trim().replace(/\/$/, '');
      const modelId = $('bedrock-model-custom').value.trim();

      if (!modelId) throw new Error('Please enter a model ID.');

      // Ping the proxy health endpoint
      try {
        const ping = await fetch(`${proxyUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
        if (!ping.ok) throw new Error('bad');
      } catch {
        throw new Error(`Cannot reach proxy at ${proxyUrl} — run npm start first.`);
      }

      state.proxyUrl     = proxyUrl;
      state.bedrockModel = modelId;
      localStorage.setItem(STORAGE_KEY_PROVIDER,      'bedrock');
      localStorage.setItem(STORAGE_KEY_PROXY_URL,     proxyUrl);
      localStorage.setItem(STORAGE_KEY_BEDROCK_MODEL, modelId);
    }

    localStorage.setItem(STORAGE_KEY_PROVIDER, state.provider);
    launchApp();

  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Continue →';
  }
}

function launchApp() {
  $('setup-overlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('header-model').textContent = state.provider === 'bedrock'
    ? `bedrock · ${state.bedrockModel.split('.').pop()}`
    : state.model;
  showWelcome();
  loadDocsSitemap(); // fire-and-forget; updates system prompt when ready
  initPanelResize();
}

function initPanelResize() {
  const divider  = $('panel-divider');
  const chatPane = $('chat-panel');
  if (!divider || !chatPane) return;
  let dragging = false;

  divider.addEventListener('mousedown', e => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = $('app').getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width * 100;
    chatPane.style.width = Math.max(18, Math.min(62, pct)) + '%';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

async function loadDocsSitemap() {
  const proxy = state.proxyUrl || 'http://localhost:3001';
  try {
    const resp = await fetch(`${proxy}/api/sitemap`);
    if (!resp.ok) return;
    state.docsSitemap = await resp.json();
    // Update the model label to show docs are loaded
    const lbl = $('header-model');
    lbl.textContent = lbl.textContent.replace(' · docs ✓', '') + ' · docs ✓';
    console.log(`[DocMap] Loaded ${state.docsSitemap.totalPages} docs pages from sitemap`);
  } catch {
    // Proxy not running or no sitemap — silently skip
  }
}

// ── Welcome message ───────────────────────────────────────────────────────────
function showWelcome() {
  const wrap = $('chat-messages');
  wrap.innerHTML = '';

  appendMessage('ai', `Hey! I'm **DocMap** — tell me about the documentation change you're planning. You can:

- Paste a **Jira ticket** description or ID
- Drop a **GitHub repo URL** or paste a README
- Paste **release notes, a spec, or a changelog entry**
- Upload a **screenshot or image** of any of the above
- Or just **describe the change** in plain words

Once I understand the scope, I'll generate an interactive mind map showing every doc page you need to create, update, or remove.`);

  // Quick-start chips
  const chips = el('div', 'flex flex-wrap gap-2 mt-2');
  [
    ['🎫 Jira Ticket', 'Here is the Jira ticket I\'m documenting:\n'],
    ['🐙 GitHub Repo', 'Here is the GitHub repo for this feature:\n'],
    ['📋 Release Notes', 'Here are the release notes:\n'],
    ['💬 Describe Change', 'I need to document the following change:\n'],
  ].forEach(([label, prefix]) => {
    const chip = el('button', 'chip', label);
    chip.addEventListener('click', () => {
      $('chat-input').value = prefix;
      $('chat-input').focus();
      autoGrow($('chat-input'));
    });
    chips.appendChild(chip);
  });

  wrap.lastElementChild?.querySelector('.msg-bubble')?.appendChild(chips);
}

// ── Chat rendering ─────────────────────────────────────────────────────────────
function appendMessage(role, text, images = []) {
  const wrap = $('chat-messages');

  const row = el('div', `msg-row ${role}`);
  const avatar = el('div', `msg-avatar ${role}`, role === 'ai' ? 'DM' : 'You');
  const bubble = el('div', 'msg-bubble');

  bubble.innerHTML = parseMarkdown(text);

  if (images.length) {
    const grid = el('div', 'msg-img-grid');
    images.forEach(src => {
      const img = el('img');
      img.src = src;
      grid.appendChild(img);
    });
    bubble.appendChild(grid);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  wrap.appendChild(row);
  wrap.scrollTop = wrap.scrollHeight;
  return bubble;
}

function showTyping() {
  const wrap = $('chat-messages');
  const row = el('div', 'msg-row ai', `
    <div class="msg-avatar ai">DM</div>
    <div class="msg-bubble">
      <div class="typing-dots"><span></span><span></span><span></span></div>
    </div>`);
  row.id = 'typing-row';
  wrap.appendChild(row);
  wrap.scrollTop = wrap.scrollHeight;
}

function removeTyping() {
  $('typing-row')?.remove();
}

// ── Markdown parser (minimal) ─────────────────────────────────────────────────
function parseMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>(?:\s*<li>[\s\S]+?<\/li>)*)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(.+)$/, '<p>$1</p>')
    .replace(/<p><ul>/g, '<ul>').replace(/<\/ul><\/p>/g, '</ul>');
}

// ── File / image handling ─────────────────────────────────────────────────────
function initFileHandling() {
  $('file-input').addEventListener('change', e => {
    Array.from(e.target.files).forEach(addFile);
    e.target.value = '';
  });

  $('chat-input').addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addFile(file);
      }
    }
  });
}

function addFile(file) {
  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = ev => {
      const entry = { type: 'image', name: file.name, dataUrl: ev.target.result, mediaType: file.type };
      state.pendingFiles.push(entry);
      renderAttachStrip();
    };
    reader.readAsDataURL(file);
  } else {
    const reader = new FileReader();
    reader.onload = ev => {
      const entry = { type: 'text', name: file.name, text: ev.target.result };
      state.pendingFiles.push(entry);
      renderAttachStrip();
    };
    reader.readAsText(file);
  }
}

function renderAttachStrip() {
  const strip = $('attachment-strip');
  if (state.pendingFiles.length === 0) { strip.classList.add('hidden'); strip.innerHTML = ''; return; }
  strip.classList.remove('hidden');
  strip.innerHTML = '';
  state.pendingFiles.forEach((f, i) => {
    const thumb = el('div', 'attach-thumb');
    if (f.type === 'image') {
      const img = el('img'); img.src = f.dataUrl; thumb.appendChild(img);
    } else {
      const t = el('div', 'text', f.name); thumb.appendChild(t);
    }
    const rm = el('div', 'rm', '×');
    rm.addEventListener('click', () => { state.pendingFiles.splice(i, 1); renderAttachStrip(); });
    thumb.appendChild(rm);
    strip.appendChild(thumb);
  });
}

// ── Send message ───────────────────────────────────────────────────────────────
async function sendMessage() {
  if (state.isStreaming) return;

  const text = $('chat-input').value.trim();
  if (!text && state.pendingFiles.length === 0) return;

  // Auto-fetch any pending detections before sending
  const pending = Object.entries(state.detections).filter(([, d]) => d.status === 'pending');
  if (pending.length) {
    $('btn-send').disabled = true;
    await Promise.all(pending.map(([key]) => fetchDetected(key)));
    $('btn-send').disabled = false;
  }

  const files = [...state.pendingFiles];
  if (!text && files.length === 0) return;

  // Build user content for Claude API
  const contentBlocks = [];
  const imageUrls = [];

  files.forEach(f => {
    if (f.type === 'image') {
      const base64 = f.dataUrl.split(',')[1];
      contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: base64 } });
      imageUrls.push(f.dataUrl);
    } else {
      contentBlocks.push({ type: 'text', text: `[File: ${f.name}]\n${f.text}` });
    }
  });

  if (text) contentBlocks.push({ type: 'text', text });

  const userMessageContent = contentBlocks.length === 1 && contentBlocks[0].type === 'text'
    ? contentBlocks[0].text
    : contentBlocks;

  // Show in chat
  appendMessage('user', text || `[${files.map(f => f.name).join(', ')}]`, imageUrls);

  // Reset input
  $('chat-input').value = '';
  autoGrow($('chat-input'));
  state.pendingFiles = [];
  renderAttachStrip();

  // Add to history
  state.messages.push({ role: 'user', content: userMessageContent });

  // Call Claude (streaming)
  state.isStreaming = true;
  $('btn-send').disabled = true;
  showTyping();

  try {
    const fullResponse = await callClaudeStream(state.messages, buildSystemPrompt(), (partial) => {
      updateStreamingBubble(partial);
    });
    removeTyping();
    const { displayText, mindmapJson } = extractMindmap(fullResponse);
    finalizeStreamingBubble(displayText, mindmapJson);
    state.messages.push({ role: 'assistant', content: fullResponse });
  } catch (err) {
    removeTyping();
    appendMessage('ai', `Sorry, I hit an error: ${err.message}. Please check your API key and try again.`);
  } finally {
    state.isStreaming = false;
    $('btn-send').disabled = false;
  }
}

// ── Streaming Claude API ──────────────────────────────────────────────────────
function buildHeaders(key) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': key || state.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

async function callClaudeStream(messages, system, onPartial) {
  return state.provider === 'bedrock'
    ? callBedrockStream(messages, system, onPartial)
    : callAnthropicStream(messages, system, onPartial);
}

async function callAnthropicStream(messages, system, onPartial) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({ model: state.model, max_tokens: 4096, stream: true, system, messages }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error?.message || `HTTP ${response.status}`);
  }

  return consumeSSE(response, onPartial);
}

async function callBedrockStream(messages, system, onPartial) {
  const response = await fetch(`${state.proxyUrl}/api/bedrock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: state.bedrockModel, messages, system, max_tokens: 4096 }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error((errData.error?.message || `Proxy error ${response.status}`) + ` [model: ${state.bedrockModel}]`);
  }

  return consumeSSE(response, onPartial);
}

// Shared SSE consumer — works for both Anthropic and Bedrock proxy
async function consumeSSE(response, onPartial) {
  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer   = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (json === '[DONE]') continue;
      try {
        const ev = JSON.parse(json);
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          fullText += ev.delta.text;
          const { displayText } = extractMindmap(fullText);
          onPartial(displayText);
        }
      } catch {}
    }
  }

  return fullText;
}

// ── Streaming bubble management ───────────────────────────────────────────────
let streamingBubble = null;

function updateStreamingBubble(text) {
  if (!streamingBubble) {
    removeTyping();
    const wrap = $('chat-messages');
    const row = el('div', 'msg-row ai');
    const avatar = el('div', 'msg-avatar ai', 'DM');
    streamingBubble = el('div', 'msg-bubble');
    streamingBubble.innerHTML = parseMarkdown(text);
    row.appendChild(avatar);
    row.appendChild(streamingBubble);
    wrap.appendChild(row);
  } else {
    streamingBubble.innerHTML = parseMarkdown(text);
  }
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function finalizeStreamingBubble(displayText, mindmapJson) {
  if (streamingBubble) {
    streamingBubble.innerHTML = parseMarkdown(displayText);
    if (mindmapJson) {
      try {
        const data = JSON.parse(mindmapJson);
        renderMindMap(data);
        const badge = el('div', 'map-updated-badge',
          `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/>
          </svg> Mind map updated`);
        streamingBubble.appendChild(badge);
      } catch {
        // silently ignore bad JSON
      }
    }
    streamingBubble = null;
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  }
}

// ── Mindmap extraction from response text ─────────────────────────────────────
function extractMindmap(text) {
  const start = text.indexOf('<mindmap>');

  // No mindmap block at all
  if (start === -1) return { displayText: text, mindmapJson: null };

  const end = text.indexOf('</mindmap>');

  // <mindmap> found but </mindmap> not yet (still streaming) — hide the raw JSON
  if (end === -1 || end < start) {
    return { displayText: text.slice(0, start).trim(), mindmapJson: null };
  }

  const mindmapJson = text.slice(start + '<mindmap>'.length, end).trim();
  const displayText = (text.slice(0, start) + text.slice(end + '</mindmap>'.length)).trim();
  return { displayText, mindmapJson };
}

// ── Mind Map rendering ─────────────────────────────────────────────────────────
const NODE_STYLE = {
  center:    { bg: '#7c3aed', border: '#c4b5fd', text: '#ffffff' },
  create:    { bg: '#059669', border: '#6ee7b7', text: '#ffffff' },
  modify:    { bg: '#b45309', border: '#fcd34d', text: '#ffffff' },
  delete:    { bg: '#b91c1c', border: '#fca5a5', text: '#ffffff' },
  reference: { bg: '#1d4ed8', border: '#93c5fd', text: '#ffffff' },
};

function renderMindMap(data) {
  if (!data?.center || !data?.nodes) return;

  $('map-empty-state').style.display = 'none';
  $('map-controls').classList.remove('hidden');
  $('btn-export-png').style.display = '';
  // Reset hint so it shows on each new map
  const hint = $('map-hint');
  hint.style.transition = '';
  hint.style.opacity = '1';
  hint.classList.remove('hidden');

  const elements = [];

  // Center
  elements.push({ data: { id: 'center', label: data.center.label, type: 'center', nodeData: data.center } });

  // Nodes
  data.nodes.forEach(n => {
    elements.push({ data: { id: n.id, label: n.label, type: n.type || 'reference', nodeData: n } });
  });

  // Edges
  (data.edges || []).forEach((e, i) => {
    elements.push({ data: { id: `e_${i}`, source: e.source, target: e.target, label: e.label || '' } });
  });

  if (state.cy) { state.cy.destroy(); state.cy = null; }

  state.cy = cytoscape({
    container: $('cy'),
    elements,
    style: buildStyle(),
    layout: {
      name: 'cose',
      animate: true,
      animationDuration: 800,
      randomize: false,
      nodeRepulsion: () => 20000,
      nodeOverlap: 24,
      idealEdgeLength: () => 180,
      edgeElasticity: () => 100,
      nestingFactor: 5,
      gravity: 50,
      numIter: 1000,
      initialTemp: 200,
      coolingFactor: 0.95,
      minTemp: 1.0,
      fit: true,
      padding: 80,
      componentSpacing: 80,
    },
    minZoom: 0.25,
    maxZoom: 3,
    wheelSensitivity: 0.25,
  });

  state.cy.on('tap', 'node', evt => {
    const d = evt.target.data();
    if (d.type !== 'center') openModal(d.nodeData, d.type);
  });

  // Fade out the hint after first interaction
  state.cy.one('tap', () => {
    const hint = $('map-hint');
    hint.style.transition = 'opacity 0.4s';
    hint.style.opacity = '0';
    setTimeout(() => hint.classList.add('hidden'), 400);
  });

  // Controls
  $('btn-zoom-in').onclick  = () => state.cy.zoom({ level: state.cy.zoom() * 1.25, renderedPosition: center() });
  $('btn-zoom-out').onclick = () => state.cy.zoom({ level: state.cy.zoom() * 0.8,  renderedPosition: center() });
  $('btn-zoom-fit').onclick = () => state.cy.fit(undefined, 50);
  $('btn-export-png').onclick = exportPng;
}

function center() {
  const c = $('cy');
  return { x: c.clientWidth / 2, y: c.clientHeight / 2 };
}

function buildStyle() {
  const nodeStyles = Object.entries(NODE_STYLE).map(([type, colors]) => ({
    selector: type === 'center' ? 'node[type="center"]' : `node[type="${type}"]`,
    style: {
      'label': 'data(label)',
      'text-wrap': 'wrap',
      'text-max-width': type === 'center' ? '150px' : '120px',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-size': type === 'center' ? '13px' : '11px',
      'font-weight': '700',
      'font-family': 'ui-sans-serif, system-ui, sans-serif',
      'width':  type === 'center' ? '170px' : '145px',
      'height': type === 'center' ? '60px'  : '48px',
      'shape': 'round-rectangle',
      'background-color': colors.bg,
      'border-color': colors.border,
      'border-width': type === 'center' ? '3px' : '2px',
      'color': colors.text,
      'cursor': 'pointer',
      'shadow-blur': 16,
      'shadow-color': colors.bg,
      'shadow-opacity': 0.55,
      'shadow-offset-x': 0,
      'shadow-offset-y': 3,
    },
  }));

  return [
    ...nodeStyles,
    {
      selector: 'node:selected',
      style: { 'border-width': '3px', 'border-color': '#f8fafc', 'shadow-opacity': 0.9, 'overlay-opacity': 0 },
    },
    {
      selector: 'edge',
      style: {
        'width': 2,
        'line-color': '#475569',
        'target-arrow-color': '#475569',
        'target-arrow-shape': 'vee',
        'arrow-scale': 0.9,
        'curve-style': 'bezier',
        'label': 'data(label)',
        'font-size': '9px',
        'color': '#94a3b8',
        'text-background-color': '#0d1117',
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
        'opacity': 0.75,
      },
    },
  ];
}

function exportPng() {
  if (!state.cy) return;
  const png = state.cy.png({ scale: 2, bg: '#020617', full: true });
  const a = document.createElement('a');
  a.href = png;
  a.download = `docmap-${Date.now()}.png`;
  a.click();
}

// ── Node detail modal ─────────────────────────────────────────────────────────
function openModal(nodeData, type) {
  state.activeNode = { nodeData, type };

  $('modal-title').textContent = nodeData.label || '—';

  const typeBadge = $('modal-type-badge');
  typeBadge.textContent = capitalize(type);
  typeBadge.className = `badge-type ${type}`;

  $('modal-priority-badge').textContent = capitalize(nodeData.priority || 'medium') + ' priority';
  const effortMap = { low: '<1h', medium: '1-4h', high: '>4h' };
  $('modal-effort-badge').textContent = 'Effort: ' + (effortMap[nodeData.effort] || nodeData.effort || '?');

  const urlEl = $('modal-url');
  if (nodeData.url) {
    urlEl.href = nodeData.url;
    urlEl.textContent = nodeData.url.length > 55 ? nodeData.url.slice(0, 52) + '…' : nodeData.url;
    urlEl.classList.remove('hidden');
  } else {
    urlEl.classList.add('hidden');
  }

  $('tab-what').innerHTML  = fmt(nodeData.what || nodeData.action_summary || '—');
  $('tab-where').innerHTML = fmt(nodeData.where || '—');
  $('tab-how').innerHTML   = fmt(nodeData.how || '—');
  $('tab-hints').innerHTML = fmt(nodeData.content_hints || '—');

  activateTab('what');
  $('modal').classList.remove('hidden');
}

function fmt(text) {
  if (!text) return '<em class="text-slate-500">—</em>';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-•]\s+(.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/\n/g, '<br>');
}

function activateTab(name) {
  document.querySelectorAll('.modal-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${name}`));
}

function closeModal() { $('modal').classList.add('hidden'); state.activeNode = null; }

// ── Utility ───────────────────────────────────────────────────────────────────
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

// ── Auto-detection engine ─────────────────────────────────────────────────────
const DETECT = [
  {
    type:  'jira',
    icon:  '🎫',
    label: v => `Jira ${v}`,
    // bare ticket ID OR full Jira URL
    scan:  text => {
      const ids = new Set();
      for (const m of text.matchAll(/\b([A-Z]{2,10}-\d+)\b/g))      ids.add(m[1]);
      for (const m of text.matchAll(/\/browse\/([A-Z]{2,10}-\d+)/g)) ids.add(m[1]);
      return [...ids].map(id => ({ value: id }));
    },
  },
  {
    type:  'gdoc',
    icon:  '📄',
    label: () => 'Google Doc',
    scan:  text => {
      const hits = [];
      for (const m of text.matchAll(/https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)[^\s]*/g)) {
        hits.push({ value: m[0] });
      }
      return hits;
    },
  },
  {
    type:  'github',
    icon:  '📦',
    label: v => { try { return new URL(v).pathname.split('/').filter(Boolean).slice(4).join('/') || 'GitHub file'; } catch { return 'GitHub file'; } },
    scan:  text => {
      const hits = new Set();
      for (const m of text.matchAll(/https?:\/\/github\.com\/[^\s"'\n]+?\.dita(?:map)?[^\s"'\n]*/g)) hits.add(m[0].replace(/[,;.]+$/, ''));
      for (const m of text.matchAll(/https?:\/\/raw\.githubusercontent\.com\/[^\s"'\n]+/g)) hits.add(m[0].replace(/[,;.]+$/, ''));
      return [...hits].map(v => ({ value: v }));
    },
  },
  {
    type:  'file',
    icon:  '📁',
    label: v => v.replace(/.*[/\\]/, ''), // basename
    scan:  text => {
      const hits = new Set();
      // Windows paths: C:\... or D:\...
      for (const m of text.matchAll(/\b[A-Za-z]:\\[^\s"'\n,]+/g)) hits.add(m[0].replace(/[,;.]+$/, ''));
      // Unix-style absolute paths
      for (const m of text.matchAll(/(?:^|[\s"])(\/(Users|home|Documents|Downloads|tmp|var|opt|etc)[^\s"'\n,]*)/g)) hits.add(m[1].replace(/[,;.]+$/, ''));
      return [...hits].map(v => ({ value: v }));
    },
  },
];

let detectTimer = null;

function scheduleDetection() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => runDetection($('chat-input').value), 350);
}

function runDetection(text) {
  const strip = $('detect-strip');
  const found = new Map(); // key → {type, value, icon, label}

  DETECT.forEach(d => {
    d.scan(text).forEach(({ value }) => {
      const key = `${d.type}:${value}`;
      if (!state.detections[key] || state.detections[key].status === 'dismissed') return;
      if (state.detections[key]?.status === 'fetched') { found.set(key, null); return; } // keep fetched chip
      found.set(key, { type: d.type, value, icon: d.icon, label: d.label(value), key });
    });
  });

  // First pass: add new detections
  DETECT.forEach(d => {
    d.scan(text).forEach(({ value }) => {
      const key = `${d.type}:${value}`;
      if (!(key in state.detections)) {
        state.detections[key] = { type: d.type, value, status: 'pending' };
        found.set(key, { type: d.type, value, icon: d.icon, label: d.label(value), key });
      }
    });
  });

  // Rebuild the strip
  strip.innerHTML = '';
  let visible = 0;

  Object.entries(state.detections).forEach(([key, det]) => {
    if (det.status === 'dismissed') return;
    const parts = key.split(':');
    const d = DETECT.find(x => x.type === parts[0]);
    if (!d) return;
    const chip = buildDetectChip(key, d.icon, d.label(det.value), det.status, det.type);
    strip.appendChild(chip);
    visible++;
  });

  strip.classList.toggle('hidden', visible === 0);
}

function buildDetectChip(key, icon, label, status, type) {
  const chip = el('div', `detect-chip ${status}`, `
    <span class="detect-icon">${icon}</span>
    <span class="detect-label">${escapeHtml(label)}</span>
    ${status === 'pending'  ? `<button class="detect-fetch" data-key="${key}">Fetch ↗</button>` : ''}
    ${status === 'fetching' ? `<span class="detect-loading">…</span>` : ''}
    ${status === 'fetched'  ? `<span class="detect-done">✓ attached</span>` : ''}
    ${status !== 'fetched'  ? `<button class="detect-dismiss" data-key="${key}">×</button>` : ''}
  `);

  chip.querySelector('.detect-fetch')?.addEventListener('click', () => fetchDetected(key));
  chip.querySelector('.detect-dismiss')?.addEventListener('click', () => {
    state.detections[key].status = 'dismissed';
    chip.remove();
    if (!$('detect-strip').children.length) $('detect-strip').classList.add('hidden');
  });

  return chip;
}

async function fetchDetected(key) {
  const det = state.detections[key];
  if (!det) return;
  det.status = 'fetching';
  runDetection($('chat-input').value); // re-render chip as loading

  try {
    let content = '';
    let displayName = '';

    if (det.type === 'jira') {
      if (!state.jira.url || !state.jira.email || !state.jira.token) {
        appendMessage('ai', '⚙️ Jira isn\'t connected yet — click the 🔗 icon in the header to add your credentials.');
        det.status = 'pending';
        runDetection($('chat-input').value);
        return;
      }
      const proxy = state.provider === 'bedrock' ? state.proxyUrl : 'http://localhost:3001';
      const resp = await fetch(`${proxy}/api/jira`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jiraUrl: state.jira.url, email: state.jira.email, token: state.jira.token, ticketId: det.value }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `Jira error ${resp.status}`);
      displayName = `Jira ${data.id}: ${data.summary}`;
      content = formatJiraForClaude(data);

    } else if (det.type === 'gdoc') {
      const proxy = state.provider === 'bedrock' ? state.proxyUrl : 'http://localhost:3001';
      const resp = await fetch(`${proxy}/api/gdoc?url=${encodeURIComponent(det.value)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `Google Docs error ${resp.status}`);
      displayName = `Google Doc: ${data.title}`;
      content = `[Google Doc: ${data.title}]\n${data.content}`;

    } else if (det.type === 'github') {
      // Convert github.com/owner/repo/blob/branch/path/to/file → API params
      const m = det.value.match(/github\.com\/([^/]+\/[^/]+)\/blob\/([^/]+)\/(.+)/);
      if (!m) throw new Error('Unrecognized GitHub URL — expected github.com/owner/repo/blob/branch/path');
      const [, repo, branch, filePath] = m;
      const proxy = state.provider === 'bedrock' ? state.proxyUrl : 'http://localhost:3001';
      const params = new URLSearchParams({ repo, path: filePath, branch });
      if (state.github.token) params.set('token', state.github.token);
      const resp = await fetch(`${proxy}/api/github?${params}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `GitHub error ${resp.status}`);
      displayName = data.name || filePath.split('/').pop();
      content = `[GitHub: ${repo}/${filePath}]\n${data.content}`;

    } else if (det.type === 'file') {
      const proxy = state.provider === 'bedrock' ? state.proxyUrl : 'http://localhost:3001';
      const resp = await fetch(`${proxy}/api/file?path=${encodeURIComponent(det.value)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `File error ${resp.status}`);
      displayName = data.name;
      content = `[File: ${data.name}]\n${data.content}`;
    }

    // Add as a text attachment
    state.pendingFiles.push({ type: 'text', name: displayName, text: content });
    renderAttachStrip();
    det.status = 'fetched';
    runDetection($('chat-input').value);

  } catch (err) {
    det.status = 'pending';
    runDetection($('chat-input').value);
    appendMessage('ai', `Couldn't fetch **${det.value}**: ${err.message}`);
  }
}

function formatJiraForClaude(t) {
  let out = `[Jira ${t.type}: ${t.id}]\nSummary: ${t.summary}\nStatus: ${t.status} | Priority: ${t.priority} | Assignee: ${t.assignee}\nURL: ${t.url}\n`;
  if (t.labels?.length) out += `Labels: ${t.labels.join(', ')}\n`;
  if (t.description) out += `\nDescription:\n${t.description}`;
  if (t.comments?.length) {
    out += `\n\nComments (${t.comments.length} recent):\n`;
    t.comments.forEach(c => { out += `\n[${c.author} – ${c.date}]\n${c.text}\n`; });
  }
  if (t.linkedTickets?.length) {
    out += `\n\n=== LINKED TICKETS (auto-fetched) ===\n`;
    t.linkedTickets.forEach(lt => {
      out += `\n[${lt.relationship.toUpperCase()}] ${lt.type}: ${lt.id} — ${lt.summary} (${lt.status})\nURL: ${lt.url}\n`;
      if (lt.description) out += `\n${lt.description}\n`;
    });
  }
  return out;
}

// ── Connections modal ─────────────────────────────────────────────────────────
function initConnections() {
  // Load saved Jira creds into form
  if ($('jira-url'))   $('jira-url').value   = state.jira.url;
  if ($('jira-email')) $('jira-email').value = state.jira.email;
  if ($('jira-token')) $('jira-token').value = state.jira.token;

  // Load saved GitHub settings
  if ($('github-token')) $('github-token').value = state.github.token;
  if ($('github-repo'))  $('github-repo').value  = state.github.repo;

  $('github-save')?.addEventListener('click', () => {
    state.github.token = $('github-token').value.trim();
    state.github.repo  = $('github-repo').value.trim();
    localStorage.setItem(STORAGE_KEY_GITHUB_TOKEN, state.github.token);
    localStorage.setItem(STORAGE_KEY_GITHUB_REPO,  state.github.repo);
    updateConnDot();
    showConnStatus('github', '✓ Saved', 'green');
  });

  updateConnDot();

  $('btn-connections').addEventListener('click', () => {
    $('conn-modal').classList.remove('hidden');
    activateConnTab('jira');
  });
  $('conn-close').addEventListener('click', () => $('conn-modal').classList.add('hidden'));
  $('conn-backdrop').addEventListener('click', () => $('conn-modal').classList.add('hidden'));

  document.querySelectorAll('.conn-tab').forEach(t => {
    t.addEventListener('click', () => activateConnTab(t.dataset.tab));
  });

  $('jira-save').addEventListener('click', saveJira);
  $('jira-test').addEventListener('click', testJira);
}

function activateConnTab(name) {
  document.querySelectorAll('.conn-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.conn-pane').forEach(p => p.classList.toggle('hidden', p.id !== `conn-tab-${name}`));
}

function updateConnDot() {
  const connected = (state.jira.url && state.jira.token) || state.github.repo;
  $('conn-dot').classList.toggle('hidden', !connected);
}

async function saveJira() {
  state.jira.url   = $('jira-url').value.trim().replace(/\/$/, '');
  state.jira.email = $('jira-email').value.trim();
  state.jira.token = $('jira-token').value.trim();
  localStorage.setItem(STORAGE_KEY_JIRA_URL,   state.jira.url);
  localStorage.setItem(STORAGE_KEY_JIRA_EMAIL, state.jira.email);
  localStorage.setItem(STORAGE_KEY_JIRA_TOKEN, state.jira.token);
  updateConnDot();
  showConnStatus('jira', '✓ Saved', 'green');
}

async function testJira() {
  const url   = $('jira-url').value.trim().replace(/\/$/, '');
  const email = $('jira-email').value.trim();
  const token = $('jira-token').value.trim();
  if (!url || !email || !token) { showConnStatus('jira', '✗ Fill in all fields first', 'red'); return; }

  showConnStatus('jira', 'Testing…', 'gray');
  const proxy = state.provider === 'bedrock' ? state.proxyUrl : 'http://localhost:3001';
  try {
    const resp = await fetch(`${proxy}/api/jira`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jiraUrl: url, email, token, ticketId: '_test_' }),
    });
    const data = await resp.json();
    // 404 on _test_ ticket = connection works, just ticket not found
    if (resp.ok || resp.status === 404 || (data.error && data.error.includes('not found'))) {
      showConnStatus('jira', '✓ Connected to Jira', 'green');
    } else if (resp.status === 401) {
      showConnStatus('jira', '✗ Invalid credentials', 'red');
    } else {
      showConnStatus('jira', `✗ ${data.error || resp.status}`, 'red');
    }
  } catch (e) {
    showConnStatus('jira', `✗ ${e.message} — is the proxy running?`, 'red');
  }
}

function showConnStatus(tab, msg, color) {
  const el2 = $(`${tab}-status`);
  el2.textContent = msg;
  el2.className = `text-xs mt-1 ${color === 'green' ? 'text-green-400' : color === 'red' ? 'text-red-400' : 'text-slate-400'}`;
  el2.classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Event listeners ───────────────────────────────────────────────────────────
function initEvents() {
  // Send
  $('btn-send').addEventListener('click', sendMessage);
  $('chat-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });
  $('chat-input').addEventListener('input', () => { autoGrow($('chat-input')); scheduleDetection(); });
  $('chat-input').addEventListener('paste', () => setTimeout(scheduleDetection, 50));

  // New chat
  $('btn-new-chat').addEventListener('click', () => {
    state.messages = [];
    state.detections = {};
    $('detect-strip').innerHTML = '';
    $('detect-strip').classList.add('hidden');
    if (state.cy) { state.cy.destroy(); state.cy = null; }
    $('map-empty-state').style.display = '';
    $('map-controls').classList.add('hidden');
    $('map-hint').classList.add('hidden');
    $('map-hint').style.opacity = '1';
    $('map-hint').style.transition = '';
    $('btn-export-png').style.display = 'none';
    showWelcome();
  });

  // Change key / settings
  $('btn-change-key').addEventListener('click', () => {
    [STORAGE_KEY_API, STORAGE_KEY_PROVIDER, STORAGE_KEY_PROXY_URL, STORAGE_KEY_BEDROCK_MODEL].forEach(k => localStorage.removeItem(k));
    state.apiKey = null;
    state.messages = [];
    $('app').classList.add('hidden');
    $('setup-overlay').classList.remove('hidden');
    $('setup-key').value = '';
    setProviderTab(state.provider);
  });

  // Modal
  $('modal-close').addEventListener('click', closeModal);
  $('modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  document.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  });

  // "Ask DocMap about this node" button
  $('modal-ask-btn').addEventListener('click', () => {
    if (!state.activeNode) return;
    closeModal();
    const { nodeData, type } = state.activeNode;
    $('chat-input').value = `Tell me more about the "${nodeData.label}" node (type: ${type}). What specifically should I do and what are the dependencies?`;
    autoGrow($('chat-input'));
    $('chat-input').focus();
  });

  // GitHub URL auto-detect & fetch
  $('chat-input').addEventListener('paste', async e => {
    await new Promise(r => setTimeout(r, 0)); // wait for paste to land
    const val = $('chat-input').value.trim();
    const ghMatch = val.match(/^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/?$/);
    if (ghMatch) {
      const [, owner, repo] = ghMatch;
      fetchGitHubReadme(owner, repo);
    }
  });

  // Zoom controls (keyboard shortcuts)
  document.addEventListener('keydown', e => {
    if (e.target === $('chat-input') || e.target === $('setup-key')) return;
    if (!state.cy) return;
    if (e.key === '+' || e.key === '=') state.cy.zoom({ level: state.cy.zoom() * 1.2, renderedPosition: center() });
    if (e.key === '-') state.cy.zoom({ level: state.cy.zoom() * 0.8, renderedPosition: center() });
    if (e.key === '0') state.cy.fit(undefined, 50);
  });
}

// ── GitHub README fetch ───────────────────────────────────────────────────────
async function fetchGitHubReadme(owner, repo) {
  try {
    const resp = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: { Accept: 'application/vnd.github.v3.raw' },
    });
    if (!resp.ok) return;
    const text = await resp.text();
    const current = $('chat-input').value;
    const url = `https://github.com/${owner}/${repo}`;
    // Replace the bare URL with a rich version
    if (current.trim() === url) {
      $('chat-input').value = `Here is the GitHub repo ${url} — I've fetched the README:\n\n${text.slice(0, 4000)}`;
      autoGrow($('chat-input'));
    }
  } catch {}
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSetup();
  initFileHandling();
  initConnections();
  initEvents();
});

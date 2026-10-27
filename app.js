/* ── DocMap application ── */

const API_URL = 'https://api.anthropic.com/v1/messages';
const STORAGE_KEY_API          = 'docmap_api_key';
const STORAGE_KEY_MODEL        = 'docmap_model';
const STORAGE_KEY_PROVIDER     = 'docmap_provider';
const STORAGE_KEY_PROXY_URL    = 'docmap_proxy_url';
const STORAGE_KEY_BEDROCK_MODEL = 'docmap_bedrock_model';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  apiKey:        localStorage.getItem(STORAGE_KEY_API)           || null,
  model:         localStorage.getItem(STORAGE_KEY_MODEL)         || 'claude-sonnet-5-5',
  provider:      localStorage.getItem(STORAGE_KEY_PROVIDER)      || 'anthropic',
  proxyUrl:      localStorage.getItem(STORAGE_KEY_PROXY_URL)     || 'http://localhost:3001',
  bedrockModel:  localStorage.getItem(STORAGE_KEY_BEDROCK_MODEL) || 'us.anthropic.claude-sonnet-4-5-20260101-v1:0',
  messages:      [],
  pendingFiles:  [],
  cy:            null,
  activeNode:    null,
  isStreaming:   false,
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are DocMap, an expert documentation strategist who helps technical writers plan content changes. You combine the insight of a senior doc lead with a clear understanding of product docs structure.

ROLE: Analyze any input (Jira tickets, GitHub repos, release notes, specs, images, or plain descriptions) and help the writer understand exactly what documentation needs to be created, modified, removed, or cross-referenced.

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

  // Bedrock: show/hide custom model input
  $('bedrock-model-select').value = state.bedrockModel || 'us.anthropic.claude-sonnet-4-5-20260101-v1:0';
  $('bedrock-model-select').addEventListener('change', () => {
    const isCustom = $('bedrock-model-select').value === 'custom';
    $('bedrock-model-custom').classList.toggle('hidden', !isCustom);
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
      const modelId  = $('bedrock-model-select').value === 'custom'
        ? $('bedrock-model-custom').value.trim()
        : $('bedrock-model-select').value;

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
    const fullResponse = await callClaudeStream(state.messages, SYSTEM_PROMPT, (partial) => {
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
    throw new Error(errData.error?.message || `Proxy error ${response.status} — is the local server running?`);
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
  center:    { bg: '#3730a3', border: '#818cf8', text: '#e0e7ff' },
  create:    { bg: '#14532d', border: '#22c55e', text: '#86efac' },
  modify:    { bg: '#78350f', border: '#f59e0b', text: '#fcd34d' },
  delete:    { bg: '#7f1d1d', border: '#ef4444', text: '#fca5a5' },
  reference: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
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
      animationDuration: 700,
      randomize: true,
      nodeRepulsion: () => 12000,
      nodeOverlap: 30,
      idealEdgeLength: () => 200,
      edgeElasticity: () => 80,
      gravity: 60,
      numIter: 1200,
      fit: true,
      padding: 70,
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
  const shared = {
    'label': 'data(label)',
    'text-wrap': 'wrap',
    'text-max-width': '100px',
    'text-valign': 'center',
    'text-halign': 'center',
    'font-size': '11px',
    'font-weight': '600',
    'font-family': 'ui-sans-serif, system-ui, sans-serif',
    'width': '120px',
    'height': '46px',
    'shape': 'round-rectangle',
    'border-width': '2px',
    'cursor': 'pointer',
  };

  const nodeStyles = Object.entries(NODE_STYLE).map(([type, colors]) => ({
    selector: type === 'center' ? 'node[type="center"]' : `node[type="${type}"]`,
    style: {
      ...shared,
      'background-color': colors.bg,
      'border-color': colors.border,
      'color': colors.text,
      ...(type === 'center' ? { 'width': '140px', 'height': '54px', 'font-size': '12px' } : {}),
    },
  }));

  return [
    ...nodeStyles,
    {
      selector: 'node:selected',
      style: { 'border-width': '3px', 'border-color': '#f8fafc', 'overlay-opacity': 0 },
    },
    {
      selector: 'edge',
      style: {
        'width': 1.5,
        'line-color': '#1e3a5f',
        'target-arrow-color': '#1e3a5f',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        'curve-style': 'bezier',
        'label': 'data(label)',
        'font-size': '9px',
        'color': '#475569',
        'text-background-color': '#020617',
        'text-background-opacity': 0.85,
        'text-background-padding': '2px',
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

// ── Event listeners ───────────────────────────────────────────────────────────
function initEvents() {
  // Send
  $('btn-send').addEventListener('click', sendMessage);
  $('chat-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendMessage(); }
  });
  $('chat-input').addEventListener('input', () => autoGrow($('chat-input')));

  // New chat
  $('btn-new-chat').addEventListener('click', () => {
    state.messages = [];
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
  initEvents();
});

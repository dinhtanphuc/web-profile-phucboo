/**
 * Phucboo Agents - máy chủ tải video (Cloudflare Worker, miễn phí)
 * ------------------------------------------------------------------
 *   GET /resolve?url=<link TikTok hoặc Facebook>   -> JSON thông tin video + các link tải
 *   GET /download?src=<link media>&name=<tên file> -> tải file về (đặt sẵn tên file)
 *   POST /mcp/higgsfield  -> MCP server tạo ảnh / video bằng Higgsfield API
 *   ANY  /mcp/atlassian   -> cầu nối tới Jira/Confluence MCP (đổi token sang Basic auth)
 *
 * Biến môi trường (tuỳ chọn, đặt trong Settings > Variables của Worker):
 *   ALLOWED_ORIGINS = https://dinhtanphuc.github.io
 *     -> chỉ website của bạn được gọi /resolve. Bỏ trống = cho phép mọi nơi.
 *   HF_KEY        = <Higgsfield API key ID>:<Higgsfield API key secret>   (Secret)
 *   HF_MCP_TOKEN  = chuỗi bí mật tự đặt, website dùng để gọi /mcp/higgsfield (Secret)
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Chỉ cho phép tải từ các máy chủ media này, tránh bị lợi dụng làm proxy tự do
const ALLOWED_MEDIA = [
  /(^|\.)tikwm\.com$/, /(^|\.)tiktokcdn(-[a-z]+)?\.com$/, /(^|\.)tiktokv\.com$/,
  /(^|\.)tiktok\.com$/, /(^|\.)byteoversea\.com$/, /(^|\.)ibyteimg\.com$/,
  /(^|\.)muscdn\.com$/, /(^|\.)fbcdn\.net$/
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const anyOrigin = allowed.includes('*');
    const cors = {
      'Access-Control-Allow-Origin': anyOrigin ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
      'Vary': 'Origin'
    };
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    // Các route MCP được Claude API gọi từ máy chủ Anthropic (không qua trình duyệt)
    if (url.pathname === '/mcp/higgsfield') return higgsfieldMcp(request, env);
    if (url.pathname === '/mcp/atlassian') return atlassianProxy(request);

    if (request.method !== 'GET') return json({ ok: false, code: 'METHOD' }, 405);
    try {
      if (url.pathname === '/resolve') {
        if (!anyOrigin && origin && !allowed.includes(origin)) return json({ ok: false, code: 'FORBIDDEN' }, 403);
        const target = (url.searchParams.get('url') || '').trim();
        const platform = detect(target);
        if (!platform) return json({ ok: false, code: 'UNSUPPORTED' }, 400);
        const data = platform === 'tiktok' ? await tiktok(target) : await facebook(target);
        return json({ ok: true, ...data });
      }

      if (url.pathname === '/download') {
        const src = url.searchParams.get('src') || '';
        let host;
        try { host = new URL(src).hostname; } catch { return json({ ok: false, code: 'BAD_SRC' }, 400); }
        if (!ALLOWED_MEDIA.some(re => re.test(host))) return json({ ok: false, code: 'BAD_SRC' }, 403);
        const name = safeName(url.searchParams.get('name') || 'video.mp4');
        const up = await fetch(src, {
          redirect: 'follow',
          headers: {
            'User-Agent': UA,
            'Referer': host.includes('fbcdn') ? 'https://www.facebook.com/' : 'https://www.tiktok.com/'
          }
        });
        if (!up.ok) return json({ ok: false, code: 'EXPIRED', status: up.status }, 502);
        const h = new Headers(cors);
        h.set('Content-Type', up.headers.get('Content-Type') || 'application/octet-stream');
        const len = up.headers.get('Content-Length');
        if (len) h.set('Content-Length', len);
        const ascii = name.replace(/[^\x20-\x7E]/g, '_');
        h.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        h.set('Cache-Control', 'no-store');
        return new Response(up.body, { status: 200, headers: h });
      }

      return json({ ok: true, service: 'phucboo-video', endpoints: ['/resolve?url=', '/download?src=&name='] });
    } catch (e) {
      return json({ ok: false, code: e.code || 'FAILED', message: String(e.message || e) }, 502);
    }
  }
};

function detect(u) {
  let h;
  try { h = new URL(u).hostname.toLowerCase(); } catch { return null; }
  if (/(^|\.)(tiktok\.com|douyin\.com)$/.test(h)) return 'tiktok';
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(h)) return 'facebook';
  return null;
}

function fail(code, message) { return Object.assign(new Error(message || code), { code }); }

/* ---------------- TikTok (qua TikWM, trả về bản gốc không logo) ---------------- */
async function tiktok(link) {
  const res = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ url: link, hd: '1' })
  });
  let j;
  try { j = await res.json(); } catch { throw fail('TIKTOK_FAIL'); }
  if (j.code !== 0 || !j.data) {
    throw fail(/limit/i.test(j.msg || '') ? 'RATE_LIMIT' : 'TIKTOK_FAIL', j.msg);
  }
  const d = j.data;
  const abs = p => !p ? null : (/^https?:/.test(p) ? p : 'https://www.tikwm.com' + p);
  const items = [];
  if (Array.isArray(d.images) && d.images.length) {
    d.images.forEach((im, i) => items.push({ kind: 'image', index: i + 1, url: abs(im), ext: 'jpg' }));
  } else {
    if (d.hdplay) items.push({ kind: 'video_hd', url: abs(d.hdplay), size: d.hd_size || null, ext: 'mp4' });
    if (d.play && d.play !== d.hdplay) items.push({ kind: 'video', url: abs(d.play), size: d.size || null, ext: 'mp4' });
    if (d.wmplay) items.push({ kind: 'video_wm', url: abs(d.wmplay), size: d.wm_size || null, ext: 'mp4' });
  }
  if (d.music) items.push({ kind: 'audio', url: abs(d.music), ext: 'mp3' });
  if (!items.length) throw fail('TIKTOK_FAIL');
  return {
    platform: 'tiktok',
    id: String(d.id || ''),
    title: d.title || '',
    author: (d.author && (d.author.nickname || d.author.unique_id)) || '',
    cover: abs(d.origin_cover || d.cover),
    duration: d.duration || null,
    items
  };
}

/* ---------------- Facebook (chỉ video công khai) ---------------- */
async function facebook(link) {
  const res = await fetch(link, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none'
    }
  });
  const html = await res.text();
  const pick = (...patterns) => {
    for (const re of patterns) { const m = html.match(re); if (m) return unescapeJson(m[1]); }
    return null;
  };
  const hd = pick(/"browser_native_hd_url":"([^"]+)"/, /"playable_url_quality_hd":"([^"]+)"/, /hd_src(?:_no_ratelimit)?:"([^"]+)"/);
  const sd = pick(/"browser_native_sd_url":"([^"]+)"/, /"playable_url":"([^"]+)"/, /sd_src(?:_no_ratelimit)?:"([^"]+)"/);
  if (!hd && !sd) throw fail('FB_NOT_FOUND');
  const meta = prop => {
    const m = html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i'));
    return m ? decodeEntities(m[1]) : '';
  };
  const items = [];
  if (hd) items.push({ kind: 'video_hd', url: hd, ext: 'mp4' });
  if (sd && sd !== hd) items.push({ kind: 'video', url: sd, ext: 'mp4' });
  const idMatch = link.match(/(?:videos\/|v=|reel\/|watch\/\?v=)(\d+)/);
  return {
    platform: 'facebook',
    id: idMatch ? idMatch[1] : '',
    title: meta('og:title'),
    author: '',
    cover: meta('og:image') || null,
    duration: null,
    items
  };
}

function unescapeJson(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s.replace(/\\\//g, '/'); }
}
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function safeName(n) {
  return n.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'video.mp4';
}

/* =====================================================================
 * Cầu nối Jira / Confluence (Atlassian Rovo MCP)
 * Claude API chỉ gửi được "Authorization: Bearer <token>".
 *   token = "basic:<base64(email:api_token)>"  -> chuyển thành Basic auth
 *   token khác (API key service account)       -> giữ nguyên Bearer
 * ===================================================================== */
const ATLASSIAN_MCP = 'https://mcp.atlassian.com/v1/mcp';

async function atlassianProxy(request) {
  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const key = k.toLowerCase();
    if (['host', 'content-length', 'cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'].includes(key) || key.startsWith('cf-')) continue;
    headers.set(k, v);
  }
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) {
    const token = m[1].trim();
    headers.set('Authorization', token.startsWith('basic:') ? 'Basic ' + token.slice(6) : 'Bearer ' + token);
  }
  const init = { method: request.method, headers, redirect: 'follow' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
  const up = await fetch(ATLASSIAN_MCP, init);
  const out = new Headers(up.headers);
  out.delete('content-encoding');
  out.delete('content-length');
  return new Response(up.body, { status: up.status, headers: out });
}

/* =====================================================================
 * MCP server Higgsfield (tối giản, không lưu phiên)
 * ===================================================================== */
const HF_API = 'https://api.higgsfield.ai';
const CAMERA_MOVES = ['static-shot', 'dolly-in', 'dolly-out', 'tracking', 'side-tracking', 'handheld', 'crane-up', 'crane-down', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'slow-zoom-in', 'slow-zoom-out', 'drone-orbit', 'arc-left', 'arc-right', 'whip-pan', 'dolly-zoom', 'aerial-pullback', 'rack-focus', 'pov', 'bullet-time', 'helicopter-shot', 'truck-left', 'truck-right', 'slider-left', 'slider-right', 'crush-zoom', 'robot-arm', 'snorricam', 'pedestal-up', 'pedestal-down'];
const GENRES = ['epic', 'drama', 'noir', 'comedy', 'horror', 'action'];

const HF_TOOLS = [
  {
    name: 'generate_image',
    description: 'Generate an image with Higgsfield. Waits up to ~60s and returns image URLs. model "grok" (default, supports aspect_ratio, 2k and up to 10 reference images for editing) or "soul" (Higgsfield Soul v2, photorealistic, prompt only).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed English prompt.' },
        model: { type: 'string', enum: ['grok', 'soul'], default: 'grok' },
        aspect_ratio: { type: 'string', enum: ['auto', '1:1', '1:2', '2:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'], default: 'auto' },
        resolution: { type: 'string', enum: ['1k', '2k'], default: '1k' },
        image_urls: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Optional public reference image URLs (grok only).' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'generate_video',
    description: 'Generate a cinematic video with Higgsfield Cinema Studio 4.0 (text-to-video, or reference-to-video when image_urls given). Costs credits per second. Waits up to ~50s; if not finished, returns request_id to check later with check_generation.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed English shot description. Spoken lines may be in Vietnamese in quotes.' },
        duration: { type: 'integer', minimum: 4, maximum: 30, default: 5 },
        aspect_ratio: { type: 'string', enum: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'], default: '9:16' },
        resolution: { type: 'string', enum: ['480p', '720p'], default: '720p' },
        generate_audio: { type: 'boolean', default: true },
        camera_movement: { type: 'string', enum: CAMERA_MOVES },
        genre: { type: 'string', enum: GENRES },
        image_urls: { type: 'array', items: { type: 'string' }, maxItems: 30, description: 'Optional public reference image URLs.' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'check_generation',
    description: 'Check status of a Higgsfield request and return output URLs when completed.',
    inputSchema: { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] }
  },
  {
    name: 'generate_custom',
    description: 'Advanced: call any Higgsfield model endpoint by model_id (e.g. "higgsfield/ads-studio/v1.0") with its documented JSON params. Use only when the user names a specific model.',
    inputSchema: {
      type: 'object',
      properties: { model_id: { type: 'string' }, params: { type: 'object' } },
      required: ['model_id', 'params']
    }
  }
];

async function higgsfieldMcp(request, env) {
  const rpcHeaders = { 'Content-Type': 'application/json' };
  if (request.method === 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (request.method === 'DELETE') return new Response(null, { status: 200 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (env.HF_MCP_TOKEN) {
    const auth = request.headers.get('Authorization') || '';
    if (auth !== 'Bearer ' + env.HF_MCP_TOKEN) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: rpcHeaders });
  }

  let body;
  try { body = await request.json(); } catch { return rpcError(null, -32700, 'Parse error'); }
  const batch = Array.isArray(body) ? body : [body];
  const results = [];
  for (const msg of batch) {
    if (!msg || msg.id === undefined || msg.id === null) continue; // notification
    results.push(await handleRpc(msg, env));
  }
  if (!results.length) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(Array.isArray(body) ? results : results[0]), { headers: rpcHeaders });
}

function rpcError(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleRpc(msg, env) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'phucboo-higgsfield', version: '1.0.0' }
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: HF_TOOLS });
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      try {
        const data = await runHfTool(name, args, env);
        return reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: 'Error: ' + (e.message || e) }] });
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
  }
}

async function hf(path, init, env) {
  if (!env.HF_KEY) throw new Error('Worker chưa có biến HF_KEY (Higgsfield key_id:key_secret).');
  const res = await fetch(HF_API + path, {
    ...init,
    headers: { 'Authorization': 'Key ' + env.HF_KEY, 'Content-Type': 'application/json', ...(init && init.headers) }
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const d = data && data.detail;
    const msg = typeof d === 'string' ? d : (d && d.message) || JSON.stringify(data).slice(0, 400);
    const hint = { 401: 'sai key', 403: 'hết số dư hoặc key bị khoá', 404: 'model không có cho tài khoản này', 422: 'tham số không hợp lệ', 429: 'hàng đợi đầy, thử lại sau' }[res.status] || '';
    throw new Error(`Higgsfield ${res.status}${hint ? ' (' + hint + ')' : ''}: ${msg}`);
  }
  return data;
}

function summarize(d) {
  const out = { request_id: d.request_id, status: d.status };
  if (d.images) out.images = d.images.map(i => i.url);
  if (d.video) out.video = d.video.url;
  if (d.audio) out.audio = d.audio.url;
  if (d.error) out.error = d.error;
  if (d.errors && d.errors.length) out.errors = d.errors;
  if (d.expires_at) out.expires_at = d.expires_at;
  if (d.status === 'nsfw') out.note = 'Bị bộ lọc nội dung từ chối, không tính phí.';
  if (d.status === 'queued' || d.status === 'in_progress') out.note = 'Chưa xong. Gọi check_generation với request_id này sau ít phút.';
  return out;
}

async function submitAndWait(modelId, params, env, waitMs) {
  const sub = await hf('/' + modelId, {
    method: 'POST',
    body: JSON.stringify(params),
    headers: { 'Idempotency-Key': crypto.randomUUID() }
  }, env);
  const id = sub.request_id;
  const deadline = Date.now() + waitMs;
  let delay = 2000, last = sub;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, delay));
    last = await hf(`/requests/${id}/status`, { method: 'GET' }, env);
    if (['completed', 'failed', 'nsfw', 'canceled'].includes(last.status)) break;
    delay = Math.min(delay * 1.5, 8000);
  }
  return summarize({ ...last, request_id: id });
}

function clean(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) o[k] = v;
  return o;
}

async function runHfTool(name, a, env) {
  if (name === 'generate_image') {
    if (a.model === 'soul') return submitAndWait('higgsfield-ai/soul/v2/standard', { prompt: a.prompt }, env, 60000);
    return submitAndWait('xai/grok-imagine-image-2.0', clean({
      prompt: a.prompt, aspect_ratio: a.aspect_ratio || 'auto', resolution: a.resolution || '1k',
      quality: 'medium', image_urls: a.image_urls
    }), env, 60000);
  }
  if (name === 'generate_video') {
    return submitAndWait('higgsfield/cinema-studio/4.0', clean({
      prompt: a.prompt,
      duration: Math.max(4, Math.min(30, parseInt(a.duration || 5, 10))),
      aspect_ratio: a.aspect_ratio || '9:16',
      resolution: a.resolution || '720p',
      generate_audio: a.generate_audio !== false,
      camera_movement: CAMERA_MOVES.includes(a.camera_movement) ? a.camera_movement : undefined,
      genre: GENRES.includes(a.genre) ? a.genre : undefined,
      image_urls: a.image_urls
    }), env, 50000);
  }
  if (name === 'check_generation') {
    const d = await hf(`/requests/${encodeURIComponent(a.request_id)}/status`, { method: 'GET' }, env);
    return summarize({ ...d, request_id: a.request_id });
  }
  if (name === 'generate_custom') {
    if (!/^[a-z0-9\-]+(\/[a-z0-9.\-]+)+$/i.test(a.model_id || '')) throw new Error('model_id không hợp lệ');
    return submitAndWait(a.model_id, a.params || {}, env, 50000);
  }
  throw new Error('Unknown tool: ' + name);
}

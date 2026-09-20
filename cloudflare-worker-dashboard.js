const GRAPH_API = "https://graph.instagram.com/v24.0";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: apiHeaders(),
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(DASHBOARD_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; media-src https:; connect-src 'self'; frame-ancestors 'none'",
        },
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "en-rasi-instagram-publisher" });
    }

    if (!isAuthorized(request, env.PUBLISH_API_KEY)) {
      return json({ ok: false, error: "Unauthorized" }, 401);
    }

    if (!env.INSTAGRAM_ACCESS_TOKEN || !env.INSTAGRAM_USER_ID) {
      return json({ ok: false, error: "Instagram secrets are not configured" }, 500);
    }

    try {
      if (url.pathname === "/verify" && request.method === "GET") {
        const account = await graphGet(
          `/${env.INSTAGRAM_USER_ID}`,
          { fields: "user_id,username" },
          env.INSTAGRAM_ACCESS_TOKEN,
        );
        return json({ ok: true, account });
      }

      // Creates an unpublished media container. Nothing goes live here.
      if (url.pathname === "/prepare" && request.method === "POST") {
        const body = await readJson(request);
        const mediaUrl = validateHttpsUrl(normalizeGithubUrl(body.media_url));
        const caption = String(body.caption ?? "").trim();
        const mediaType = String(body.media_type ?? "IMAGE").toUpperCase();

        if (caption.length > 2200) {
          return json({ ok: false, error: "Caption exceeds 2,200 characters" }, 400);
        }
        if (!['IMAGE', 'REELS'].includes(mediaType)) {
          return json({ ok: false, error: "media_type must be IMAGE or REELS" }, 400);
        }

        const fields = { caption };
        if (mediaType === "REELS") {
          fields.media_type = "REELS";
          fields.video_url = mediaUrl;
          fields.share_to_feed = body.share_to_feed === false ? "false" : "true";
        } else {
          fields.image_url = mediaUrl;
        }

        const result = await graphPost(
          `/${env.INSTAGRAM_USER_ID}/media`,
          fields,
          env.INSTAGRAM_ACCESS_TOKEN,
        );

        return json({
          ok: true,
          published: false,
          creation_id: result.id,
          next: "Check status, then publish only after approval",
        });
      }

      if (url.pathname === "/status" && request.method === "GET") {
        const creationId = validateId(url.searchParams.get("creation_id"));
        const container = await graphGet(
          `/${creationId}`,
          { fields: "status_code,status" },
          env.INSTAGRAM_ACCESS_TOKEN,
        );
        return json({ ok: true, container });
      }

      // This is the only endpoint that makes prepared media public.
      if (url.pathname === "/publish" && request.method === "POST") {
        const body = await readJson(request);
        const creationId = validateId(body.creation_id);
        const result = await graphPost(
          `/${env.INSTAGRAM_USER_ID}/media_publish`,
          { creation_id: creationId },
          env.INSTAGRAM_ACCESS_TOKEN,
        );
        return json({ ok: true, published: true, media_id: result.id });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || "Unexpected error" }, 500);
    }
  },
};

function apiHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function isAuthorized(request, expectedKey) {
  if (!expectedKey) return false;
  const bearer = request.headers.get("Authorization") || "";
  const headerKey = request.headers.get("X-API-Key") || "";
  return bearer === `Bearer ${expectedKey}` || headerKey === expectedKey;
}

async function readJson(request) {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  return request.json();
}

function normalizeGithubUrl(value) {
  const input = String(value || "").trim();
  const match = input.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (!match) return input;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

function validateHttpsUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("media_url must be a valid public HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("media_url must use HTTPS");
  return url.toString();
}

function validateId(value) {
  const id = String(value || "");
  if (!/^\d+$/.test(id)) throw new Error("Invalid creation_id");
  return id;
}

async function graphGet(path, params, accessToken) {
  const url = new URL(`${GRAPH_API}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return graphFetch(url, { method: "GET" }, accessToken);
}

async function graphPost(path, fields, accessToken) {
  return graphFetch(`${GRAPH_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  }, accessToken);
}

async function graphFetch(url, options, accessToken) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data?.error?.message || `Instagram API returned HTTP ${response.status}`);
  }
  return data;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: apiHeaders(),
  });
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>En Rasi Instagram Publisher</title>
  <style>
    :root{color-scheme:dark;--bg:#090611;--panel:#171020;--panel2:#21162d;--gold:#f8bd4f;--pink:#ff4fa3;--text:#fff8ed;--muted:#bcaec8;--green:#50d890;--red:#ff6b7b;--line:#382746}
    *{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:radial-gradient(circle at top,#321347 0,#100819 42%,#090611 100%);color:var(--text);min-height:100vh}
    .wrap{width:min(1100px,94vw);margin:34px auto}.head{display:flex;align-items:center;gap:14px;margin-bottom:22px}.logo{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;background:linear-gradient(135deg,var(--pink),var(--gold));font-size:27px;box-shadow:0 12px 34px #ff4fa344}.head h1{font-size:clamp(24px,4vw,38px);margin:0}.head p{margin:4px 0 0;color:var(--muted)}
    .grid{display:grid;grid-template-columns:1.08fr .92fr;gap:20px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
    .card{background:linear-gradient(160deg,#1d1327e8,#120c1ae8);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 20px 60px #0006;backdrop-filter:blur(14px)}
    h2{font-size:18px;margin:0 0 18px}label{display:block;font-size:13px;font-weight:700;color:#dbcfe4;margin:14px 0 7px}input,textarea,select{width:100%;border:1px solid #493558;background:#0d0912;color:var(--text);border-radius:12px;padding:12px 13px;font:inherit;outline:none}input:focus,textarea:focus,select:focus{border-color:var(--gold);box-shadow:0 0 0 3px #f8bd4f1c}textarea{min-height:150px;resize:vertical}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check{display:flex;align-items:center;gap:9px;margin:14px 0;color:var(--muted);font-size:14px}.check input{width:auto}
    button{border:0;border-radius:12px;padding:12px 15px;font-weight:800;cursor:pointer;background:#332540;color:white}button.primary{background:linear-gradient(135deg,var(--pink),#ff7a59);box-shadow:0 10px 25px #ff4fa326}button.gold{background:linear-gradient(135deg,#f6a93d,var(--gold));color:#211203}button:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
    .preview{border:1px dashed #4c3858;background:#0b0710;border-radius:17px;min-height:330px;display:grid;place-items:center;overflow:hidden}.preview video,.preview img{display:block;width:100%;max-height:520px;object-fit:contain}.empty{text-align:center;color:var(--muted);padding:40px}.status{margin-top:15px;border:1px solid var(--line);border-radius:14px;padding:13px;background:#0a070f;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;min-height:76px;font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.pill{display:inline-flex;align-items:center;gap:7px;background:#22172d;border:1px solid #483457;border-radius:999px;padding:7px 11px;color:var(--muted);font-size:12px;margin-bottom:14px}.dot{width:8px;height:8px;border-radius:50%;background:var(--gold)}.safe{font-size:12px;color:var(--muted);line-height:1.55;margin-top:16px;border-top:1px solid var(--line);padding-top:14px}.count{text-align:right;color:var(--muted);font-size:12px;margin-top:5px}.ok{color:var(--green)}.bad{color:var(--red)}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="head"><div class="logo">♈</div><div><h1>En Rasi Publisher</h1><p>Prepare, review and publish to @en_rasipalan</p></div></div>
    <div class="grid">
      <section class="card">
        <div class="pill"><span class="dot"></span> Approval required before publishing</div>
        <h2>Post details</h2>
        <label for="key">Private publishing key</label>
        <input id="key" type="password" autocomplete="off" placeholder="Enter PUBLISH_API_KEY">
        <label for="url">Public GitHub image or Reel URL</label>
        <input id="url" type="url" placeholder="https://github.com/.../blob/main/video.mp4">
        <div class="row">
          <div><label for="type">Content type</label><select id="type"><option value="REELS">Reel / MP4</option><option value="IMAGE">Image</option></select></div>
          <div><label>&nbsp;</label><button id="previewBtn" type="button">Preview media</button></div>
        </div>
        <label for="caption">Tamil caption</label>
        <textarea id="caption" maxlength="2200" placeholder="Enter the final Instagram caption..."></textarea>
        <div id="count" class="count">0 / 2200</div>
        <label class="check"><input id="feed" type="checkbox" checked> Share Reel to Instagram feed</label>
        <div class="actions">
          <button id="verify" type="button">Verify account</button>
          <button id="prepare" class="primary" type="button">1. Prepare safely</button>
          <button id="check" type="button" disabled>2. Check status</button>
          <button id="publish" class="gold" type="button" disabled>3. Publish publicly</button>
        </div>
        <div id="status" class="status">Ready. Enter the private key and post details.</div>
        <div class="safe">Your Instagram token is never sent to this page or stored in the browser. The private publishing key is kept only for this browser tab. Preparing content does not publish it.</div>
      </section>
      <section class="card">
        <h2>Media preview</h2>
        <div id="preview" class="preview"><div class="empty">Paste a GitHub media URL and select Preview.</div></div>
      </section>
    </div>
  </main>
  <script>
    const $ = id => document.getElementById(id);
    let creationId = sessionStorage.getItem('creationId') || '';
    let busy = false;

    $('key').value = sessionStorage.getItem('publishKey') || '';
    if (creationId) { $('check').disabled = false; show('Restored prepared container: ' + creationId); }
    $('key').addEventListener('input', () => sessionStorage.setItem('publishKey', $('key').value));
    $('caption').addEventListener('input', () => $('count').textContent = $('caption').value.length + ' / 2200');
    $('previewBtn').addEventListener('click', previewMedia);
    $('verify').addEventListener('click', verifyAccount);
    $('prepare').addEventListener('click', prepareMedia);
    $('check').addEventListener('click', checkStatus);
    $('publish').addEventListener('click', publishMedia);

    function rawUrl(value) {
      return value.trim().replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/, 'https://raw.githubusercontent.com/$1/$2/$3/$4');
    }
    function auth() {
      const key = $('key').value.trim();
      if (!key) throw new Error('Enter your private PUBLISH_API_KEY.');
      return { 'X-API-Key': key };
    }
    function show(message, kind = '') {
      $('status').className = 'status ' + kind;
      $('status').textContent = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
    }
    function setBusy(value) {
      busy = value;
      $('verify').disabled = value;
      $('prepare').disabled = value;
    }
    async function call(path, options = {}) {
      const result = await fetch(path, { ...options, headers: { ...auth(), ...(options.headers || {}) } });
      const data = await result.json().catch(() => ({ error: 'Invalid server response' }));
      if (!result.ok || !data.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    function previewMedia() {
      const url = rawUrl($('url').value);
      if (!url.startsWith('https://')) return show('Enter a valid public HTTPS media URL.', 'bad');
      $('preview').textContent = '';
      const media = document.createElement($('type').value === 'REELS' ? 'video' : 'img');
      media.src = url;
      if (media.tagName === 'VIDEO') { media.controls = true; media.playsInline = true; }
      media.onerror = () => show('The browser could not preview this URL. Confirm the GitHub file is public.', 'bad');
      $('preview').appendChild(media);
      show('Preview loaded. Review the media and caption before preparing.');
    }
    async function verifyAccount() {
      try { setBusy(true); show('Verifying account...'); const data = await call('/verify'); show(data, 'ok'); }
      catch (e) { show(e.message, 'bad'); } finally { setBusy(false); }
    }
    async function prepareMedia() {
      try {
        const mediaUrl = rawUrl($('url').value);
        if (!mediaUrl) throw new Error('Enter the GitHub media URL.');
        if (!$('caption').value.trim()) throw new Error('Enter the final caption.');
        setBusy(true); $('publish').disabled = true; show('Creating an unpublished Instagram container...');
        const data = await call('/prepare', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ media_url: mediaUrl, media_type: $('type').value, share_to_feed: $('feed').checked, caption: $('caption').value.trim() })
        });
        creationId = data.creation_id; sessionStorage.setItem('creationId', creationId); $('check').disabled = false;
        show('Prepared safely. Nothing is public.\nCreation ID: ' + creationId + '\nChecking processing status...', 'ok');
        await pollStatus();
      } catch (e) { show(e.message, 'bad'); } finally { setBusy(false); }
    }
    async function checkStatus() {
      try { setBusy(true); await pollStatus(); } catch (e) { show(e.message, 'bad'); } finally { setBusy(false); }
    }
    async function pollStatus() {
      if (!creationId) throw new Error('Prepare content first.');
      for (let attempt = 1; attempt <= 12; attempt++) {
        const data = await call('/status?creation_id=' + encodeURIComponent(creationId));
        const state = data.container.status_code || data.container.status;
        show('Processing status: ' + state + '\nCreation ID: ' + creationId);
        if (state === 'FINISHED') { $('publish').disabled = false; show('FINISHED — ready for your final approval. Nothing is public yet.', 'ok'); return; }
        if (state === 'ERROR' || state === 'EXPIRED') throw new Error('Instagram processing status: ' + state);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      show('Still processing. Click Check status again shortly.');
    }
    async function publishMedia() {
      if (!creationId) return show('Prepare content first.', 'bad');
      if (!confirm('Final approval: publish this content publicly to @en_rasipalan now?')) return;
      try {
        setBusy(true); $('publish').disabled = true; show('Publishing publicly to Instagram...');
        const data = await call('/publish', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: creationId })
        });
        sessionStorage.removeItem('creationId'); creationId = ''; $('check').disabled = true;
        show('Published successfully.\nInstagram media ID: ' + data.media_id, 'ok');
      } catch (e) { $('publish').disabled = false; show(e.message, 'bad'); } finally { setBusy(false); }
    }
  </script>
</body>
</html>`;

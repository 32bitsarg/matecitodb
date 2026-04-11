// ─── API Playground (K2) — REST Explorer ───────────────────────────────────
//
// GET /playground  → HTML minimal con formularios para cada colección y endpoint
//
// Similar a Swagger UI pero temático de Matebase. Sirve HTML estático
// generado dinámicamente con el schema del proyecto.

const {
  db,
  flexAuth,
  quoteIdent,
  projectRoute,
} = require("../../../lib/v2/auth");
const { ensureV2Tables } = require("../../../lib/v2/schema");

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = async function (fastify) {
  fastify.get("/playground", {
    preHandler: flexAuth,
  }, async (req, reply) => {
    reply.type("text/html");

    const project = req.resolvedProject;
    const projectId = project?.id ?? req.params?.projectId;

    if (!project) {
      return `<!DOCTYPE html><html><head><title>Matebase Playground</title></head><body><h1>Project not found</h1></body></html>`;
    }

    const schemaName = project.schema_name;
    await ensureV2Tables(schemaName);
    const schema = quoteIdent(schemaName);

    // Fetch collections + fields
    const { rows: cols } = await db.query(
      `SELECT name FROM ${schema}._collections ORDER BY name`
    ).catch(() => ({ rows: [] }));

    const collectionsHtml = cols.map(c => `
      <div class="collection">
        <h3 onclick="toggle('col-${c.name}')">📁 ${escapeHtml(c.name)}</h3>
        <div id="col-${c.name}" class="hidden">
          <div class="endpoint">
            <span class="method get">GET</span>
            <code>/rest/v1/${escapeHtml(c.name)}</code>
            <button onclick="testEndpoint('GET','/rest/v1/${escapeHtml(c.name)}')">Try</button>
          </div>
          <div class="endpoint">
            <span class="method post">POST</span>
            <code>/rest/v1/${escapeHtml(c.name)}</code>
            <textarea placeholder='{"data":{}}'></textarea>
            <button onclick="testEndpoint('POST','/rest/v1/${escapeHtml(c.name)}',this)">Try</button>
          </div>
        </div>
      </div>
    `).join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Matebase Playground — ${escapeHtml(project.name)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 10px; }
    h2 { color: #8b949e; font-size: 14px; text-transform: uppercase; margin: 20px 0 10px; border-bottom: 1px solid #21262d; padding-bottom: 5px; }
    h3 { cursor: pointer; color: #58a6ff; padding: 8px 0; }
    .hidden { display: none; }
    .collection { margin: 5px 0; padding: 5px 0; }
    .endpoint { display: flex; align-items: center; gap: 10px; padding: 8px; margin: 4px 0; background: #161b22; border-radius: 6px; }
    .endpoint code { flex: 1; font-size: 13px; color: #7ee787; }
    .endpoint textarea { width: 200px; height: 40px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 11px; padding: 4px; }
    .method { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; color: white; }
    .method.get { background: #1f6feb; }
    .method.post { background: #238636; }
    .method.patch { background: #9e6a03; }
    .method.delete { background: #da3633; }
    button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    button:hover { background: #30363d; }
    .result { margin: 8px 0; padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; font-size: 12px; max-height: 300px; overflow: auto; white-space: pre-wrap; display: none; }
    #auth-section { background: #161b22; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    #auth-section input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 4px; width: 400px; font-size: 13px; }
    #auth-section button { padding: 6px 16px; }
    .section { margin-bottom: 15px; }
  </style>
</head>
<body>
  <h1>🚀 Matebase Playground</h1>
  <p style="color:#8b949e">Project: <strong>${escapeHtml(project.name)}</strong> (${escapeHtml(project.id)})</p>

  <div id="auth-section">
    <strong>Authentication</strong>
    <div style="margin-top:8px; display:flex; gap:8px;">
      <input id="api-key" type="text" placeholder="Paste your API key or JWT token here" />
      <button onclick="saveKey()">Save</button>
    </div>
  </div>

  <div class="section">
    <h2>Auth</h2>
    <div class="endpoint"><span class="method post">POST</span><code>/auth/register</code><textarea placeholder='{"email":"test@test.com","password":"123456"}'></textarea><button onclick="testEndpoint('POST','/auth/register',this)">Try</button></div>
    <div class="endpoint"><span class="method post">POST</span><code>/auth/login</code><textarea placeholder='{"email":"test@test.com","password":"123456"}'></textarea><button onclick="testEndpoint('POST','/auth/login',this)">Try</button></div>
    <div class="endpoint"><span class="method get">GET</span><code>/auth/me</code><button onclick="testEndpoint('GET','/auth/me',this)">Try</button></div>
  </div>

  <div class="section">
    <h2>Data</h2>
    <div class="endpoint"><span class="method get">GET</span><code>/collections</code><button onclick="testEndpoint('GET','/collections',this)">Try</button></div>
    <div class="endpoint"><span class="method get">GET</span><code>/records?collection=</code><input style="width:120px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:4px;font-size:12px" placeholder="collection" /><button onclick="testEndpoint('GET','/records?collection='+this.previousElementSibling.value,this)">Try</button></div>
    <div class="endpoint"><span class="method get">GET</span><code>/records/search?q=</code><input style="width:120px;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 8px;border-radius:4px;font-size:12px" placeholder="search query" /><button onclick="testEndpoint('GET','/records/search?q='+encodeURIComponent(this.previousElementSibling.value),this)">Try</button></div>
    ${collectionsHtml}
  </div>

  <div class="section">
    <h2>Functions</h2>
    <div class="endpoint"><span class="method get">GET</span><code>/functions</code><button onclick="testEndpoint('GET','/functions',this)">Try</button></div>
  </div>

  <div class="section">
    <h2>Notifications</h2>
    <div class="endpoint"><span class="method get">GET</span><code>/notifications/me</code><button onclick="testEndpoint('GET','/notifications/me',this)">Try</button></div>
  </div>

  <div class="section">
    <h2>Config</h2>
    <div class="endpoint"><span class="method get">GET</span><code>/config</code><button onclick="testEndpoint('GET','/config',this)">Try</button></div>
  </div>

  <div id="results"></div>

  <script>
    function saveKey() {
      localStorage.setItem('matebase-key', document.getElementById('api-key').value);
    }
    function getKey() {
      return localStorage.getItem('matebase-key') || document.getElementById('api-key').value || '';
    }
    function toggle(id) {
      const el = document.getElementById(id);
      el.classList.toggle('hidden');
    }
    async function testEndpoint(method, path, btn) {
      const key = getKey();
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['x-matecito-key'] = key;

      let body = undefined;
      if (btn) {
        const ta = btn.previousElementSibling;
        if (ta && ta.tagName === 'TEXTAREA' && ta.value.trim()) {
          try { body = JSON.parse(ta.value); } catch { alert('Invalid JSON'); return; }
        }
      }

      const resultDiv = document.createElement('div');
      resultDiv.className = 'result';
      resultDiv.style.display = 'block';
      if (btn) btn.after(resultDiv);

      resultDiv.textContent = 'Loading...';
      try {
        const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
        const data = await res.json();
        resultDiv.textContent = res.status + ' ' + res.statusText + '\\n' + JSON.stringify(data, null, 2);
      } catch (e) {
        resultDiv.textContent = 'Error: ' + e.message;
      }
    }
    // Load saved key
    const savedKey = localStorage.getItem('matebase-key');
    if (savedKey) document.getElementById('api-key').value = savedKey;
  </script>
</body>
</html>`;

    return html;
  });
};

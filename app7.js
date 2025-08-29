import { asyncSSE } from "https://cdn.jsdelivr.net/npm/asyncsse@1";

// Alerts
const alerts = document.getElementById('alerts');
function showAlert(message, variant, delay){
  if (!variant) variant = 'danger';
  if (!delay) delay = 5000;
  const id = 'toast-' + Math.random().toString(36).slice(2);
  const html =
    '<div id="' + id + '" class="toast align-items-center text-bg-' + variant + ' border-0" role="alert" aria-live="assertive" aria-atomic="true">' +
      '<div class="d-flex">' +
        '<div class="toast-body">' + message + '</div>' +
        '<button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>' +
      '</div>' +
    '</div>';
  alerts.insertAdjacentHTML('beforeend', html);
  const el = document.getElementById(id);
  const t = new bootstrap.Toast(el, { delay: delay });
  t.show();
  el.addEventListener('hidden.bs.toast', function(){ el.remove(); });
}

// State & UI
const state = {
  baseUrl: '',
  apiKey: '',
  model: '',
  models: [],
  msgs: [{
    role: 'system',
    content: 'You are a concise browser agent. Tools: search_web, aipipe_chat, run_js. Prefer citing sources from search_web. Keep tool arguments valid JSON.'
  }],
  running: false
};
const chat    = document.getElementById('chat');
const input   = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const modelSel= document.getElementById('model');
const status  = document.getElementById('status');

const googleKey = document.getElementById('googleKey');
const googleCx  = document.getElementById('googleCx');
googleKey.value = localStorage.getItem('googleKey') || '';
googleCx.value  = localStorage.getItem('googleCx')  || '';
googleKey.addEventListener('change', function(){ localStorage.setItem('googleKey', googleKey.value.trim()); });
googleCx.addEventListener('change',  function(){ localStorage.setItem('googleCx',  googleCx.value.trim()); });

function escapeHTML(s){ return s.replace(/[&<>]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]); }); }
function addBubble(role, html){
  const div = document.createElement('div');
  div.className = 'msg-row';
  div.innerHTML = '<div class="bubble ' + role + ' mono">' + html + '</div>';
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div.firstChild;
}

// Built-in Pick Model modal
const baseUrlSel  = document.getElementById('baseUrlSel');
const apiKeyInput = document.getElementById('apiKeyInput');
const modelInput  = document.getElementById('modelInput');
const modelModal  = new bootstrap.Modal(document.getElementById('modelModal'));

function updateStatus(){
  const baseBadge = '<span class="badge text-bg-secondary">' + escapeHTML(state.baseUrl || '(none)') + '</span> ';
  const modelBadge= '<span class="badge text-bg-primary">' + escapeHTML(state.model || '(none)') + '</span>';
  status.innerHTML = baseBadge + modelBadge;
}

document.getElementById('pickModelBtn').addEventListener('click', function(){
  if (state.baseUrl) baseUrlSel.value = state.baseUrl;
  apiKeyInput.value = state.apiKey || '';
  modelInput.value  = state.model || '';
  modelModal.show();
});

document.getElementById('saveModelBtn').addEventListener('click', function(){
  state.baseUrl = baseUrlSel.value.trim();
  state.apiKey  = apiKeyInput.value.trim();
  state.model   = modelInput.value.trim();
  if (state.model && !state.models.includes(state.model)) state.models.unshift(state.model);
  modelSel.innerHTML = state.models.map(function(m){ return '<option>' + m + '</option>'; }).join('');
  if (state.model) modelSel.value = state.model;
  updateStatus();
  modelModal.hide();
  showAlert('Model saved', 'secondary', 1500);
});

modelSel.addEventListener('change', function(){
  state.model = modelSel.value;
  updateStatus();
});

// Tools schema
const tools = [
  { type: 'function', "function": {
    name: 'search_web',
    description: 'Google Programmable Search → [{title, link, snippet}]',
    parameters: { type: 'object', properties: {
      query: { type: 'string' },
      num:   { type: 'integer', minimum:1, maximum:10, "default":5 }
    }, required: ['query'] }
  }},
  { type: 'function', "function": {
    name: 'aipipe_chat',
    description: 'Call an LLM through AI Pipe proxy',
    parameters: { type: 'object', properties: {
      model: { type:'string' }, input: { type:'string' }
    }, required: ['model','input'] }
  }},
  { type: 'function', "function": {
    name: 'run_js',
    description: 'Run JavaScript in a sandboxed iframe; returns {value, logs}',
    parameters: { type: 'object', properties: {
      code: { type:'string' }, timeout_ms: { type:'integer', "default":4000 }
    }, required: ['code'] }
  }}
];

// Tool executors
async function execTool(tc){
  const fn = (tc["function"] || {});
  const name = fn.name;
  let args = {};
  try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; }
  catch(e){ throw new Error('Bad JSON for ' + name + ': ' + fn.arguments); }

  if (name === 'search_web'){
    const key = googleKey.value.trim();
    const cx  = googleCx.value.trim();
    if (!key || !cx) throw new Error('Google API key and cx are required in Settings.');
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', key);
    url.searchParams.set('cx', cx);
    url.searchParams.set('q', args.query);
    url.searchParams.set('num', Math.min(args.num != null ? args.num : 5, 10));
    const r = await fetch(url);
    if (!r.ok) throw new Error('Google Search failed: ' + r.status + ' ' + r.statusText);
    const data = await r.json();
    const items = (data.items || []).map(function(it){ return { title: it.title, link: it.link, snippet: it.snippet }; });
    return { ok:true, query: args.query, results: items };
  }

  if (name === 'aipipe_chat'){
    throw new Error('AI Pipe proxy not configured in this minimal build.');
  }

  if (name === 'run_js'){
    const out = await runInSandbox(args.code, args.timeout_ms != null ? args.timeout_ms : 4000);
    return out.ok ? { ok:true, value:out.result, logs:out.logs } : { ok:false, error:out.error, logs:out.logs };
  }

  throw new Error('Unknown tool: ' + name);
}

// Sandbox (external file = safe; using split end tag anyway)
let sandboxURL = null;
function buildSandboxURL(){
  const parts = [
    '<!doctype html><html><body><script>',
    '(function(){',
    'var logs = [];',
    'var orig = console.log;',
    'console.log = function(){ try{ var a=[].slice.call(arguments).map(function(x){ return (typeof x==="object")? JSON.stringify(x): String(x); }); logs.push(a.join(" ")); }catch(e){}; return orig.apply(console, arguments); };',
    'function run(code){',
    '  try{',
    '    var fn = new Function(code + "\\n;return (typeof __result__!==\\\'undefined\\\' ? __result__ : undefined);");',
    '    var r = fn();',
    '    if (r && typeof r.then==="function") { return r.then(function(v){ return { ok:true, result:v, logs:logs }; }).catch(function(e){ return { ok:false, error:String(e && e.message || e), logs:logs }; }); }',
    '    return { ok:true, result:r, logs:logs };',
    '  }catch(e){ return { ok:false, error:e.message, logs:logs }; }',
    '}',
    'addEventListener("message", function(e){',
    '  var data = e.data || {};',
    '  if (data.type !== "run") return;',
    '  var code = data.code, timeout = data.timeout, id = data.id;',
    '  var done = false;',
    '  var t = setTimeout(function(){ if(!done) parent.postMessage({ type:"result", id:id, ok:false, error:"Timeout" }, "*"); }, timeout || 4000);',
    '  Promise.resolve(run(code)).then(function(out){ done = true; clearTimeout(t); parent.postMessage(Object.assign({ type:"result", id:id }, out), "*"); });',
    '});',
    '})();',
    '</scr' + 'ipt></body></html>'
  ];
  const blob = new Blob([parts.join('\n')], { type: 'text/html' });
  return URL.createObjectURL(blob);
}

const iframe = document.createElement('iframe');
iframe.sandbox = 'allow-scripts';
iframe.style.display = 'none';
document.body.appendChild(iframe);

function runInSandbox(code, timeout){
  if (timeout == null) timeout = 4000;
  if (!sandboxURL){ sandboxURL = buildSandboxURL(); iframe.src = sandboxURL; }
  return new Promise(function(resolve){
    const id = Math.random().toString(36).slice(2);
    function onMsg(e){
      const d = e.data || {};
      if (d.type === 'result' && d.id === id){
        removeEventListener('message', onMsg);
        resolve(d);
      }
    }
    addEventListener('message', onMsg);
    iframe.contentWindow.postMessage({ type:'run', code:code, timeout:timeout, id:id }, '*');
  });
}

// LLM call (streaming)
async function llmOnce(){
  if (!state.baseUrl || !state.model){
    showAlert('Pick a base URL and model first.', 'warning', 2500);
    return { role:'assistant', content:'' };
  }
  const url = state.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = { 'Content-Type':'application/json' };
  if (state.apiKey) headers['Authorization'] = 'Bearer ' + state.apiKey;
  const body = { model: state.model, stream:true, messages: state.msgs, tools: tools };

  let assistant = { role:'assistant', content:'', tool_calls:[] };
  const bubble = addBubble('assistant','<em>…</em>');
  const callParts = new Map();

  try{
    for await (const chunk of asyncSSE(url, { method:'POST', headers:headers, body: JSON.stringify(body) })){
      const data = chunk && chunk.data;
      const error = chunk && chunk.error;
      if (error) throw new Error(error);
      if (!data || data === '[DONE]') break;
      const evt = JSON.parse(data);
      const delta = (evt.choices && evt.choices[0] && evt.choices[0].delta) || {};
      if (delta.content){
        assistant.content += delta.content;
        bubble.textContent = assistant.content;
      }
      const tc = delta.tool_calls || [];
      for (var i=0;i<tc.length;i++){
        const tci = tc[i];
        const idx = tci.index;
        const id  = tci.id;
        const fn  = tci["function"] || {};
        const cur = callParts.get(idx) || { id:id, name:'', arguments:'' };
        if (id) cur.id = id;
        if (fn.name) cur.name = fn.name;
        if (fn.arguments) cur.arguments += fn.arguments;
        callParts.set(idx, cur);
      }
    }
  }catch(e){
    bubble.innerHTML = '<span class="text-warning">(stream stopped)</span><br/><pre class="mono">' + escapeHTML(e.message) + '</pre>';
    throw e;
  }

  assistant.tool_calls = Array.from(callParts.values()).map(function(x){ return { id:x.id, type:'function', "function":{ name:x.name, arguments:x.arguments } }; });
  bubble.innerHTML = assistant.content ? escapeHTML(assistant.content) : '<em>(tool call)</em>';
  state.msgs.push(assistant);
  return assistant;
}

async function agentLoop(){
  state.running = true; sendBtn.disabled = true; stopBtn.disabled = false;
  try{
    while(true){
      const assistant = await llmOnce();
      const toolCalls = assistant.tool_calls || [];
      if (!toolCalls.length) break;

      const detail = document.createElement('div');
      detail.className = 'bubble tool';
      detail.innerHTML = '<div class="tiny">Tool calls (' + toolCalls.length + ')</div>';
      chat.appendChild(detail);

      const results = await Promise.all(toolCalls.map(async function(tc){
        try{
          const res = await execTool(tc);
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(res, null, 2);
          detail.appendChild(pre);
          state.msgs.push({ role:'tool', tool_call_id: tc.id, name: (tc["function"] && tc["function"].name) || '', content: JSON.stringify(res) });
          return { ok:true };
        }catch(e){
          const msg = { error: e.message };
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(msg, null, 2);
          detail.appendChild(pre);
          state.msgs.push({ role:'tool', tool_call_id: tc.id, name: (tc["function"] && tc["function"].name) || '', content: JSON.stringify(msg) });
          return { ok:false };
        }
      }));
      if (!results.length) break;
    }
  }catch(e){
    showAlert('Agent error: ' + e.message);
  }finally{
    state.running = false; sendBtn.disabled = false; stopBtn.disabled = true;
  }
}

// UI wiring
document.getElementById('composer').addEventListener('submit', function(e){
  e.preventDefault();
  if (state.running) return;
  const text = input.value.trim();
  if (!text) return;
  addBubble('user', escapeHTML(text));
  state.msgs.push({ role:'user', content:text });
  input.value = '';
  agentLoop();
});
stopBtn.addEventListener('click', function(){ location.reload(); });
document.getElementById('clearBtn').addEventListener('click', function(){
  state.msgs = state.msgs.slice(0,1); chat.innerHTML='';
  showAlert('Cleared chat','secondary',2000);
});

// Init
(function init(){
  updateStatus();
  addBubble('assistant', "Hi! I'm your browser agent. Click <strong>Pick Model</strong> to set a base URL, key, and model.");
})();

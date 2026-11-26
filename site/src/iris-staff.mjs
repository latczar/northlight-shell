import { pilotCalls } from './iris-calls.mjs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { renderDesk } from './iris-view.mjs';

const root = '/staff/iris/';
const acceptedTools = new Set(['submit_seo_copy', 'propose_services_title_preview']);
const accessKeys = new Map();
const headers = {
  'cache-control': 'private, no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
};
const message = (body, status) => new Response(body, {status, headers});
const home = (location = root) => new Response(null, {status:303, headers:{...headers, location}});
const visible = (item, person) => item?.agent === 'iris' && item.requestedBy === person && acceptedTools.has(item.tool);

async function staffPass(secret, person, purpose) {
    const expires = Math.floor(Date.now()/1000)+60;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signature = await crypto.subtle.sign('HMAC',key,encoder.encode([purpose,'kestrel',person,expires].filter(Boolean).join('\n')));
    const hex = Array.from(new Uint8Array(signature), b=>b.toString(16).padStart(2,'0')).join('');
    return [person,expires,hex].join('.');
}

export async function staffDesk(request, env, resolveKeys = issuer => {
  if (!accessKeys.has(issuer)) accessKeys.set(issuer, createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer)));
  return accessKeys.get(issuer);
}, providerFetch = fetch) {
  const issuer = env.IRIS_ACCESS_ISSUER;
  // The one staff account allowed in, and the person ID the agent knows them by.
  const staffEmail = env.IRIS_STAFF_EMAIL;
  const person = env.IRIS_STAFF_PERSON;
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || '') || !env.IRIS_ACCESS_AUD || !staffEmail || !person)
    return message('Staff sign-in is being configured.', 503);
  try {
    const token = request.headers.get('cf-access-jwt-assertion') || '';
    const {payload} = await jwtVerify(token, resolveKeys(issuer), {
      issuer, audience:env.IRIS_ACCESS_AUD, algorithms:['RS256'], requiredClaims:['exp','sub','email'],
    });
    if (payload.email !== staffEmail) return message('This account does not have staff access.', 403);
  } catch { return message('Sign in with your approved staff account.', 401); }

  const url = new URL(request.url);
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin)
    return message('Please submit this review from the staff dashboard.', 403);
  if (request.method === 'GET' && url.pathname === root.slice(0,-1)) return home();
  if (url.pathname === root+'calls' && request.method === 'GET') {
    // Phone calls are optional. Without a configured voice line, call history stays switched off.
    const line = {agent:env.IRIS_VOICE_AGENT_ID, branch:env.IRIS_VOICE_BRANCH_ID, number:env.IRIS_PHONE_NUMBER, handset:env.IRIS_STAFF_HANDSET};
    if (!env.IRIS_CALL_HISTORY_KEY || Object.values(line).some(value => !value)) return message('Call history is not set up for this demo.',503);
    const cursor = url.searchParams.get('cursor');
    if (cursor && cursor.length>1024) return message('Invalid history page.',400);
    try {
      const calls = await pilotCalls(env.IRIS_CALL_HISTORY_KEY,cursor,providerFetch,line);
      return new Response(renderDesk([],null,calls,env),{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
    } catch { return message('Call history is unavailable. Refresh to try again.',503); }
  }
  if (!env.AGENT || !env.CLIENT_TOKEN_KESTREL) return message('The staff connection is being configured.', 503);
  const brain = async (path, options = {}) => env.AGENT.fetch('https://northlight-agent.internal/v1/approvals'+path,{
    ...options, headers:{authorization:'Bearer '+env.CLIENT_TOKEN_KESTREL,...options.headers},
  });
  try {
    if (url.pathname === root+'chat') {
      const secret = env.USER_SIGNING_KEY_KESTREL;
      if (!secret || secret.length<32) return message('Staff chat is being configured.',503);
      const pass = await staffPass(secret, person);
      const endpoint = 'https://northlight-agent.internal/v1/agents/iris/conversations/kestrel-staff-desk/';
      const auth = {authorization:'Bearer '+env.CLIENT_TOKEN_KESTREL,'x-user-pass':pass};
      if (request.method==='GET') {
        const before = url.searchParams.get('before');
        if (before && !/^[1-9][0-9]{0,12}$/.test(before)) return message('Invalid chat page.',400);
        const [history, state] = await Promise.all([
          env.AGENT.fetch(endpoint+'messages?limit=50'+(before?'&before='+before:''),{headers:auth}),
          env.AGENT.fetch(endpoint+'job',{headers:auth}),
        ]);
        if (!history.ok || !state.ok) return message('Chat is unavailable. Refresh to try again.',503);
        return new Response(renderDesk([], {history:await history.json(),state:await state.json()}, null, env), {headers:{...headers,'content-type':'text/html; charset=utf-8'}});
      }
      if (request.method!=='POST') return message('Method not allowed.',405);
      const form = await request.formData();
      const id = String(form.get('id') || '');
      const text = String(form.get('text') || '').trim();
      if (!/^[a-f0-9-]{36}$/.test(id) || !text || text.length>2000) return message('Enter a message of up to 2000 characters.',400);
      const started = await env.AGENT.fetch(endpoint+'jobs',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({id,text})});
      if (!started.ok) return message('The message could not be confirmed. Reopen chat to check its status.',started.status);
      return home(root+'chat');
    }
    if (request.method === 'GET' && url.pathname === root) {
      const result = await brain('');
      if (!result.ok) return message('Review requests are unavailable. Refresh to try again.', 503);
      const {approvals} = await result.json();
      return new Response(renderDesk(approvals.filter(item => visible(item, person)), null, null, env), {headers:{...headers,'content-type':'text/html; charset=utf-8'}});
    }
    const match = url.pathname.match(/^\/staff\/iris\/review\/([a-zA-Z0-9_.:-]{1,128})$/);
    if (!match || request.method !== 'POST') return message('Page not found.',404);
    const recordPath = '/'+match[1];
    const result = await brain(recordPath);
    if (!result.ok) return message('Unable to open this review.',result.status === 404 ? 404 : 503);
    const item = await result.json();
    if (!visible(item, person)) return message('Review not found.',404);
    const form = await request.formData();
    const action = form.get('action');
    const reason = String(form.get('feedback') || '').trim();
    if (!['approve','changes','revise'].includes(action) || reason.length>500 || (action==='changes' && !reason))
      return message('Enter feedback of up to 500 characters and try again.',400);
    if (action==='revise' && item.tool!=='submit_seo_copy') return message('This request cannot be revised automatically.',409);
    const secret = env.APPROVER_SIGNING_KEY_KESTREL;
    if (!secret || secret.length<32) return message('Staff approvals are being configured.',503);
    const pass = await staffPass(secret,person,"approve");
    const decide = decision => brain(recordPath,{method:'POST',headers:{'content-type':'application/json','x-approver-pass':pass},body:JSON.stringify({decision,reason})});
    if (action!=='revise') {
      const decision = await decide(action==='approve'?'approve':'decline');
      if (!decision.ok) return message('The decision could not be confirmed. Return to the dashboard to see its current status.',decision.status);
      if (action==='changes') {
        const recorded = await decision.json();
        if (recorded.status!=='declined' || recorded.reason!==reason)
          return message('This draft already has different feedback. Your latest note was not saved. Return to the dashboard to review the recorded feedback.',409);
      }
    }
    if ((action==='changes' || action==='revise') && item.tool==='submit_seo_copy') {
      const revision = await decide('revise');
      if (!revision.ok) return message('Your feedback is saved. Return to the dashboard and choose Retry revision.',revision.status);
    }
    return home();
  } catch { return message('Iris could not complete this request. Refresh the dashboard to check its status.',503); }
}

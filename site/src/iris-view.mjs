const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mark = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M16 2 19 13 30 16 19 19 16 30 13 19 2 16 13 13Z"/></svg>';

function card(item, revised) {
  const p = item.preview || {};
  const path = '/staff/iris/review/'+encodeURIComponent(item.id);
  const previous = p.previousProposed || p.current;
  const pending = item.status === 'pending';
  const editorial = item.tool === 'submit_seo_copy';
  return `<article><h3>${escape(item.title)}</h3><p>${escape(p.reason || item.summary)}</p>
    ${previous ? `<details><summary>${p.previousProposed?'Previous draft':'Current wording'}</summary><p>${escape(previous)}</p></details>` : ''}
    <h4>Proposed wording</h4><blockquote>${escape(p.proposed)}</blockquote>
    ${p.reviewerFeedback || item.reason ? `<p><strong>Staff feedback</strong><br>${escape(p.reviewerFeedback || item.reason)}</p>` : ''}
    ${pending ? `<p>${editorial?'Approval records this wording.':'Approval opens a draft pull request for separate review.'}</p>
      <div class="actions"><form method="post" action="${path}"><button name="action" value="approve">Approve</button></form>
      <details><summary>${editorial?'Request changes':'Decline with feedback'}</summary><form method="post" action="${path}"><label>Feedback for Iris<textarea name="feedback" required maxlength="500"></textarea></label><button name="action" value="changes">Send feedback</button></form></details></div>`
    : `<strong>${escape(item.status)}</strong>${editorial && item.status==='declined' && item.reason && !revised ? `<form method="post" action="${path}"><button name="action" value="revise">Retry revision</button></form>` : ''}`}</article>`;
}

// env is optional: the phone link and call history appear only when a voice line is configured.
export function renderDesk(items, chat, calls, env = {}) {
  const pending = items.filter(i=>i.status==='pending');
  const past = items.filter(i=>i.status!=='pending');
  const revised = new Set(items.map(i=>i.preview?.revisionOf).filter(Boolean));
  const cards = group => group.map(i=>card(i,revised.has(i.id))).join('');
  const phone = /^\+[0-9]{8,15}$/.test(env.IRIS_PHONE_NUMBER || '') ? env.IRIS_PHONE_NUMBER : '';
  const callLink = phone ? `<a href="tel:${escape(phone)}"><span>Call Iris<small>${escape(env.IRIS_PHONE_DISPLAY || phone)}</small></span></a>` : '';
  const historyLink = env.IRIS_CALL_HISTORY_KEY ? '<a class="history-link" href="/staff/iris/calls">Call history</a>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Iris | Kestrel Garage staff</title>
  <style>*{box-sizing:border-box}body{margin:0;background:#f6f8f8;color:#1f2328;font:1rem/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}header{background:#1f2328;color:white;padding:1rem max(1rem,calc((100vw - 60rem)/2));font-weight:700}main{max-width:60rem;margin:auto;padding:clamp(1rem,4vw,3rem) 1rem}aside,article{background:white;border:1px solid #dde3e6;border-radius:.75rem;padding:clamp(1rem,3vw,2rem);margin-bottom:1rem}aside{border-top:4px solid #0f766e}h1,h2,h3,h4{line-height:1.2;margin:.25rem 0 .65rem}h1{font-size:clamp(2rem,5vw,3rem)}h2{margin-top:2rem}p,blockquote{overflow-wrap:anywhere}blockquote{margin:.5rem 0;padding:1rem;background:#e6f4f2;border-left:3px solid #0f766e}a{color:#0f766e}button,summary{cursor:pointer;font:inherit}button,.actions summary{padding:.65rem 1rem;border-radius:.4rem;min-height:44px;font-weight:650}button{background:#0f766e;color:white;border:0}.actions{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;align-items:start}.actions button,.actions summary,textarea{width:100%}.actions summary{border:1px solid #5b6670;text-align:center}textarea{display:block;min-height:6rem;font:inherit}label{display:block;margin:1rem 0}summary{padding:.5rem 0}@media(max-width:350px){.actions{grid-template-columns:1fr}}
.contact-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.6rem;max-width:30rem}
.contact-actions a,.actions summary,.actions>form>button{display:flex;align-items:center;justify-content:center;text-align:center;text-decoration:none;min-height:3.5rem;line-height:1.2;padding:.5rem;border:1px solid #5b6670;border-radius:.4rem}
.contact-actions .chatlink{background:#0f766e;color:white;border-color:#0f766e}
.contact-actions small{display:block;font-size:.75rem}.contact-actions span{display:block}
.actions summary{list-style:none}.actions summary::-webkit-details-marker{display:none}
.actions>form>button{border-color:#0f766e}
nav a{display:inline-block;padding:.5rem}
@media(min-width:800px){main{display:grid;grid-template-columns:15rem minmax(0,1fr);gap:2rem;align-items:start}aside{position:sticky;top:1rem}.contact-actions{grid-template-columns:1fr}section>h2:first-child{margin-top:0}}
:focus-visible{outline:3px solid #14b8a6;outline-offset:2px}header{display:flex;align-items:center;gap:1.5rem}header span{font-size:.875rem;font-weight:400;color:#e8ecef}.wordmark{display:inline-flex;align-items:center;gap:.5rem;font:800 1.4rem/1 Manrope,Inter,system-ui,Arial,sans-serif;letter-spacing:.01em}.mark{width:1.4rem;height:1.4rem;fill:#14b8a6}h1,h2,h3{font-family:Manrope,Inter,system-ui,Arial,sans-serif}.history-link{display:inline-block;margin-top:.6rem;padding:.55rem 0}.turn{white-space:pre-wrap}.call-row{border-bottom:1px solid #dde3e6;padding:.5rem 0}</style></head>
  <body><header><b class="wordmark">${mark}Northlight</b><span>Kestrel Garage staff dashboard</span></header><main><aside><h1>Iris</h1><p>Website manager &amp; SEO</p><div class="contact-actions">${callLink}<a class="chatlink" href="/staff/iris/chat">Chat with Iris</a></div>${historyLink}</aside><section>
  ${calls ? callHistory(calls) : chat ? conversation(chat) : `<h2>Review requests</h2>${cards(pending)||'<p>You’re all caught up.</p>'}
  <h2>Review history</h2>${cards(past)||'<p>Your decisions will appear here.</p>'}`}</section></main></body></html>`;
}

function conversation({history,state}) {
  const job = state.job;
  return `<nav><a href="/staff/iris/">Review requests</a> <a href="/staff/iris/chat">Refresh chat</a></nav>
  <article><h2>Staff chat</h2>${job ? '<p>Latest request: '+escape(job.status)+'</p>' : ''}
  ${history.more && history.messages.length ? '<a href="?before='+encodeURIComponent(history.messages[0].seq)+'">Earlier messages</a>' : ''}
  ${history.messages.map(m=>`<p><strong>${m.role==='user'?'You':'Iris'}</strong><br>${escape(m.text)}</p>`).join('') || '<p>Ask Iris to review a page on the Kestrel Garage website.</p>'}
  <form method="post" action="/staff/iris/chat"><label>Message Iris<textarea name="text" maxlength="2000" required></textarea></label>
  <input type="hidden" name="id" value="${crypto.randomUUID()}"><button>Send message</button></form></article>`;
}

function callHistory({records,cursor}) {
  const formatter = new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/London'});
  return `<nav><a href="/staff/iris/">Review requests</a> <a href="/staff/iris/calls">Refresh calls</a></nav><article>
    <h2>Call history</h2><p>Completed calls from the staff handset. Times are UK time.</p>
    ${records.map(record=>`<details class="call-row"><summary>${escape(formatter.format(record.time*1000))}, ${record.turns.length} ${record.turns.length===1?'turn':'turns'}</summary>
      ${record.turns.map(turn=>`<p class="turn"><strong>${escape(turn.who)}</strong><br>${escape(turn.text)}</p>`).join('') || '<p>Transcript unavailable.</p>'}</details>`).join('') || '<p>No completed calls from the staff handset on this page.</p>'}
    ${cursor ? '<a href="?cursor='+escape(encodeURIComponent(cursor))+'">Earlier calls</a>' : ''}</article>`;
}

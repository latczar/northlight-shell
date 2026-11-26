import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { staffDesk } from '../src/iris-staff.mjs';

test('staff member reviews a desktop draft and approves only its revision on a phone', async ({browser, request}, info) => {
  test.setTimeout(60000);
  const keys = await generateKeyPair('RS256');
  const issuer = 'https://fixture.cloudflareaccess.com';
  const audience = 'local-test';
  const jwt = (email, options = {}) => new SignJWT({email}).setProtectedHeader({alg:'RS256'}).setIssuer(options.issuer || issuer)
    .setAudience(options.audience || audience).setSubject('fixture').setExpirationTime(options.expiry || '5m').sign(keys.privateKey);
  const original = {id:'original',agent:'iris',requestedBy:'staff:alex-morgan',tool:'submit_seo_copy',title:'Services title',status:'pending',preview:{current:'Services',proposed:'Services in Milbrook'}};
  const other = {...original,id:'other',requestedBy:'other',title:'Private request'};
  const drafts = [original,other];
  const messages = [];
  let revisionAvailable = false;
  const secret = 'local-test-fixture-value-for-signing-only';
  const env = {IRIS_ACCESS_ISSUER:issuer,IRIS_ACCESS_AUD:audience,IRIS_STAFF_EMAIL:'alex.morgan@example.com',IRIS_STAFF_PERSON:'staff:alex-morgan',CLIENT_TOKEN_KESTREL:'local-token',APPROVER_SIGNING_KEY_KESTREL:secret,USER_SIGNING_KEY_KESTREL:secret,
    IRIS_VOICE_AGENT_ID:'agent_fixture',IRIS_VOICE_BRANCH_ID:'branch_fixture',IRIS_PHONE_NUMBER:'+441632960001',IRIS_PHONE_DISPLAY:'01632 960 001',IRIS_STAFF_HANDSET:'+441632960002',
    AGENT:{async fetch(url, options) {
      expect(options.headers.authorization).toBe('Bearer local-token');
      const path = new URL(url).pathname;
      const pass = options.headers['x-approver-pass'] || options.headers['x-user-pass'];
      if (pass) {
        const [who,exp,mac] = pass.split('.');
        expect(who).toBe('staff:alex-morgan');
        const payload = [options.headers['x-approver-pass']?'approve':'','kestrel',who,exp].filter(Boolean).join('\n');
        expect(mac).toBe(createHmac('sha256',secret).update(payload).digest('hex'));
      }
      if(path.endsWith('/jobs')) {
        expect(pass).toBeTruthy();
        messages.push({role:'user',text:JSON.parse(options.body).text,seq:1});
        return Response.json({},{status:202});
      }
      if(path.endsWith('/messages')) return Response.json({messages,more:false});
      if(path.endsWith('/job')) return Response.json({job:null});
      if(path==='/v1/approvals') return Response.json({approvals:drafts});
      const item = drafts.find(i=>path.endsWith('/'+i.id));
      if(!item) return new Response(null,{status:404});
      if(options.method!=='POST') return Response.json(item);
      expect(pass).toBeTruthy();
      const {decision,reason} = JSON.parse(options.body);
      if(decision==='revise') {
        if(!revisionAvailable) return new Response(null,{status:503});
        drafts.push({...original,id:'revised',status:'pending',preview:{previousProposed:original.preview.proposed,revisionOf:original.id,proposed:'Brake and suspension services',reviewerFeedback:original.reason}});
      } else if (item.status==='pending') {
        item.status=decision==='approve'?'done':'declined';
        item.reason=reason;
      }
      return Response.json(item);
    }}};
  let historyReads = 0;
  let providerAvailable = false;
  env.IRIS_CALL_HISTORY_KEY = 'history-fixture';
  const providerFetch = async (url, options) => {
    historyReads++;
    expect(options.headers['xi-api-key']).toBe('history-fixture');
    if (!providerAvailable) return new Response(null,{status:503});
    const current = new URL(url);
    const item = {agent_id:'agent_fixture',branch_id:'branch_fixture',
      status:'done',direction:'inbound',conversation_id:'conv_pilot'};
    if (current.pathname.endsWith('/conversations')) {
      if (current.searchParams.has('cursor')) return Response.json({conversations:[]});
      return Response.json({conversations:[item,item],has_more:true,next_cursor:'older+page'});
    }
    return Response.json({...item,metadata:{start_time_unix_secs:1700000000,phone_call:{
      direction:'inbound',agent_number:'+441632960001',external_number:'+441632960002',
    }},transcript:[{role:'user',message:'What should we change?'},{role:'agent',message:'Review the Services title.'}]});
  };
  const server = createServer(async (req,res)=>{
    const chunks=[];
    for await(const chunk of req) chunks.push(chunk);
    const response = await staffDesk(new Request('http://'+req.headers.host+req.url,{
      headers:req.headers,method:req.method,body:chunks.length?Buffer.concat(chunks):undefined,
    }),env,()=>keys.publicKey,providerFetch);
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const home=origin+'/staff/iris/';
  const headers={'cf-access-jwt-assertion':await jwt('alex.morgan@example.com')};
  const pc=await browser.newContext({extraHTTPHeaders:headers,viewport:{width:1280,height:820}});
  const mobile=await browser.newContext({extraHTTPHeaders:headers,viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try {
    expect((await request.get(home)).status()).toBe(401);
    expect((await request.get(home,{headers:{'cf-access-jwt-assertion':await jwt('owner@example.com')}})).status()).toBe(403);
    expect((await request.post(home+'review/original',{headers,form:{action:'approve'}})).status()).toBe(403);
    expect((await request.post(home+'review/other',{headers:{...headers,origin},form:{action:'approve'}})).status()).toBe(404);
    expect((await request.get(home+'calls')).status()).toBe(401);
    expect((await request.get(home+'calls',{headers:{'cf-access-jwt-assertion':await jwt('owner@example.com')}})).status()).toBe(403);
    for (const options of [{issuer:'https://other.cloudflareaccess.com'},{audience:'different-app'},{expiry:Math.floor(Date.now()/1000)-60}]) {
      const credentials = {'cf-access-jwt-assertion':await jwt('alex.morgan@example.com',options),'cf-access-authenticated-user-email':'alex.morgan@example.com'};
      expect((await request.get(home+'calls',{headers:credentials})).status()).toBe(401);
      expect((await request.post(home+'review/original',{headers:{...credentials,origin},form:{action:'approve'}})).status()).toBe(401);
    }
    expect(original.status).toBe('pending');
    expect(historyReads).toBe(0);
    const desktop=await pc.newPage();
    await desktop.goto(home);
    await expect(desktop.getByText('Private request')).toHaveCount(0);
    await expect(desktop.getByRole('link',{name:/Call Iris/})).toHaveAttribute('href','tel:+441632960001');
    await desktop.screenshot({path:info.outputPath('staff-desktop.png')});
    await desktop.getByText('Request changes',{exact:true}).click();
    await desktop.getByLabel('Feedback for Iris').fill('Name the services.');
    await desktop.getByRole('button',{name:'Send feedback'}).click();
    await expect(desktop.locator('body')).toContainText('Your feedback is saved');
    const staleFeedback=await request.post(home+'review/original',{headers:{...headers,origin},form:{action:'changes',feedback:'A different note from an older tab.'}});
    expect(staleFeedback.status()).toBe(409);
    expect(await staleFeedback.text()).toContain('latest note was not saved');
    expect(original.reason).toBe('Name the services.');
    expect(drafts).toHaveLength(2);
    revisionAvailable=true;
    await desktop.goto(home);
    await desktop.getByRole('button',{name:'Retry revision'}).click();
    const phone=await mobile.newPage();
    await phone.goto(home);
    await phone.getByText('Previous draft',{exact:true}).click();
    await expect(phone.getByText(original.preview.proposed,{exact:true}).first()).toBeVisible();
    expect(await phone.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
    for (const [left, right] of [
      [phone.getByRole('link',{name:/Call Iris/}),phone.getByRole('link',{name:'Chat with Iris'})],
      [phone.getByRole('button',{name:'Approve',exact:true}),phone.getByText('Request changes',{exact:true})],
    ]) {
      const a=await left.boundingBox(), b=await right.boundingBox();
      expect(Math.abs(a.height-b.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.width-b.width)).toBeLessThanOrEqual(1);
    }
    await phone.screenshot({path:info.outputPath('staff-mobile.png')});
    await phone.getByRole('button',{name:'Approve',exact:true}).tap();
    await expect(phone.getByText('You’re all caught up.')).toBeVisible();
    expect(drafts.map(i=>i.status)).toEqual(['declined','pending','done']);
    await phone.getByRole('link',{name:'Call history',exact:true}).click();
    await expect(phone.locator('body')).toContainText('Call history is unavailable');
    providerAvailable=true;
    await phone.reload();
    await expect(phone.locator('.call-row')).toHaveCount(1);
    await expect(phone.locator('.call-row summary')).toHaveText(/, 2 turns$/);
    await phone.locator('.call-row summary').press('Enter');
    await expect(phone.locator('.turn')).toHaveText(['YouWhat should we change?','IrisReview the Services title.']);
    await phone.getByRole('link',{name:'Earlier calls'}).click();
    await expect(phone.getByText('No completed calls from the staff handset on this page.')).toBeVisible();
    await phone.getByRole('link',{name:'Chat with Iris'}).click();
    await phone.getByLabel('Message Iris').fill('Review the Services page');
    await phone.getByRole('button',{name:'Send message'}).click();
    await expect(phone.locator('article p').filter({hasText:'Review the Services page'})).toBeVisible();
  } finally {
    await pc.close();
    await mobile.close();
    await new Promise(resolve=>server.close(resolve));
  }
});

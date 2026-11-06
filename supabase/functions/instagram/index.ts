// Wasla Instagram server. Deploy with verify_jwt=false: Meta calls the webhook without a Supabase session,
// and app actions check the signed-in user themselves.
// Secrets: IG_APP_ID, IG_APP_SECRET (Instagram app secret), IG_VERIFY_TOKEN (webhook verify token),
// WASLA_APP_URL (the /app/ page Instagram sends people back to after they connect, e.g. https://wasla.ma/app/).
import {createClient} from 'npm:@supabase/supabase-js@2.57.4';
import {GRAPH,parseWebhook,verifyMetaSignature,pickRule,windowOpen,autoAllowed,authorizeUrl,tokenFromExchange,replyText,clipBytes,safeEqual} from './model.js';

const env=(k:string)=>Deno.env.get(k)||'';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
const reply=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const db=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}});
const ig=(url:string,init:RequestInit={})=>fetch(url,{...init,signal:AbortSignal.timeout(8000),redirect:'error'});

async function log(workspace:string|null,kind:string,ok:boolean,detail=''){
 await db.from('event_log').insert({workspace_id:workspace,kind,ok,detail:String(detail).slice(0,300)});
 if(Math.random()<0.02)await db.from('event_log').delete().lt('created_at',new Date(Date.now()-14*86400000).toISOString());
}

// --- OAuth state: workspace + user + expiry, signed with the app secret (no table needed) ---------------
const enc=new TextEncoder();
async function hmac(text:string){
 const key=await crypto.subtle.importKey('raw',enc.encode(env('IG_APP_SECRET')),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function makeState(workspace:string,user:string){const body=workspace+'.'+user+'.'+(Date.now()+15*60000);return body+'.'+await hmac(body);}
async function readState(state:string,user:string){
 const p=String(state||'').split('.');if(p.length!==4)return null;
 const [workspace,owner,exp,sig]=p;
 if(!UUID.test(workspace)||owner!==user||!(Number(exp)>Date.now()))return null;
 return safeEqual(sig,await hmac(workspace+'.'+owner+'.'+exp))?workspace:null;
}

// --- tokens ----------------------------------------------------------------------------------------------
// Long-lived tokens last 60 days; refresh once fewer than 20 days remain (Instagram allows it after 24 h).
async function tokenFor(workspace:string){
 const [{data:acc},{data:tok}]=await Promise.all([
  db.from('instagram_accounts').select('ig_user_id,status,token_expires_at').eq('workspace_id',workspace).maybeSingle(),
  db.from('instagram_tokens').select('access_token,refreshed_at').eq('workspace_id',workspace).maybeSingle()]);
 if(!acc||!tok||acc.status!=='connected')return null;
 const left=acc.token_expires_at?new Date(acc.token_expires_at).getTime()-Date.now():0;
 if(left<=0){await db.from('instagram_accounts').update({status:'expired'}).eq('workspace_id',workspace);return null;}
 if(left<20*86400000&&Date.now()-new Date(tok.refreshed_at).getTime()>86400000){
  try{
   const r=await ig('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token='+encodeURIComponent(tok.access_token));
   const j=await r.json();
   if(r.ok&&typeof j.access_token==='string'){
    const now=new Date().toISOString();
    await db.from('instagram_tokens').update({access_token:j.access_token,refreshed_at:now}).eq('workspace_id',workspace);
    await db.from('instagram_accounts').update({token_expires_at:new Date(Date.now()+Number(j.expires_in||5184000)*1000).toISOString()}).eq('workspace_id',workspace);
    return {account:acc.ig_user_id,token:j.access_token};
   }
  }catch{/* keep the current token */}
 }
 return {account:acc.ig_user_id,token:tok.access_token};
}

async function sendMessage(account:string,token:string,recipient:Record<string,string>,text:string){
 const r=await ig(GRAPH+'/'+account+'/messages',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
  body:JSON.stringify({recipient,message:{text:clipBytes(text)}})});
 const j=await r.json().catch(()=>({}));
 if(!r.ok||typeof j.message_id!=='string')throw Error(j?.error?.message?String(j.error.message).slice(0,200):'send_failed');
 return j.message_id as string;
}

async function fillProfile(workspace:string,contactId:string,igsid:string,token:string){
 try{
  const r=await ig(GRAPH+'/'+igsid+'?fields=name,username&access_token='+encodeURIComponent(token));if(!r.ok)return;
  const j=await r.json();
  await db.from('contacts').update({username:String(j.username||'').slice(0,60),name:String(j.name||'').slice(0,100)}).eq('id',contactId).eq('workspace_id',workspace);
 }catch{/* profile is optional */}
}

const record=(p:Record<string,unknown>)=>db.rpc('wasla_record_message',p).then(({data,error})=>{if(error)throw error;return data as any;});

// --- webhook events ----------------------------------------------------------------------------------------
async function handleMessage(ev:any,workspace:string,settings:any,auth:{account:string,token:string}|null){
 // Instagram also echoes the messages Wasla sends. Wait a moment so our own copy (auto/staff) is saved first;
 // an echo that is still new after that was written in the Instagram app by a person.
 if(ev.echo)await new Promise(r=>setTimeout(r,3000));
 const saved=await record({p_workspace:workspace,p_igsid:ev.contact,p_mid:ev.mid,p_direction:ev.echo?'out':'in',p_sender:ev.echo?'instagram_app':'customer',
  p_body:ev.text,p_kind:ev.kind,p_at:ev.at});
 if(saved.duplicate||ev.echo||!auth)return;
 if(!saved.username)await fillProfile(workspace,saved.contact_id,ev.contact,auth.token);
 if(!settings?.auto_reply_dm||ev.kind!=='text')return;
 const {data:contact}=await db.from('contacts').select('name,username,last_staff_at').eq('id',saved.contact_id).single();
 if(!autoAllowed(contact?.last_staff_at,settings.human_pause_minutes))return;
 const {data:rules}=await db.from('rules').select('*').eq('workspace_id',workspace).eq('kind','dm').eq('is_active',true);
 const rule=pickRule(ev.text,rules||[],'dm');if(!rule)return;
 // the same rule answers one person at most once every 6 hours
 const {count}=await db.from('messages').select('id',{count:'exact',head:true}).eq('contact_id',saved.contact_id).eq('rule_id',rule.id).gte('created_at',new Date(Date.now()-6*3600000).toISOString());
 if(count)return;
 const text=replyText(rule,contact?.name||contact?.username);
 try{
  const mid=await sendMessage(auth.account,auth.token,{id:ev.contact},text);
  await record({p_workspace:workspace,p_igsid:ev.contact,p_mid:mid,p_direction:'out',p_sender:'auto',p_body:text,p_kind:'text',p_at:new Date().toISOString(),p_rule:rule.id});
 }catch(e){await log(workspace,'auto_reply',false,(e as Error).message);}
}

async function handleComment(ev:any,workspace:string,settings:any,auth:{account:string,token:string}|null){
 if(!settings?.auto_reply_comments||!auth||ev.parent)return; // answers to other comments are ignored
 const {data:rules}=await db.from('rules').select('*').eq('workspace_id',workspace).eq('kind','comment').eq('is_active',true);
 const rule=pickRule(ev.text,rules||[],'comment',ev.media);if(!rule)return;
 const {error:claim}=await db.from('comment_replies').insert({comment_id:ev.comment,workspace_id:workspace,rule_id:rule.id});
 if(claim)return; // already answered (Instagram allows one private reply per comment)
 await record({p_workspace:workspace,p_igsid:ev.from,p_mid:'comment:'+ev.comment,p_direction:'in',p_sender:'customer',p_body:ev.text,p_kind:'comment',p_at:new Date().toISOString()});
 const text=replyText(rule,ev.username);
 try{
  const mid=await sendMessage(auth.account,auth.token,{comment_id:ev.comment},text);
  await record({p_workspace:workspace,p_igsid:ev.from,p_mid:mid,p_direction:'out',p_sender:'auto',p_body:text,p_kind:'text',p_at:new Date().toISOString(),p_rule:rule.id});
  await db.from('comment_replies').update({state:'sent'}).eq('comment_id',ev.comment);
  if(rule.public_reply?.trim()){
   const r=await ig(GRAPH+'/'+ev.comment+'/replies',{method:'POST',headers:{Authorization:'Bearer '+auth.token,'Content-Type':'application/json'},body:JSON.stringify({message:rule.public_reply.trim().slice(0,300)})});
   if(!r.ok)await log(workspace,'public_reply',false,'status '+r.status);
  }
 }catch(e){
  await db.from('comment_replies').update({state:'failed',error:(e as Error).message.slice(0,200)}).eq('comment_id',ev.comment);
  await log(workspace,'comment_reply',false,(e as Error).message);
 }
}

async function webhook(req:Request){
 const raw=await req.text();if(raw.length>256000)return reply({error:'request_too_large'},413);
 if(!await verifyMetaSignature(raw,req.headers.get('X-Hub-Signature-256'),env('IG_APP_SECRET')))return reply({error:'invalid_signature'},401);
 let body;try{body=JSON.parse(raw);}catch{return reply({ok:true});}
 const events=parseWebhook(body),cache=new Map<string,any>();
 for(const ev of events){
  try{
   if(!cache.has(ev.account)){
    const {data:acc}=await db.from('instagram_accounts').select('workspace_id,status').eq('ig_user_id',ev.account).maybeSingle();
    if(!acc||acc.status==='disconnected'){cache.set(ev.account,null);}
    else{
     const {data:settings}=await db.from('workspace_settings').select('*').eq('workspace_id',acc.workspace_id).maybeSingle();
     cache.set(ev.account,{workspace:acc.workspace_id,settings,auth:await tokenFor(acc.workspace_id)});
     await db.from('instagram_accounts').update({last_event_at:new Date().toISOString()}).eq('workspace_id',acc.workspace_id);
    }
   }
   const ctx=cache.get(ev.account);if(!ctx)continue;
   if(ev.type==='message')await handleMessage(ev,ctx.workspace,ctx.settings,ctx.auth);
   else await handleComment(ev,ctx.workspace,ctx.settings,ctx.auth);
  }catch(e){await log(cache.get(ev.account)?.workspace||null,'webhook',false,(e as Error).message||'error');}
 }
 // Meta retries anything that is not 200, so always answer 200 once the signature is valid.
 return reply({ok:true});
}

// --- app actions (signed-in members) ------------------------------------------------------------------------
async function action(req:Request){
 const jwt=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
 const {data:{user},error:authError}=await db.auth.getUser(jwt);if(authError||!user)return reply({error:'invalid_session'},401);
 const raw=await req.text();if(raw.length>8000)return reply({error:'request_too_large'},413);
 let p:any;try{p=JSON.parse(raw);}catch{return reply({error:'invalid_request'},400);}
 const workspace=String(p.workspace_id||'');if(!UUID.test(workspace))return reply({error:'invalid_request'},400);
 const {data:member}=await db.from('workspace_members').select('role').eq('workspace_id',workspace).eq('user_id',user.id).maybeSingle();
 if(!member)return reply({error:'forbidden'},403);
 const manager=['owner','admin'].includes(member.role);
 const configured=!!(env('IG_APP_ID')&&env('IG_APP_SECRET')&&env('WASLA_APP_URL'));

 if(p.action==='connect_url'){
  if(!manager)return reply({error:'forbidden'},403);if(!configured)return reply({error:'server_not_configured'},503);
  return reply({url:authorizeUrl(env('IG_APP_ID'),env('WASLA_APP_URL'),await makeState(workspace,user.id))});
 }
 if(p.action==='connect'){
  if(!manager)return reply({error:'forbidden'},403);if(!configured)return reply({error:'server_not_configured'},503);
  if(await readState(String(p.state||''),user.id)!==workspace)return reply({error:'invalid_state'},400);
  const form=new URLSearchParams({client_id:env('IG_APP_ID'),client_secret:env('IG_APP_SECRET'),grant_type:'authorization_code',redirect_uri:env('WASLA_APP_URL'),code:String(p.code||'').replace(/#_$/,'')});
  const r1=await ig('https://api.instagram.com/oauth/access_token',{method:'POST',body:form});
  const short=tokenFromExchange(await r1.json().catch(()=>null));if(!r1.ok||!short)return reply({error:'instagram_refused'},400);
  const r2=await ig('https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret='+encodeURIComponent(env('IG_APP_SECRET'))+'&access_token='+encodeURIComponent(short.token));
  const long=await r2.json().catch(()=>null);if(!r2.ok||typeof long?.access_token!=='string')return reply({error:'instagram_refused'},400);
  const r3=await ig(GRAPH+'/me?fields=user_id,username,account_type&access_token='+encodeURIComponent(long.access_token));
  const me=await r3.json().catch(()=>null);const igId=String(me?.user_id||'');
  if(!r3.ok||!/^[0-9]{1,30}$/.test(igId))return reply({error:'instagram_refused'},400);
  const {data:other}=await db.from('instagram_accounts').select('workspace_id').eq('ig_user_id',igId).maybeSingle();
  if(other&&other.workspace_id!==workspace)return reply({error:'account_in_other_workspace'},409);
  const r4=await ig(GRAPH+'/me/subscribed_apps?subscribed_fields=messages,comments&access_token='+encodeURIComponent(long.access_token),{method:'POST'});
  if(!r4.ok)return reply({error:'subscribe_failed'},502);
  const now=new Date().toISOString();
  const {error:e1}=await db.from('instagram_accounts').upsert({workspace_id:workspace,ig_user_id:igId,username:String(me.username||'').slice(0,60),status:'connected',
   token_expires_at:new Date(Date.now()+Number(long.expires_in||5184000)*1000).toISOString(),connected_by:user.id,connected_at:now});
  if(e1)return reply({error:'save_failed'},500);
  const {error:e2}=await db.from('instagram_tokens').upsert({workspace_id:workspace,access_token:long.access_token,refreshed_at:now});
  if(e2)return reply({error:'save_failed'},500);
  await log(workspace,'connect',true,'@'+String(me.username||''));
  return reply({ok:true,username:me.username||''});
 }
 if(p.action==='disconnect'){
  if(!manager)return reply({error:'forbidden'},403);
  await db.from('instagram_tokens').delete().eq('workspace_id',workspace);
  await db.from('instagram_accounts').update({status:'disconnected'}).eq('workspace_id',workspace);
  await log(workspace,'disconnect',true);
  return reply({ok:true});
 }
 if(p.action==='send'){
  const text=String(p.text||'').trim();if(!text||text.length>1000||!UUID.test(String(p.contact_id||'')))return reply({error:'invalid_request'},400);
  const {data:c}=await db.from('contacts').select('igsid,last_customer_at').eq('id',p.contact_id).eq('workspace_id',workspace).maybeSingle();
  if(!c)return reply({error:'not_found'},404);
  if(!windowOpen(c.last_customer_at))return reply({error:'window_closed'},409);
  const auth=await tokenFor(workspace);if(!auth)return reply({error:'not_connected'},409);
  let mid;try{mid=await sendMessage(auth.account,auth.token,{id:c.igsid},text);}catch(e){await log(workspace,'send',false,(e as Error).message);return reply({error:'instagram_refused'},502);}
  await record({p_workspace:workspace,p_igsid:c.igsid,p_mid:mid,p_direction:'out',p_sender:'staff',p_body:text,p_kind:'text',p_at:new Date().toISOString(),p_sent_by:user.id});
  return reply({ok:true});
 }
 if(p.action==='status')return reply({configured,webhook_url:new URL(req.url).origin+'/functions/v1/instagram?webhook=1'});
 return reply({error:'unknown_action'},400);
}

Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 try{
  if(!env('SUPABASE_SERVICE_ROLE_KEY'))return reply({error:'server_not_configured'},503);
  const url=new URL(req.url);
  if(url.searchParams.get('webhook')==='1'){
   if(req.method==='GET'){
    // Meta's one-time check when the webhook address is saved in the developer dashboard
    const q=url.searchParams;
    if(q.get('hub.mode')==='subscribe'&&safeEqual(q.get('hub.verify_token'),env('IG_VERIFY_TOKEN')))return new Response(q.get('hub.challenge')||'',{status:200});
    return new Response('forbidden',{status:403});
   }
   if(req.method==='POST')return await webhook(req);
  }
  if(req.method==='POST')return await action(req);
  return reply({error:'method_not_allowed'},405);
 }catch(e){console.error(e);return reply({error:'request_failed'},500);}
});

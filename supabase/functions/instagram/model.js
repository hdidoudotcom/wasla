// Pure helpers for the instagram Edge Function. No network, no database: tested in tests/model.test.mjs.
export const GRAPH='https://graph.instagram.com/v24.0';
export const SCOPES=['instagram_business_basic','instagram_business_manage_messages','instagram_business_manage_comments'];
export const REPLY_WINDOW_MS=24*3600000;

// Lower case, no accents, Arabic letter variants unified, punctuation removed.
export function normalize(value){
 return String(value||'').normalize('NFD').replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g,'').toLowerCase()
  .replace(/[\u0622\u0623\u0625]/g,'\u0627').replace(/\u0629/g,'\u0647').replace(/\u0649/g,'\u064a')
  .replace(/[^a-z0-9\u0621-\u064a]+/g,' ').trim();
}
// A keyword matches as a whole word or phrase ("prix" matches "le prix ?" but not "prixe").
export function hasKeyword(text,keyword){
 const t=' '+normalize(text)+' ',k=normalize(keyword);
 return !!k&&t.includes(' '+k+' ');
}
// First active rule (by position) whose keyword appears; rules without keywords are a fallback used last.
export function pickRule(text,rules,kind,mediaId=null){
 const list=(Array.isArray(rules)?rules:[]).filter(r=>r&&r.is_active&&r.kind===kind&&(!r.media_id||r.media_id===mediaId))
  .sort((a,b)=>(a.position??0)-(b.position??0));
 const keyed=list.find(r=>Array.isArray(r.keywords)&&r.keywords.some(k=>hasKeyword(text,k)));
 if(keyed)return keyed;
 // a post-specific catch-all wins over a general one
 const fallback=list.filter(r=>!Array.isArray(r.keywords)||!r.keywords.length);
 return fallback.find(r=>r.media_id)||fallback[0]||null;
}
// Instagram allows a business to answer only within 24 hours of the customer's last message.
export function windowOpen(lastCustomerAt,now=Date.now()){
 if(!lastCustomerAt)return false;
 const t=new Date(lastCustomerAt).getTime();
 return Number.isFinite(t)&&now-t<REPLY_WINDOW_MS;
}
// Automatic replies stay quiet while a person handles the conversation.
export function autoAllowed(lastStaffAt,pauseMinutes,now=Date.now()){
 if(!lastStaffAt||!pauseMinutes)return true;
 const t=new Date(lastStaffAt).getTime();
 return !Number.isFinite(t)||now-t>=pauseMinutes*60000;
}

export function safeEqual(a,b){a=String(a||'');b=String(b||'');if(!a||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
// Meta signs every webhook: X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>.
export async function verifyMetaSignature(raw,header,secret){
 const m=/^sha256=([0-9a-f]{64})$/i.exec(String(header||''));if(!secret||!m)return false;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 const bytes=Uint8Array.from(m[1].match(/../g),s=>parseInt(s,16));
 return crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(raw));
}

const id=v=>typeof v==='string'&&/^[0-9]{1,30}$/.test(v)?v:(typeof v==='number'&&Number.isSafeInteger(v)?String(v):null);
// Webhook body -> flat list of events we handle. Anything unexpected is skipped, never thrown.
export function parseWebhook(body){
 const out=[];if(body?.object!=='instagram'||!Array.isArray(body.entry))return out;
 for(const entry of body.entry){
  const account=id(entry?.id);if(!account)continue;
  for(const ev of Array.isArray(entry.messaging)?entry.messaging:[]){
   const msg=ev?.message;if(!msg||typeof msg.mid!=='string'||msg.is_deleted)continue;
   const sender=id(ev.sender?.id),recipient=id(ev.recipient?.id);if(!sender||!recipient)continue;
   const echo=msg.is_echo===true||sender===account;
   const text=typeof msg.text==='string'?msg.text:'';
   const kind=text?'text':Array.isArray(msg.attachments)&&msg.attachments.length?'attachment':'unsupported';
   out.push({type:'message',account,contact:echo?recipient:sender,echo,mid:msg.mid.slice(0,300),text:text.slice(0,2000),kind,
    at:Number.isFinite(ev.timestamp)?new Date(ev.timestamp).toISOString():new Date().toISOString()});
  }
  for(const ch of Array.isArray(entry.changes)?entry.changes:[]){
   if(ch?.field!=='comments'&&ch?.field!=='live_comments')continue;
   const v=ch.value||{},comment=id(v.id),from=id(v.from?.id);if(!comment||!from)continue;
   if(from===account)continue; // our own replies
   out.push({type:'comment',account,comment,from,username:String(v.from?.username||'').slice(0,60),media:id(v.media?.id),
    text:String(v.text||'').slice(0,2000),parent:id(v.parent_id)});
  }
 }
 return out;
}

export function authorizeUrl(appId,redirectUri,state){
 const q=new URLSearchParams({client_id:appId,redirect_uri:redirectUri,response_type:'code',scope:SCOPES.join(','),state});
 return 'https://www.instagram.com/oauth/authorize?'+q;
}
// The code-exchange answer comes either flat or wrapped in data[0].
export function tokenFromExchange(json){
 const r=Array.isArray(json?.data)?json.data[0]:json;
 return r&&typeof r.access_token==='string'?{token:r.access_token,user_id:id(r.user_id)}:null;
}
// The reply text a rule sends (one Instagram text message is at most 1000 characters).
// Instagram refuses text over 1000 bytes (Arabic letters take 2 bytes each), so cut on a character boundary.
export function clipBytes(text,max=1000){
 const enc=new TextEncoder();let out='',size=0;
 for(const ch of String(text||'')){const n=enc.encode(ch).length;if(size+n>max)break;out+=ch;size+=n;}
 return out;
}
export function replyText(rule,contactName=''){
 return clipBytes(String(rule?.reply||'').replace(/\{name\}/g,String(contactName||'').trim()).replace(/[ \t]+\n/g,'\n').trim());
}

import {createClient} from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/+esm';
import {SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY} from './config.js';
// Wasla app: sign-in, business (workspace) choice, inbox, automatic reply rules, Instagram connection.
// Reads go through Row Level Security (members see only their business); Instagram calls go through the instagram Edge Function.
const sb=createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const show=(id)=>['auth','onboard','shell'].forEach(x=>$('#'+x).classList.toggle('hidden',x!==id));
const say=(el,t,bad=false)=>{el.textContent=t;el.classList.toggle('error',bad);};
const DAY=86400000;
const time=v=>{const d=new Date(v),n=new Date();return d.toDateString()===n.toDateString()?d.toLocaleTimeString('fr-MA',{hour:'2-digit',minute:'2-digit'}):d.toLocaleDateString('fr-MA',{day:'2-digit',month:'short'});};
const errors={window_closed:'Plus de 24 h depuis le dernier message du client : Instagram ne permet plus de répondre. Attendez qu’il vous réécrive.',not_connected:'Instagram n’est pas connecté.',instagram_refused:'Instagram a refusé. Réessayez ou reconnectez le compte.',
 forbidden:'Vous n’avez pas le droit de faire ça.',server_not_configured:'Le serveur Wasla n’est pas encore configuré.',invalid_state:'Le lien de connexion a expiré. Recommencez.',account_in_other_workspace:'Ce compte Instagram est déjà connecté à un autre business.',subscribe_failed:'Instagram n’a pas accepté l’abonnement aux messages.'};
let user=null,workspaces=[],ws=null,role='agent',contacts=[],current=null,poll=null,signup=false;

async function api(action,extra={}){
 const {data:{session}}=await sb.auth.getSession();
 const r=await fetch(SUPABASE_URL+'/functions/v1/instagram',{method:'POST',headers:{Authorization:'Bearer '+session?.access_token,apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({action,workspace_id:ws,...extra})});
 const j=await r.json().catch(()=>({}));if(!r.ok)throw Error(j.error||'request_failed');return j;
}

// --- sign in ----------------------------------------------------------------------------------------
$('#auth-switch').addEventListener('click',()=>{signup=!signup;$('[data-auth-submit]').textContent=signup?'Créer mon compte':'Se connecter';$('#auth-switch').textContent=signup?'Déjà un compte ? Se connecter':'Pas encore de compte ? Créer un compte';});
$('#auth-form').addEventListener('submit',async e=>{
 e.preventDefault();const f=new FormData(e.target),email=f.get('email'),password=f.get('password'),msg=$('#auth-msg');say(msg,'…');
 const {error}=signup?await sb.auth.signUp({email,password,options:{emailRedirectTo:location.origin+'/app/'}}):await sb.auth.signInWithPassword({email,password});
 if(error){say(msg,signup?'Création impossible : '+error.message:'E-mail ou mot de passe incorrect.',true);return;}
 if(signup){const {data:{session}}=await sb.auth.getSession();if(!session){say(msg,'Vérifiez votre e-mail pour confirmer le compte.');return;}}
 start();
});
$$('[data-signout]').forEach(b=>b.addEventListener('click',async()=>{await sb.auth.signOut();location.href='/app/';}));

// --- workspaces ---------------------------------------------------------------------------------------
$('#ws-form').addEventListener('submit',async e=>{
 e.preventDefault();const name=new FormData(e.target).get('name');
 const {data,error}=await sb.rpc('wasla_create_workspace',{p_name:name});
 if(error){say($('#ws-msg'),'Création impossible.',true);return;}
 localStorageSet('wasla_ws',data);start();
});
function localStorageGet(k){try{return localStorage.getItem(k);}catch{return null;}}
function localStorageSet(k,v){try{localStorage.setItem(k,v);}catch{}}
$('#ws-select').addEventListener('change',e=>{ws=e.target.value;localStorageSet('wasla_ws',ws);openWorkspace();});

async function start(){
 const {data:{session}}=await sb.auth.getSession();user=session?.user||null;
 if(!user){show('auth');return;}
 const {data:rows}=await sb.from('workspace_members').select('workspace_id,role,workspaces(name)').eq('user_id',user.id);
 workspaces=(rows||[]).map(r=>({id:r.workspace_id,role:r.role,name:r.workspaces?.name||'Business'}));
 if(!workspaces.length){show('onboard');return;}
 const params=new URLSearchParams(location.search),state=params.get('state')||'';
 const fromState=state.split('.')[0];
 ws=workspaces.find(w=>w.id===fromState)?.id||workspaces.find(w=>w.id===localStorageGet('wasla_ws'))?.id||workspaces[0].id;
 $('#ws-select').innerHTML=workspaces.map(w=>`<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('');
 show('shell');
 if(params.get('code')&&fromState===ws)await finishConnect(params.get('code'),state);
 else if(params.get('error'))say($('#msg'),'Connexion Instagram annulée.',true);
 if(params.has('code')||params.has('error'))history.replaceState(null,'','/app/');
 openWorkspace();
}
function openWorkspace(){
 $('#ws-select').value=ws;role=workspaces.find(w=>w.id===ws)?.role||'agent';current=null;
 $('#rule-new').classList.toggle('hidden',role==='agent');
 const tab=$$('[data-tab]').find(b=>b.classList.contains('active'))?.dataset.tab||'inbox';openTab(tab);
}

// --- tabs ---------------------------------------------------------------------------------------------
$$('[data-tab]').forEach(b=>b.addEventListener('click',()=>openTab(b.dataset.tab)));
function openTab(name){
 $$('[data-tab]').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
 $$('.tab').forEach(t=>t.classList.toggle('hidden',t.id!=='tab-'+name));
 clearInterval(poll);
 if(name==='inbox'){loadContacts();poll=setInterval(()=>{if(!document.hidden){loadContacts(true);if(current)loadThread(current,true);}},10000);}
 if(name==='rules')loadRules();
 if(name==='instagram')loadInstagram();
}

// --- inbox ----------------------------------------------------------------------------------------------
async function loadContacts(quiet=false){
 const {data,error}=await sb.from('contacts').select('id,igsid,username,name,last_text,last_message_at,last_customer_at,unread_count').eq('workspace_id',ws).order('last_message_at',{ascending:false}).limit(200);
 if(error){if(!quiet)say($('#msg'),'Impossible de charger les messages.',true);return;}
 contacts=data||[];drawContacts();
 const unread=contacts.reduce((n,c)=>n+c.unread_count,0);$('#unread').textContent=unread;$('#unread').classList.toggle('hidden',!unread);
}
const label=c=>c.username?'@'+c.username:(c.name||'Client '+c.igsid.slice(-4));
function drawContacts(){
 const q=$('#contact-search').value.trim().toLowerCase();
 const list=contacts.filter(c=>!q||(c.username+' '+c.name+' '+c.last_text).toLowerCase().includes(q));
 $('#contact-list').innerHTML=list.map(c=>`<button type="button" class="contact${c.id===current?' active':''}" data-contact="${esc(c.id)}">
  <span class="c-top"><strong>${esc(label(c))}</strong><small>${time(c.last_message_at)}</small></span>
  <span class="c-last" dir="auto">${esc(c.last_text||'…')}</span>${c.unread_count?`<b class="badge">${c.unread_count}</b>`:''}</button>`).join('')||'<p class="empty">Aucun message pour le moment. Les messages Instagram arriveront ici.</p>';
}
$('#contact-search').addEventListener('input',drawContacts);
$('#contact-list').addEventListener('click',e=>{const b=e.target.closest('[data-contact]');if(b)loadThread(b.dataset.contact);});
const who={customer:'',auto:'🤖 Auto',staff:'Équipe',instagram_app:'App Instagram'};
async function loadThread(id,quiet=false){
 current=id;const c=contacts.find(x=>x.id===id);if(!c)return;
 const {data,error}=await sb.from('messages').select('direction,sender,body,kind,created_at').eq('contact_id',id).order('created_at',{ascending:true}).limit(300);
 if(error){if(!quiet)say($('#msg'),'Impossible de charger la conversation.',true);return;}
 const open=c.last_customer_at&&Date.now()-new Date(c.last_customer_at)<DAY;
 const keep=quiet?$('#reply-text')?.value||'':'';
 $('#thread').innerHTML=`<div class="t-head"><button type="button" class="link back" data-back>←</button><strong>${esc(label(c))}</strong>${c.name&&c.username?` <small class="muted">${esc(c.name)}</small>`:''}</div>
  <div class="bubbles">${(data||[]).map(m=>`<div class="bubble ${m.direction}"><div dir="auto">${m.kind==='comment'?'<small>💬 Commentaire</small><br>':''}${m.kind==='attachment'?'📎 Pièce jointe':esc(m.body)||'…'}</div><small>${esc(who[m.sender]||'')} ${time(m.created_at)}</small></div>`).join('')}</div>
  <form class="reply" id="reply-form">${open?`<textarea dir="auto" id="reply-text" rows="2" maxlength="1000" placeholder="Votre réponse…" required></textarea><button type="submit">Envoyer</button>`:'<p class="hint">Plus de 24 h depuis le dernier message du client : Instagram ne permet plus de répondre ici.</p>'}</form>`;
 if(keep&&$('#reply-text'))$('#reply-text').value=keep;
 $('#thread').classList.add('open');const b=$('#thread .bubbles');b.scrollTop=b.scrollHeight;drawContacts();
 if(c.unread_count){await sb.rpc('wasla_mark_read',{p_contact:id});c.unread_count=0;drawContacts();}
}
$('#thread').addEventListener('click',e=>{if(e.target.closest('[data-back]')){$('#thread').classList.remove('open');current=null;drawContacts();}});
$('#thread').addEventListener('submit',async e=>{
 e.preventDefault();const t=$('#reply-text'),btn=e.target.querySelector('button');const text=t.value.trim();if(!text)return;
 btn.disabled=true;
 try{await api('send',{contact_id:current,text});t.value='';await loadThread(current);}
 catch(err){say($('#msg'),errors[err.message]||'Envoi impossible.',true);}
 btn.disabled=false;
});

// --- rules ------------------------------------------------------------------------------------------------
let rules=[];
async function loadRules(){
 const {data,error}=await sb.from('rules').select('*').eq('workspace_id',ws).order('kind').order('position');
 if(error){say($('#msg'),'Impossible de charger les règles.',true);return;}
 rules=data||[];drawRules();
}
function drawRules(){
 const manage=role!=='agent';
 const group=(kind,title)=>{const list=rules.filter(r=>r.kind===kind);return `<h3>${title}</h3>`+(list.map((r,i)=>`<article class="card rule${r.is_active?'':' off'}" data-rule="${esc(r.id)}">
  <div class="r-top"><strong>${esc(r.name||'Sans nom')}</strong><span class="pill">${r.is_active?'Active':'Désactivée'}</span><small class="muted">${r.uses} réponse(s)</small></div>
  <p class="kw">${r.keywords.length?r.keywords.map(k=>`<span class="pill kw">${esc(k)}</span>`).join(' '):'<em>Tous les autres '+(kind==='dm'?'messages':'commentaires')+'</em>'}</p>
  <p class="r-reply" dir="auto">${esc(r.reply)}</p>
  ${manage?`<div class="actions"><button type="button" class="secondary" data-edit>Modifier</button><button type="button" class="secondary" data-toggle>${r.is_active?'Désactiver':'Activer'}</button>
  <button type="button" class="secondary" data-up ${i?'':'disabled'}>↑</button><button type="button" class="secondary" data-down ${i<list.length-1?'':'disabled'}>↓</button><button type="button" class="danger" data-delete>Supprimer</button></div>`:''}
 </article>`).join('')||'<p class="empty">Aucune règle.</p>');};
 $('#rule-list').innerHTML=group('dm','Messages privés')+group('comment','Commentaires');
}
const form=$('#rule-form');
function syncKind(){form.querySelectorAll('[data-only]').forEach(el=>el.classList.toggle('hidden',el.dataset.only!==form.kind.value));}
form.kind.addEventListener('change',syncKind);
function editRule(r){
 form.classList.remove('hidden');form.id.value=r?.id||'';form.name.value=r?.name||'';form.kind.value=r?.kind||'dm';form.keywords.value=(r?.keywords||[]).join(', ');
 form.reply.value=r?.reply||'';form.public_reply.value=r?.public_reply||'';form.is_active.checked=r?r.is_active:true;syncKind();form.scrollIntoView({behavior:'smooth'});
}
$('#rule-new').addEventListener('click',()=>editRule(null));
$('#rule-cancel').addEventListener('click',()=>form.classList.add('hidden'));
form.addEventListener('submit',async e=>{
 e.preventDefault();
 const keywords=[...new Set(form.keywords.value.split(/[,،\n]/).map(k=>k.trim()).filter(Boolean))].slice(0,30);
 const row={workspace_id:ws,name:form.name.value.trim(),kind:form.kind.value,keywords,reply:form.reply.value.trim(),public_reply:form.kind.value==='comment'?form.public_reply.value.trim():'',is_active:form.is_active.checked,updated_at:new Date().toISOString()};
 const q=form.id.value?sb.from('rules').update(row).eq('id',form.id.value).eq('workspace_id',ws):sb.from('rules').insert({...row,position:rules.filter(r=>r.kind===row.kind).length});
 const {error}=await q;if(error){say($('#msg'),'Enregistrement impossible.',true);return;}
 form.classList.add('hidden');say($('#msg'),'Règle enregistrée.');loadRules();
});
$('#rule-list').addEventListener('click',async e=>{
 const card=e.target.closest('[data-rule]');if(!card)return;const r=rules.find(x=>x.id===card.dataset.rule);
 if(e.target.closest('[data-edit]'))return editRule(r);
 let error;
 if(e.target.closest('[data-toggle]'))({error}=await sb.from('rules').update({is_active:!r.is_active}).eq('id',r.id));
 else if(e.target.closest('[data-delete]')){if(!confirm('Supprimer cette règle ?'))return;({error}=await sb.from('rules').delete().eq('id',r.id));}
 else if(e.target.closest('[data-up],[data-down]')){
  const list=rules.filter(x=>x.kind===r.kind),i=list.indexOf(r),j=i+(e.target.closest('[data-up]')?-1:1);if(!list[j])return;
  [list[i],list[j]]=[list[j],list[i]];
  for(const [n,x] of list.entries()){const res=await sb.from('rules').update({position:n}).eq('id',x.id);if(res.error){error=res.error;break;}}
 }else return;
 if(error)say($('#msg'),'Modification impossible.',true);loadRules();
});

// --- Instagram connection + settings --------------------------------------------------------------------
async function loadInstagram(){
 const [{data:acc},{data:set},{data:logs}]=await Promise.all([
  sb.from('instagram_accounts').select('*').eq('workspace_id',ws).maybeSingle(),
  sb.from('workspace_settings').select('*').eq('workspace_id',ws).maybeSingle(),
  sb.from('event_log').select('kind,ok,detail,created_at').eq('workspace_id',ws).order('created_at',{ascending:false}).limit(20)]);
 const manage=role!=='agent',connected=acc?.status==='connected';
 $('#ig-status').innerHTML=`<h3>Compte Instagram</h3>`+(connected?`<p>✅ Connecté : <strong>@${esc(acc.username)}</strong></p>
   <p class="muted">Dernier événement reçu : ${acc.last_event_at?new Date(acc.last_event_at).toLocaleString('fr-MA'):'aucun pour le moment'}. Connexion valable jusqu’au ${acc.token_expires_at?new Date(acc.token_expires_at).toLocaleDateString('fr-MA'):'?'} (renouvelée automatiquement).</p>`
  :acc?.status==='expired'?'<p>⚠️ La connexion a expiré. Reconnectez le compte.</p>':'<p>Aucun compte connecté. Le compte doit être <strong>professionnel</strong> (Business ou Créateur).</p>')
  +(manage?`<div class="actions">${connected?'<button type="button" class="danger" data-ig-disconnect>Déconnecter</button>':'<button type="button" data-ig-connect>Connecter Instagram</button>'}</div>`:'');
 const f=$('#settings-form');
 if(set){f.auto_reply_dm.checked=set.auto_reply_dm;f.auto_reply_comments.checked=set.auto_reply_comments;f.human_pause_minutes.value=set.human_pause_minutes;}
 f.querySelectorAll('input,button').forEach(x=>x.disabled=!manage);
 const names={connect:'Connexion',disconnect:'Déconnexion',auto_reply:'Réponse auto',comment_reply:'Réponse commentaire',public_reply:'Réponse publique',send:'Envoi',webhook:'Réception'};
 $('#event-log').innerHTML=(logs||[]).map(l=>`<div>${l.ok?'✅':'⚠️'} ${esc(names[l.kind]||l.kind)} ${esc(l.detail)} <small class="muted">${new Date(l.created_at).toLocaleString('fr-MA')}</small></div>`).join('')||'<p class="muted">Rien pour le moment.</p>';
}
$('#ig-status').addEventListener('click',async e=>{
 try{
  if(e.target.closest('[data-ig-connect]')){const {url}=await api('connect_url');location.href=url;}
  if(e.target.closest('[data-ig-disconnect]')){if(!confirm('Déconnecter Instagram ? Wasla ne recevra plus les messages.'))return;await api('disconnect');loadInstagram();}
 }catch(err){say($('#msg'),errors[err.message]||'Action impossible.',true);}
});
async function finishConnect(code,state){
 say($('#msg'),'Connexion à Instagram…');
 try{const r=await api('connect',{code,state});say($('#msg'),'Instagram connecté : @'+r.username);openTab('instagram');}
 catch(err){say($('#msg'),errors[err.message]||'Connexion impossible.',true);}
}
$('#settings-form').addEventListener('submit',async e=>{
 e.preventDefault();const f=e.target;
 const {error}=await sb.from('workspace_settings').update({auto_reply_dm:f.auto_reply_dm.checked,auto_reply_comments:f.auto_reply_comments.checked,human_pause_minutes:Math.max(0,Math.min(10080,parseInt(f.human_pause_minutes.value,10)||0)),updated_at:new Date().toISOString()}).eq('workspace_id',ws);
 say($('#msg'),error?'Enregistrement impossible.':'Réglages enregistrés.',!!error);
});

sb.auth.onAuthStateChange(ev=>{if(ev==='SIGNED_OUT')show('auth');});
start();

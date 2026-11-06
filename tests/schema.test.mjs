import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create schema auth;grant usage on schema auth to authenticated,anon,service_role;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
grant execute on function auth.uid() to authenticated,anon,service_role;grant usage on schema public to authenticated,anon,service_role;`);
await db.exec(await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8')); // safe to run twice
const A='a0000000-0000-4000-8000-000000000001',B='b0000000-0000-4000-8000-000000000002',G='c0000000-0000-4000-8000-000000000003';
async function as(uid,fn,role='authenticated'){
 await db.exec(`set test.uid='${uid}';set role ${role}`);
 try{return await fn();}finally{await db.exec("reset role;set test.uid=''");}
}
const one=async(sql,p=[])=>(await db.query(sql,p)).rows[0];
const rejects=async(p,re)=>{let err;try{await p;}catch(e){err=e;}assert.ok(err,'expected an error');if(re)assert.match(err.message,re);};

// workspaces: creator becomes owner with settings; others see nothing
const wa=(await as(A,()=>one('select public.wasla_create_workspace($1) id',['KLINOVA']))).id;
const wb=(await as(B,()=>one('select public.wasla_create_workspace($1) id',['Other shop']))).id;
await rejects(as(A,()=>db.query('select public.wasla_create_workspace($1)',['x'])),/invalid_name/);
await rejects(as('',()=>db.query('select public.wasla_create_workspace($1)',['Anon'])),/not_signed_in/);
assert.equal((await as(A,()=>db.query('select id from public.workspaces'))).rows.length,1);
assert.equal((await as(A,()=>one('select role from public.workspace_members where workspace_id=$1',[wa]))).role,'owner');
assert.equal((await as(A,()=>db.query('select * from public.workspace_settings'))).rows.length,1);
await rejects(as(A,()=>db.query('select * from public.workspaces where id=$1 for update',[wb])));
await rejects(as(A,()=>db.query(`insert into public.workspace_members values($1,$2,'owner')`,[wb,A])),/permission denied/);

// tokens: never readable by signed-in users
await db.query(`insert into public.instagram_accounts(workspace_id,ig_user_id,username) values($1,'111','klinova')`,[wa]);
await db.query(`insert into public.instagram_tokens(workspace_id,access_token) values($1,'SECRET')`,[wa]);
await rejects(as(A,()=>db.query('select access_token from public.instagram_tokens')),/permission denied/);
assert.equal((await as(A,()=>one('select username from public.instagram_accounts'))).username,'klinova');
assert.equal((await as(B,()=>db.query('select * from public.instagram_accounts'))).rows.length,0);

// recording messages (server only)
const rec=(...a)=>db.query('select public.wasla_record_message($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',a).then(r=>r.rows[0].r);
await rejects(as(A,()=>db.query(`select public.wasla_record_message($1,'222','m','in','customer','x','text',now(),null,null)`,[wa])),/permission denied/);
const r1=await rec(wa,'222','m1','in','customer','Salam prix?','text','2026-11-06T10:00:00Z',null,null);
assert.equal(r1.duplicate,false);
assert.equal((await rec(wa,'222','m1','in','customer','Salam prix?','text','2026-11-06T10:00:00Z',null,null)).duplicate,true,'same mid saved once');
const rule=(await db.query(`insert into public.rules(workspace_id,kind,keywords,reply) values($1,'dm','{prix}','Le prix est 89 DH') returning id`,[wa])).rows[0].id;
await rec(wa,'222','m2','out','auto','Le prix est 89 DH','text','2026-11-06T10:00:02Z',rule,null);
let c=await one('select * from public.contacts where id=$1',[r1.contact_id]);
assert.equal(c.unread_count,1);assert.equal(c.last_text,'Le prix est 89 DH');assert.equal(c.last_staff_at,null,'auto replies do not pause automation');
assert.equal((await one('select uses from public.rules where id=$1',[rule])).uses,1);
await rec(wa,'222','m3','out','instagram_app','ok','text','2026-11-06T10:05:00Z',null,null);
assert.ok((await one('select last_staff_at from public.contacts where id=$1',[r1.contact_id])).last_staff_at);
// a comment does not open the 24 h private message window
const rc=await rec(wa,'333','comment:901','in','customer','info','comment','2026-11-06T11:00:00Z',null,null);
assert.equal((await one('select last_customer_at from public.contacts where id=$1',[rc.contact_id])).last_customer_at,null);

// members see their own conversations only; mark read
assert.equal((await as(A,()=>db.query('select * from public.messages'))).rows.length,4);
assert.equal((await as(B,()=>db.query('select * from public.messages'))).rows.length,0);
await as(B,()=>db.query('select public.wasla_mark_read($1)',[r1.contact_id]));
assert.equal((await one('select unread_count from public.contacts where id=$1',[r1.contact_id])).unread_count,1,'other business cannot mark read');
await as(A,()=>db.query('select public.wasla_mark_read($1)',[r1.contact_id]));
assert.equal((await one('select unread_count from public.contacts where id=$1',[r1.contact_id])).unread_count,0);
await rejects(as(A,()=>db.query('update public.contacts set unread_count=5')),/permission denied/);

// rules: managers write, agents read only, other businesses nothing
await db.query(`insert into public.workspace_members values($1,$2,'agent')`,[wa,G]);
await as(A,()=>db.query(`insert into public.rules(workspace_id,kind,keywords,reply) values($1,'comment','{}','Envoyé en privé')`,[wa]));
await rejects(as(G,()=>db.query(`insert into public.rules(workspace_id,kind,reply) values($1,'dm','x')`,[wa])),/row-level security/);
assert.equal((await as(G,()=>db.query('select * from public.rules'))).rows.length,2);
assert.equal((await as(G,()=>db.query(`update public.rules set reply='hack' returning id`))).rows.length,0);
await rejects(as(B,()=>db.query(`insert into public.rules(workspace_id,kind,reply) values($1,'dm','x')`,[wa])),/row-level security/);
assert.equal((await as(B,()=>db.query(`delete from public.rules returning id`))).rows.length,0);
// settings: manager only
assert.equal((await as(G,()=>db.query('update public.workspace_settings set auto_reply_dm=false returning workspace_id'))).rows.length,0);
assert.equal((await as(A,()=>db.query('update public.workspace_settings set auto_reply_dm=false returning workspace_id'))).rows.length,1);
// anon sees nothing
await rejects(as('',()=>db.query('select * from public.contacts'),'anon'),/permission denied/);
console.log('schema tests passed');

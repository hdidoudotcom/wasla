import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {normalize,hasKeyword,pickRule,windowOpen,autoAllowed,verifyMetaSignature,parseWebhook,authorizeUrl,tokenFromExchange,replyText,clipBytes} from '../supabase/functions/instagram/model.js';

// keywords: accents, case, Arabic variants, whole words only
assert.equal(normalize('Prix ?! Éte'),'prix ete');
assert.ok(hasKeyword('Salam, le PRIX svp','prix'));
assert.ok(!hasKeyword('prixe','prix'));
assert.ok(hasKeyword('بشحال هادا؟','بشحال'));
assert.ok(hasKeyword('شحال الثمن','الثمن'));
assert.ok(hasKeyword('ach howa taman dyal','taman dyal'));
assert.ok(hasKeyword('أشنو','اشنو'),'hamza forms are unified');

const rules=[
 {id:'any',kind:'dm',keywords:[],reply:'Fallback',is_active:true,position:9},
 {id:'price',kind:'dm',keywords:['prix','بشحال'],reply:'Price {name}',is_active:true,position:2},
 {id:'off',kind:'dm',keywords:['prix'],reply:'x',is_active:false,position:0},
 {id:'ship',kind:'dm',keywords:['livraison'],reply:'Ship',is_active:true,position:1},
 {id:'c-post',kind:'comment',keywords:[],reply:'post',is_active:true,position:5,media_id:'77'},
 {id:'c-all',kind:'comment',keywords:[],reply:'all',is_active:true,position:0},
 {id:'c-kw',kind:'comment',keywords:['info'],reply:'kw',is_active:true,position:3,media_id:'88'},
];
assert.equal(pickRule('le prix et la livraison',rules,'dm').id,'ship','lowest position wins');
assert.equal(pickRule('بشحال',rules,'dm').id,'price');
assert.equal(pickRule('salam',rules,'dm').id,'any','fallback when nothing matches');
assert.equal(pickRule('hello',rules.filter(r=>r.id!=='any'),'dm'),null);
assert.equal(pickRule('wow',rules,'comment','77').id,'c-post','post-specific catch-all first');
assert.equal(pickRule('wow',rules,'comment','12').id,'c-all');
assert.equal(pickRule('info',rules,'comment','12').id,'c-all','keyword rule of another post is ignored');
assert.equal(pickRule('info',rules,'comment','88').id,'c-kw');

// 24-hour window and human pause
const now=Date.parse('2026-11-06T12:00:00Z');
assert.ok(windowOpen('2026-11-05T12:00:01Z',now));
assert.ok(!windowOpen('2026-11-05T12:00:00Z',now));
assert.ok(!windowOpen(null,now));
assert.ok(autoAllowed(null,120,now));
assert.ok(!autoAllowed('2026-11-06T11:00:00Z',120,now));
assert.ok(autoAllowed('2026-11-06T09:59:00Z',120,now));
assert.ok(autoAllowed('2026-11-06T11:59:00Z',0,now),'pause 0 = never pause');

// webhook signature
const raw='{"object":"instagram"}',secret='s3cret',sig='sha256='+createHmac('sha256',secret).update(raw).digest('hex');
assert.ok(await verifyMetaSignature(raw,sig,secret));
assert.ok(!await verifyMetaSignature(raw+' ',sig,secret));
assert.ok(!await verifyMetaSignature(raw,sig,''));
assert.ok(!await verifyMetaSignature(raw,'sha256=zz',secret));

// webhook parsing
const events=parseWebhook({object:'instagram',entry:[{id:'111',time:1,messaging:[
  {sender:{id:'222'},recipient:{id:'111'},timestamp:1762430400000,message:{mid:'m1',text:'prix?'}},
  {sender:{id:'111'},recipient:{id:'222'},timestamp:1762430401000,message:{mid:'m2',text:'Bonjour',is_echo:true}},
  {sender:{id:'222'},recipient:{id:'111'},timestamp:1762430402000,message:{mid:'m3',attachments:[{type:'image'}]}},
  {sender:{id:'222'},recipient:{id:'111'},message:{mid:'m4',is_deleted:true}},
  {sender:{id:'222'},recipient:{id:'111'},read:{mid:'m1'}},
 ],changes:[
  {field:'comments',value:{id:'901',text:'info',from:{id:'333',username:'sara'},media:{id:'88'}}},
  {field:'comments',value:{id:'902',text:'merci',from:{id:'111',username:'shop'},media:{id:'88'}}},
  {field:'comments',value:{id:'903',text:'reply',from:{id:'333'},media:{id:'88'},parent_id:'901'}},
 ]},{id:'bad',messaging:[{sender:{id:'1'},recipient:{id:'2'},message:{mid:'x',text:'y'}}]}]});
assert.equal(events.length,5);
assert.deepEqual(events.slice(0,3).map(e=>[e.contact,e.echo,e.kind,e.mid]),[['222',false,'text','m1'],['222',true,'text','m2'],['222',false,'attachment','m3']]);
assert.equal(events[0].at,new Date(1762430400000).toISOString());
assert.deepEqual([events[3].comment,events[3].from,events[3].media,events[3].username,events[3].parent],['901','333','88','sara',null]);
assert.equal(events[4].parent,'901');
assert.deepEqual(parseWebhook({object:'page',entry:[]}),[]);
assert.deepEqual(parseWebhook(null),[]);

// OAuth helpers
const u=new URL(authorizeUrl('123','https://wasla.ma/app/','st'));
assert.equal(u.origin+u.pathname,'https://www.instagram.com/oauth/authorize');
assert.equal(u.searchParams.get('redirect_uri'),'https://wasla.ma/app/');
assert.match(u.searchParams.get('scope'),/instagram_business_manage_messages/);
assert.deepEqual(tokenFromExchange({access_token:'t',user_id:42}),{token:'t',user_id:'42'});
assert.deepEqual(tokenFromExchange({data:[{access_token:'t',user_id:'42'}]}),{token:'t',user_id:'42'});
assert.equal(tokenFromExchange({error:'x'}),null);

// reply text
assert.equal(replyText({reply:'Bonjour {name} !'},'Sara'),'Bonjour Sara !');
assert.equal(new TextEncoder().encode(clipBytes('ب'.repeat(800))).length,1000);
assert.equal(clipBytes('ب'.repeat(800)).length,500);
assert.equal(clipBytes('😀'.repeat(300)).length,500,'emoji are not cut in half');
console.log('model tests passed');

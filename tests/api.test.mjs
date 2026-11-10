import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

function fixture(){
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url),'utf8'));
  const store = new Map();
  const env={
    DB:{
      prepare(sql){const st=db.prepare(sql);let args=[];return {bind(...values){args=values;return this},async first(){return st.get(...args)||null},async all(){return {results:st.all(...args)}},async run(){return {meta:st.run(...args)}}};},
      async batch(statements){return Promise.all(statements.map(s=>s.run()));}
    },
    IMAGES:{async put(key,file){store.set(key,file);return {key}},async get(key){const f=store.get(key);return f?{body:f.stream()}:null},async delete(key){store.delete(key);}},
    ASSETS:{fetch(){return new Response('SPA')}},
    ADMIN_PASSWORD:'this-is-a-long-admin-password',SESSION_SECRET:'long-test-session-secret-not-for-production', TURNSTILE_SITE_KEY:''
  };
  const call=async (path,method='GET',body,headers={})=>worker.fetch(new Request('https://example.test'+path,{method,headers:{...(method==='GET'?{}:{Origin:'https://example.test'}),...headers},body}),env);
  return {env,db,store,call};
}
function fd(values){const f=new FormData();for(const [k,v] of Object.entries(values))f.append(k,v);return f;}
function png(){return new File([new Uint8Array([137,80,78,71,13,10,26,10,3,4,5])],'picture.png',{type:'image/png'});}

// Tests use in-memory SQLite + an in-memory R2 adapter; no Cloudflare account required.
test('health, config and unauthorized access',async()=>{
  const {call}=fixture();
  assert.equal((await call('/api/health')).status,200);
  assert.equal((await call('/api/config')).status,200);
  assert.equal((await call('/api/admin/requests')).status,401);
  assert.equal((await call('/api/prompts','POST',fd({}),{Origin:'https://evil.test'})).status,403);
});

test('text-only request is private, track token grants scoped access',async()=>{
  const {call}=fixture();
  const data=await call('/api/requests','POST',fd({nickname:'테스터',title:'초록 후드',details:'흰 배경에 그려주세요',ratio:'1:1',terms:'yes'}));
  assert.equal(data.status,201);
  const created=await data.json();
  assert.match(created.code,/^PI-/);
  assert.equal((await call('/api/track/'+created.token)).status,200);
  assert.equal((await call('/api/track/'+'a'.repeat(64))).status,404);
  assert.equal((await(await call('/api/gallery')).json()).items.length,0);
});

test('admin upload, publishing rules and downloads',async()=>{
  const {call,db}=fixture();
  const created=await(await call('/api/requests','POST',fd({nickname:'작가',title:'공개 작품',details:'귀여운 그림',terms:'yes',consent:'yes'}))).json();
  const id=db.prepare('SELECT id FROM requests WHERE code=?').get(created.code).id;
  const login=await call('/api/admin/login','POST',JSON.stringify({password:'this-is-a-long-admin-password'}),{'content-type':'application/json'});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const auth={Cookie:cookie};
  const cannot=await call('/api/admin/requests/'+id,'PATCH',JSON.stringify({status:'completed',published:true}),{...auth,'content-type':'application/json'});
  assert.equal(cannot.status,400);
  const photos=new FormData();photos.append('images',png());photos.append('images',png());
  const upload=await call('/api/admin/requests/'+id+'/images','POST',photos,auth);
  assert.equal(upload.status,201);
  const saved=await call('/api/admin/requests/'+id,'PATCH',JSON.stringify({status:'completed',published:true}),{...auth,'content-type':'application/json'});
  assert.equal(saved.status,200);
  const gallery=await(await call('/api/gallery')).json();
  assert.equal(gallery.items.length,1);
  const detail=await(await call('/api/gallery/'+id)).json();
  assert.equal(detail.images.length,2);
  assert.equal((await call('/api/gallery-image/'+detail.images[0].id+'?download=1')).status,200);
  assert.equal((await call('/api/track/'+created.token+'/image/'+detail.images[1].id)).status,200);
  const removed=await call('/api/admin/image/'+detail.images[0].id,'DELETE',undefined,auth);
  assert.equal(removed.status,200);
});

test('public prompt posting, copy content retrieval, owner deletion',async()=>{
  const {call}=fixture();
  const res=await call('/api/prompts','POST',fd({nickname:'테스터',title:'크리스마스',body:'마우스로 대충 그려주세요',notes:'픽셀이 보여야 해요',terms:'yes'}));
  assert.equal(res.status,201);
  const created=await res.json();
  const data=await(await call('/api/prompts/'+created.id)).json();
  assert.equal(data.item.body,'마우스로 대충 그려주세요');
  const wrong=await call('/api/prompts/'+created.id,'DELETE',JSON.stringify({token:'0'.repeat(64)}),{'content-type':'application/json'});
  assert.equal(wrong.status,403);
  const secret=created.managePath.split('#')[1];
  assert.equal((await call('/api/prompts/'+created.id,'DELETE',JSON.stringify({token:secret}),{'content-type':'application/json'})).status,200);
  assert.equal((await call('/api/prompts/'+created.id)).status,404);
});

test('storage hard-cap rejects file upload but still permits text requests',async()=>{
  const {call,db}=fixture();
  db.exec('UPDATE quotas SET used_bytes=7999999995 WHERE id=1');
  const files=fd({nickname:'이미지 첨부',title:'테스트',details:'첨부',terms:'yes'});
  files.append('references',png());
  assert.equal((await call('/api/requests','POST',files)).status,507);
  assert.equal((await call('/api/requests','POST',fd({nickname:'텍스트 의뢰',title:'텍스트',details:'참고 파일 없음',terms:'yes'}))).status,201);
});
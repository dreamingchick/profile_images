// Profile Images — Cloudflare Workers API. R2 bucket must remain PRIVATE.
const HARD_LIMIT = 8_000_000_000; // 8GB operational cap; R2 free storage is measured in GB-month.
const WARN_LIMIT = 7_000_000_000;
const REF_LIMIT = 10_000_000;
const RESULT_LIMIT = 20_000_000;
const MAX_TOTAL_REQUEST = 45_000_000;
const STATUSES = ['received', 'reviewing', 'working', 'completed', 'on_hold', 'rejected'];
const CONTENT_TYPES = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp'};
const te = new TextEncoder();

const error = (message, status = 400) => new Response(JSON.stringify({error:message}), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
const unix = () => Math.floor(Date.now()/1000);
const clean = (value, max) => String(value ?? '').trim().slice(0,max+1);
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2,'0')).join('');
async function hash(text) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(text))),b=>b.toString(16).padStart(2,'0')).join(''); }
async function sign(text, key) { const k=await crypto.subtle.importKey('raw',te.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']); return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',k,te.encode(text))),b=>b.toString(16).padStart(2,'0')).join(''); }
function sameHex(a,b) { if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false; let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0; }
async function adminSession(req,env) {
  if(!env.SESSION_SECRET) return false;
  const cookie=req.headers.get('Cookie')||'';
  const match=cookie.match(/(?:^|;\s*)pi_admin=([^;]+)/);
  if(!match)return false;
  const [payload,mac]=match[1].split('.');
  if(!payload||!mac||!sameHex(await sign(payload,env.SESSION_SECRET),mac))return false;
  const expiry=Number(payload);
  return Number.isFinite(expiry)&&expiry>=unix()&&expiry<unix()+86400;
}
function verifyOrigin(req) {
  if(['GET','HEAD','OPTIONS'].includes(req.method))return true;
  const origin=req.headers.get('Origin');
  return !!origin && origin===new URL(req.url).origin;
}
async function rateLimit(req,env,scope,maxPerWindow,seconds) {
  const ip=req.headers.get('CF-Connecting-IP')||'unknown';
  const key=await hash(scope+':'+ip+':'+(env.SESSION_SECRET||'local'));
  const window=Math.floor(unix()/seconds);
  const row=await env.DB.prepare('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count').bind(key,window).first();
  return Number(row?.count||999)>maxPerWindow;
}
async function turnstile(form,req,env) {
  if(!env.TURNSTILE_SECRET) return !env.TURNSTILE_SITE_KEY; // Fail closed when production site key is present but secret has not been provisioned.
  const token=String(form.get('cf-turnstile-response')||form.get('turnstile_token')||'');
  if(!token)return false;
  const body=new FormData();body.append('secret',env.TURNSTILE_SECRET);body.append('response',token);
  const ip=req.headers.get('CF-Connecting-IP');if(ip)body.append('remoteip',ip);
  try { const result=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body});return !!(await result.json()).success; }catch{return false;}
}
function safeName(name){return String(name||'image').replace(/[\r\n"\\/]/g,'_').slice(0,120);}
function validImage(file,maxSize) {
  if(!(file instanceof File)||file.size<1||file.size>maxSize||!(file.type in CONTENT_TYPES))return false;
  return true;
}
async function verifyMagic(file) {
  const b=new Uint8Array(await file.slice(0,16).arrayBuffer());
  if(file.type==='image/png') return b.length>=8&&[137,80,78,71,13,10,26,10].every((n,i)=>b[i]===n);
  if(file.type==='image/jpeg') return b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255;
  if(file.type==='image/webp') return b.length>=12&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP';
  return false;
}
async function reserve(env,bytes,limit=HARD_LIMIT) {
  if(bytes===0)return true;
  const res=await env.DB.prepare('UPDATE quotas SET used_bytes=used_bytes+? WHERE id=1 AND uploads_disabled=0 AND used_bytes+?<=?').bind(bytes,bytes,limit).run();
  return res.meta?.changes===1;
}
async function release(env,bytes) { if(bytes>0)await env.DB.prepare('UPDATE quotas SET used_bytes=MAX(0,used_bytes-?) WHERE id=1').bind(bytes).run(); }
function filesFrom(form,key){return form.getAll(key).filter(x=>x instanceof File && x.name && x.size>0);}
async function storeFiles(env,requestId,kind,files) {
  const uploaded=[];
  try {
    let maxPos=(await env.DB.prepare('SELECT COALESCE(MAX(position),-1) AS p FROM images WHERE request_id=? AND kind=?').bind(requestId,kind).first()).p;
    const haveCover=await env.DB.prepare("SELECT id FROM images WHERE request_id=? AND kind='result' AND is_cover=1").bind(requestId).first();
    for(const file of files) {
      const id=crypto.randomUUID();const key=kind+'/'+requestId+'/'+id+'.'+CONTENT_TYPES[file.type];
      const put=await env.IMAGES.put(key,file,{httpMetadata:{contentType:file.type}});
      if(!put)throw new Error('업로드를 완료하지 못했습니다.');
      uploaded.push({id,key});
      maxPos+=1;
      const inserted = await env.DB.prepare('INSERT INTO images(id,request_id,kind,storage_key,mime,filename,size_bytes,position,is_cover,created_at) SELECT ?,?,?,?,?,?,?,?,?,? FROM active_requests WHERE id=?')
        .bind(id,requestId,kind,key,file.type,safeName(file.name),file.size,maxPos,kind==='result'&&!haveCover&&uploaded.length===1?1:0,unix(),requestId).run();
      if (inserted.meta?.changes !== 1) throw new Error('의뢰가 만료되었거나 삭제되었습니다.');
    }
    return uploaded;
  } catch(e) {
    for(const item of uploaded){try{await env.IMAGES.delete(item.key);}catch{} try{await env.DB.prepare('DELETE FROM images WHERE id=?').bind(item.id).run();}catch{}}
    throw e;
  }
}
function publicImage(img){return {id:img.id,mime:img.mime,filename:img.filename,position:img.position,is_cover:img.is_cover,url:'/api/gallery-image/'+img.id};}
async function serveObject(env,row,download=false) {
  const obj=await env.IMAGES.get(row.storage_key);
  if(!obj)return error('파일을 찾을 수 없습니다.',404);
  const headers=new Headers({'content-type':row.mime,'x-content-type-options':'nosniff','cache-control':'private, no-store'});
  if(download)headers.set('content-disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(safeName(row.filename)));
  return new Response(obj.body,{headers});
}

async function deleteRequest(env, id) {
  const {results} = await env.DB.prepare('SELECT storage_key FROM images WHERE request_id=?').bind(id).all();
  if (results.length) await env.IMAGES.delete(results.map(image => image.storage_key));
  // R2 deletion can be repeated. Keep the DB rows until the files are gone.
  await env.DB.batch([
    env.DB.prepare('UPDATE quotas SET used_bytes=MAX(0,used_bytes-(SELECT COALESCE(SUM(size_bytes),0) FROM images WHERE request_id=?)) WHERE id=1').bind(id),
    env.DB.prepare('DELETE FROM requests WHERE id=?').bind(id)
  ]);
}

async function api(req,env) {
  const u=new URL(req.url),p=u.pathname,m=req.method;
  if(!verifyOrigin(req))return error('허용되지 않은 요청 출처입니다.',403);
  if(p==='/api/config'&&m==='GET')return json({turnstileSiteKey:env.TURNSTILE_SITE_KEY||'',maxReferenceCount:5,maxReferenceBytes:REF_LIMIT});
  if(p==='/api/health'&&m==='GET')return json({ok:true});

  if(p==='/api/requests'&&m==='POST') {
    if(await rateLimit(req,env,'request',4,3600))return error('잠시 후 다시 의뢰해 주세요.',429);
    const form=await req.formData();
    if(!(await turnstile(form,req,env)))return error('보안 확인에 실패했습니다.',403);
    const nickname=clean(form.get('nickname'),30),title=clean(form.get('title'),100),details=clean(form.get('details'),5000);
    const consent=form.get('consent')==='yes'?1:0,ratio=clean(form.get('ratio'),12)||'1:1';
    if(!nickname||nickname.length>30||!title||title.length>100||!details||details.length>5000||!['1:1','4:5','16:9','기타'].includes(ratio))return error('의뢰 내용을 확인해 주세요.');
    if(form.get('terms')!=='yes')return error('필수 이용 안내에 동의해 주세요.');
    const files=filesFrom(form,'references'),total=files.reduce((s,f)=>s+f.size,0);
    if(files.length>5||total>MAX_TOTAL_REQUEST||!(await Promise.all(files.map(async f=>validImage(f,REF_LIMIT)&&await verifyMagic(f)))).every(Boolean))return error('참고 이미지는 JPG, PNG, WEBP 최대 5장·파일당 10MB까지 가능합니다.');
    if(!(await reserve(env,total,WARN_LIMIT)))return error('현재 저장 용량 보호를 위해 참고 이미지 첨부가 중단됐습니다. 텍스트로 의뢰해 주세요.',507);
    const id=crypto.randomUUID(),token=randomToken(),now=unix(),code='PI-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+id.slice(0,6).toUpperCase();
    let created=false;
    try {
      await env.DB.prepare('INSERT INTO requests(id,code,token_hash,nickname,title,details,ratio,consent,status,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id,code,await hash(token),nickname,title,details,ratio,consent,'received',0,now,now).run();
      created=true;await storeFiles(env,id,'reference',files);
      return json({code,token,trackUrl:'/track/'+token},201);
    } catch(e) {
      if(created)await env.DB.prepare('DELETE FROM requests WHERE id=?').bind(id).run().catch(()=>{});
      await release(env,total);throw e;
    }
  }

  const track=p.match(/^\/api\/track\/([a-f0-9]{64})$/);
  if(track&&m==='DELETE') {
    const tokenHash = await hash(track[1]);
    const request = await env.DB.prepare('UPDATE requests SET deletion_pending=1 WHERE token_hash=? RETURNING id').bind(tokenHash).first();
    if (!request) return error('의뢰를 찾을 수 없습니다.',404);
    try {
      await deleteRequest(env, request.id);
      return json({ok:true});
    } catch {
      console.error('Request file cleanup will be retried.');
      return json({pending:true},202);
    }
  }
  if(track&&m==='GET') {
    const r=await env.DB.prepare('SELECT id,code,nickname,title,ratio,status,consent,created_at,updated_at,published FROM active_requests WHERE token_hash=?').bind(await hash(track[1])).first();
    if(!r)return error('의뢰를 찾을 수 없습니다.',404);
    const {results}=await env.DB.prepare("SELECT id,filename,mime,is_cover,position FROM images WHERE request_id=? AND kind='result' ORDER BY position,id").bind(r.id).all();
    return json({request:{code:r.code,nickname:r.nickname,title:r.title,ratio:r.ratio,status:r.status,consent:r.consent,created_at:r.created_at,expires_at:r.created_at+604800,published:r.published},images:results.map(img=>({...img,url:'/api/track/'+track[1]+'/image/'+img.id}))});
  }
  const trackImg=p.match(/^\/api\/track\/([a-f0-9]{64})\/image\/([0-9a-f-]{36})$/);
  if(trackImg&&m==='GET') {
    const row=await env.DB.prepare("SELECT i.storage_key,i.mime,i.filename FROM images i JOIN active_requests r ON i.request_id=r.id WHERE r.token_hash=? AND i.id=? AND i.kind='result'").bind(await hash(trackImg[1]),trackImg[2]).first();
    return row?serveObject(env,row,u.searchParams.has('download')):error('파일을 찾을 수 없습니다.',404);
  }
  if(p==='/api/gallery'&&m==='GET') {
    const q=clean(u.searchParams.get('q'),100),page=Math.max(1,Math.min(1000,Number(u.searchParams.get('page'))||1));
    const {results}=await env.DB.prepare("SELECT r.id,r.title,r.nickname,r.created_at,(SELECT i.id FROM images i WHERE i.request_id=r.id AND i.kind='result' ORDER BY is_cover DESC,position ASC LIMIT 1) AS cover_id,(SELECT COUNT(*) FROM images i WHERE i.request_id=r.id AND i.kind='result') AS image_count FROM active_requests r WHERE r.published=1 AND r.consent=1 AND r.status='completed' AND r.title LIKE ? ORDER BY r.updated_at DESC LIMIT 18 OFFSET ?").bind('%'+q+'%',(page-1)*18).all();
    return json({items:results.map(r=>({...r,cover_url:r.cover_id?'/api/gallery-image/'+r.cover_id:null})),page});
  }
  const gallery=p.match(/^\/api\/gallery\/([0-9a-f-]{36})$/);
  if(gallery&&m==='GET') {
    const r=await env.DB.prepare("SELECT id,title,nickname,created_at,updated_at FROM active_requests WHERE id=? AND published=1 AND consent=1 AND status='completed'").bind(gallery[1]).first();
    if(!r)return error('작품을 찾을 수 없습니다.',404);
    const {results}=await env.DB.prepare("SELECT id,filename,mime,position,is_cover FROM images WHERE request_id=? AND kind='result' ORDER BY position,id").bind(r.id).all();
    return json({item:r,images:results.map(publicImage)});
  }
  const galleryImg=p.match(/^\/api\/gallery-image\/([0-9a-f-]{36})$/);
  if(galleryImg&&m==='GET') {
    const r=await env.DB.prepare("SELECT i.storage_key,i.mime,i.filename FROM images i JOIN active_requests r ON i.request_id=r.id WHERE i.id=? AND i.kind='result' AND r.published=1 AND r.consent=1 AND r.status='completed'").bind(galleryImg[1]).first();
    return r?serveObject(env,r,u.searchParams.has('download')):error('파일을 찾을 수 없습니다.',404);
  }

  if(p==='/api/prompts'&&m==='GET') {
    const q=clean(u.searchParams.get('q'),100),page=Math.max(1,Math.min(1000,Number(u.searchParams.get('page'))||1));
    const {results}=await env.DB.prepare('SELECT id,title,nickname,substr(body,1,170) AS preview,created_at FROM prompts WHERE hidden=0 AND (title LIKE ? OR body LIKE ?) ORDER BY created_at DESC LIMIT 18 OFFSET ?').bind('%'+q+'%','%'+q+'%',(page-1)*18).all();
    return json({items:results,page});
  }
  if(p==='/api/prompts'&&m==='POST') {
    if(await rateLimit(req,env,'prompt',5,3600))return error('게시글 작성 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.',429);
    const form=await req.formData();if(!(await turnstile(form,req,env)))return error('보안 확인에 실패했습니다.',403);
    const nickname=clean(form.get('nickname'),30),title=clean(form.get('title'),100),body=clean(form.get('body'),10000),notes=clean(form.get('notes'),2000);
    if(!nickname||nickname.length>30||!title||title.length>100||!body||body.length>10000||notes.length>2000||form.get('terms')!=='yes')return error('게시글의 필수 내용을 확인해 주세요.');
    const id=crypto.randomUUID(),token=randomToken();
    await env.DB.prepare('INSERT INTO prompts(id,nickname,title,body,notes,token_hash,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,nickname,title,body,notes,await hash(token),unix()).run();
    return json({id,managePath:'/prompts/manage/'+id+'#'+token},201);
  }
  const prompt=p.match(/^\/api\/prompts\/([0-9a-f-]{36})$/);
  if(prompt&&m==='GET'){
    const r=await env.DB.prepare('SELECT id,title,nickname,body,notes,created_at FROM prompts WHERE id=? AND hidden=0').bind(prompt[1]).first();
    return r?json({item:r}):error('게시글을 찾을 수 없습니다.',404);
  }
  if(prompt&&m==='DELETE') {
    const body=await req.json().catch(()=>({}));const token=String(body.token||'');
    if(!/^[a-f0-9]{64}$/.test(token))return error('글 관리 토큰이 필요합니다.',403);
    const r=await env.DB.prepare('DELETE FROM prompts WHERE id=? AND token_hash=?').bind(prompt[1],await hash(token)).run();
    return r.meta?.changes?json({ok:true}):error('삭제 권한이 없거나 게시글이 없습니다.',403);
  }

  if(p==='/api/admin/login'&&m==='POST'){
    if(await rateLimit(req,env,'admin-login',8,900))return error('로그인 시도 횟수를 초과했습니다.',429);
    if(!env.ADMIN_PASSWORD||!env.SESSION_SECRET||env.ADMIN_PASSWORD.length<12)return error('관리자 인증 설정이 필요합니다.',503);
    const body=await req.json().catch(()=>({})),good=sameHex(await hash(String(body.password||'')),await hash(env.ADMIN_PASSWORD));
    if(!good)return error('비밀번호가 올바르지 않습니다.',401);
    const expiry=String(unix()+12*3600),cookie='pi_admin='+expiry+'.'+await sign(expiry,env.SESSION_SECRET)+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200';
    return json({ok:true},200,{'set-cookie':cookie});
  }
  if(p==='/api/admin/me'&&m==='GET')return json({authenticated:await adminSession(req,env)});
  if(p==='/api/admin/logout'&&m==='POST')return json({ok:true},200,{'set-cookie':'pi_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
  if(p.startsWith('/api/admin/')) {
    if(!(await adminSession(req,env)))return error('관리자 로그인이 필요합니다.',401);
    if(p==='/api/admin/requests'&&m==='GET'){
      const status=clean(u.searchParams.get('status'),30),q=clean(u.searchParams.get('q'),100);
      const {results}=await env.DB.prepare('SELECT id,code,title,nickname,status,consent,published,created_at,updated_at FROM active_requests WHERE (?="" OR status=?) AND (title LIKE ? OR code LIKE ?) ORDER BY created_at DESC LIMIT 150').bind(status,status,'%'+q+'%','%'+q+'%').all();
      return json({items:results});
    }
    const detail=p.match(/^\/api\/admin\/requests\/([0-9a-f-]{36})$/);
    if(detail&&m==='GET'){
      const r=await env.DB.prepare('SELECT id,code,title,nickname,details,ratio,consent,status,published,admin_note,created_at,updated_at FROM active_requests WHERE id=?').bind(detail[1]).first();
      if(!r)return error('의뢰를 찾을 수 없습니다.',404);
      const {results}=await env.DB.prepare('SELECT id,kind,mime,filename,size_bytes,position,is_cover FROM images WHERE request_id=? ORDER BY kind,position,id').bind(r.id).all();
      return json({item:r,images:results.map(img=>({...img,url:'/api/admin/image/'+img.id}))});
    }
    if(detail&&m==='PATCH'){
      const data=await req.json().catch(()=>({})),old=await env.DB.prepare('SELECT * FROM active_requests WHERE id=?').bind(detail[1]).first();
      if(!old)return error('의뢰를 찾을 수 없습니다.',404);
      const status=data.status===undefined?old.status:data.status;
      if(!STATUSES.includes(status))return error('잘못된 진행 상태입니다.');
      const published=data.published===undefined?old.published:(data.published?1:0);
      const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE request_id=? AND kind='result'").bind(detail[1]).first();
      if(published&&(!old.consent||status!=='completed'||count.n<1))return error('공개 동의·제작 완료·결과 이미지 등록이 모두 필요합니다.');
      const note=clean(data.admin_note===undefined?old.admin_note:data.admin_note,2000);
      if(note.length>2000)return error('관리자 메모가 너무 깁니다.');
      await env.DB.prepare('UPDATE requests SET status=?,published=?,admin_note=?,updated_at=? WHERE id IN (SELECT id FROM active_requests WHERE id=?)').bind(status,published,note,unix(),detail[1]).run();
      return json({ok:true});
    }
    const resultUpload=p.match(/^\/api\/admin\/requests\/([0-9a-f-]{36})\/images$/);
    if(resultUpload&&m==='POST'){
      const exists=await env.DB.prepare('SELECT id FROM active_requests WHERE id=?').bind(resultUpload[1]).first();if(!exists)return error('의뢰를 찾을 수 없습니다.',404);
      const form=await req.formData(),files=filesFrom(form,'images');
      const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE request_id=? AND kind='result'").bind(resultUpload[1]).first();
      if(!files.length||files.length+count.n>20||!(await Promise.all(files.map(async f=>validImage(f,RESULT_LIMIT)&&await verifyMagic(f)))).every(Boolean))return error('결과 이미지는 최대 20장, 각 20MB의 JPG·PNG·WEBP 파일만 등록할 수 있습니다.');
      const total=files.reduce((s,f)=>s+f.size,0);
      if(total>60_000_000)return error('한 번에 업로드할 수 있는 용량은 60MB입니다.');
      if(!(await reserve(env,total)))return error('R2 운영 한도에 도달해 업로드할 수 없습니다.',507);
      try{await storeFiles(env,resultUpload[1],'result',files);await env.DB.prepare('UPDATE requests SET updated_at=? WHERE id=?').bind(unix(),resultUpload[1]).run();return json({ok:true,count:files.length},201);}
      catch(e){await release(env,total);throw e;}
    }
    const image=p.match(/^\/api\/admin\/image\/([0-9a-f-]{36})$/);
    if(image&&m==='GET'){
      const row=await env.DB.prepare('SELECT i.storage_key,i.mime,i.filename FROM images i JOIN active_requests r ON i.request_id=r.id WHERE i.id=?').bind(image[1]).first();
      return row?serveObject(env,row,u.searchParams.has('download')):error('파일을 찾을 수 없습니다.',404);
    }
    if(image&&m==='DELETE'){
      const row=await env.DB.prepare('SELECT * FROM images WHERE id=?').bind(image[1]).first();if(!row)return error('파일을 찾을 수 없습니다.',404);
      await env.IMAGES.delete(row.storage_key);
      await env.DB.batch([
        env.DB.prepare('UPDATE quotas SET used_bytes=MAX(0,used_bytes-(SELECT COALESCE(SUM(size_bytes),0) FROM images WHERE id=?)) WHERE id=1').bind(row.id),
        env.DB.prepare('DELETE FROM images WHERE id=?').bind(row.id)
      ]);
      if(row.kind==='result'&&row.is_cover)await env.DB.prepare("UPDATE images SET is_cover=1 WHERE id=(SELECT id FROM images WHERE request_id=? AND kind='result' ORDER BY position,id LIMIT 1)").bind(row.request_id).run();
      const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE request_id=? AND kind='result'").bind(row.request_id).first();
      if(count.n===0)await env.DB.prepare('UPDATE requests SET published=0 WHERE id=?').bind(row.request_id).run();
      return json({ok:true});
    }
    if(image&&m==='PATCH'){
      const row=await env.DB.prepare("SELECT id,request_id,kind FROM images WHERE id=? AND kind='result'").bind(image[1]).first();if(!row)return error('결과 이미지를 찾을 수 없습니다.',404);
      const data=await req.json().catch(()=>({}));
      if(data.cover===true){await env.DB.prepare("UPDATE images SET is_cover=CASE WHEN id=? THEN 1 ELSE 0 END WHERE request_id=? AND kind='result'").bind(row.id,row.request_id).run();return json({ok:true});}
      if(data.direction==='up'||data.direction==='down'){
        const records=(await env.DB.prepare("SELECT id FROM images WHERE request_id=? AND kind='result' ORDER BY position,id").bind(row.request_id).all()).results;
        const idx=records.findIndex(x=>x.id===row.id),other=idx+(data.direction==='up'?-1:1);
        if(other>=0&&other<records.length){
          // Replace all positions; deterministic even after earlier deletions.
          [records[idx],records[other]]=[records[other],records[idx]];
          await env.DB.batch(records.map((r,i)=>env.DB.prepare('UPDATE images SET position=? WHERE id=?').bind(i,r.id)));
        }
        return json({ok:true});
      }
      return error('변경 내용이 없습니다.');
    }
    if(p==='/api/admin/prompts'&&m==='GET'){
      const {results}=await env.DB.prepare('SELECT id,title,nickname,substr(body,1,160) AS preview,hidden,created_at FROM prompts ORDER BY created_at DESC LIMIT 150').all();return json({items:results});
    }
    const adminPrompt=p.match(/^\/api\/admin\/prompts\/([0-9a-f-]{36})$/);
    if(adminPrompt&&m==='PATCH'){
      const data=await req.json().catch(()=>({}));if(typeof data.hidden!=='boolean')return error('설정이 올바르지 않습니다.');
      await env.DB.prepare('UPDATE prompts SET hidden=? WHERE id=?').bind(data.hidden?1:0,adminPrompt[1]).run();return json({ok:true});
    }
    if(adminPrompt&&m==='DELETE'){
      await env.DB.prepare('DELETE FROM prompts WHERE id=?').bind(adminPrompt[1]).run();return json({ok:true});
    }
    if(p==='/api/admin/usage'&&m==='GET'){
      const quota=await env.DB.prepare('SELECT used_bytes,uploads_disabled FROM quotas WHERE id=1').first();
      const counts=await env.DB.prepare("SELECT (SELECT COUNT(*) FROM active_requests) AS requests,(SELECT COUNT(*) FROM prompts) AS prompts,(SELECT COUNT(*) FROM images) AS images").first();
      return json({quota:{...quota,hard_limit:HARD_LIMIT,warning_limit:WARN_LIMIT},counts,note:'R2/D1/Workers의 실제 과금 지표는 Cloudflare 대시보드에서 확인하세요. DB 사용량은 이 앱이 관리하는 파일 기준입니다.'});
    }
    if(p==='/api/admin/usage'&&m==='PATCH'){
      const data=await req.json().catch(()=>({}));if(typeof data.uploads_disabled!=='boolean')return error('설정이 올바르지 않습니다.');
      await env.DB.prepare('UPDATE quotas SET uploads_disabled=? WHERE id=1').bind(data.uploads_disabled?1:0).run();return json({ok:true});
    }
  }
  return error('요청한 API를 찾을 수 없습니다.',404);
}

export default {
  async scheduled(_event, env) {
    const {results} = await env.DB.prepare(
      'SELECT id FROM requests WHERE deletion_pending=1 OR created_at <= unixepoch() - 604800 ORDER BY created_at LIMIT 12'
    ).all();
    let failed = false;
    for (const request of results) {
      try { await deleteRequest(env, request.id); }
      catch { failed = true; }
    }
    if (failed) throw new Error('Some expired request files could not be deleted and will be retried.');
  },
  async fetch(req,env) {
    if (env.SITE_CLOSED === 'true') {
      return new Response('프로필 이미지 서비스가 종료되었습니다.', {
        status: 410,
        headers: {'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}
      });
    }
    if(!new URL(req.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {return await api(req,env);}catch(e){console.error('API failure:',e?.message||e);return error('서버 처리 중 오류가 발생했습니다.',500);}
  }
};
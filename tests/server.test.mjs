import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStudioServer, validatePublicOrigin, parseByteRange} from '../server.mjs';
import {MAX_BODY_BYTES} from '../lib/mobile-api.mjs';

const ORIGIN='https://learn.example.test';
async function fixture(t,options={}){
  const base=await mkdtemp(join(tmpdir(),'kaikou-server-')),root=join(base,'studio');
  await mkdir(join(root,'assets/audio'),{recursive:true});
  await writeFile(join(root,'index.html'),'<title>Public studio</title>');
  await writeFile(join(root,'application.js'),'export const publicApp=true;');
  await writeFile(join(root,'assets/audio/1.1.mp3'),'0123456789');
  await writeFile(join(root,'sw.js'),'// public service worker');
  await writeFile(join(root,'.env'),'NOT-A-CREDENTIAL; should not be served');
  const server=createStudioServer({publicOrigin:ORIGIN,staticRoot:root,...options});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const address=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(base,{recursive:true,force:true})});
  return {server,address,root,base};
}
function raw(address,path,{method='GET',headers={},body,open=false,onRequest}={}){
  return new Promise((resolve,reject)=>{
    let received=false;
    const request=httpRequest(new URL(address),{path,method,headers},response=>{
      received=true;const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    request.on('error',error=>{if(!received)reject(error)});
    onRequest?.(request);
    if(open)request.flushHeaders();else request.end(body);
  });
}

test('PUBLIC_ORIGIN is required, HTTPS in production, with no path, credentials or forwarding inference',()=>{
  for(const value of [undefined,'','not-url','http://example.test','https://user:pass@example.test','https://example.test/path','https://example.test/?x=1'])assert.throws(()=>validatePublicOrigin(value));
  assert.equal(validatePublicOrigin('https://example.test/'),'https://example.test');
  assert.equal(validatePublicOrigin('http://127.0.0.1:5193'),'http://127.0.0.1:5193');
});
test('root redirects, studio serves HTML/JS, HEAD has no body, SW revalidates',async t=>{
  const {address}=await fixture(t);
  const root=await raw(address,'/');assert.equal(root.status,302);assert.equal(root.headers.location,'/studio/');
  const studio=await raw(address,'/studio/');assert.equal(studio.status,200);assert.match(studio.body.toString(),/Public studio/);
  const head=await raw(address,'/studio/application.js',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body.length,0);assert.match(head.headers['content-type'],/javascript/);assert.ok(Number(head.headers['content-length'])>0);
  assert.equal((await raw(address,'/studio/sw.js')).headers['cache-control'],'no-cache');
});
for(const[header,start,end]of[['bytes=0-0',0,0],['bytes=2-5',2,5],['bytes=7-',7,9],['bytes=-3',7,9],['bytes=8-99',8,9],['bytes=-99',0,9]]){
  test(`static Range ${header} is byte-accurate`,async t=>{
    const {address}=await fixture(t);const result=await raw(address,'/studio/assets/audio/1.1.mp3',{headers:{Range:header}});
    assert.equal(result.status,206);assert.equal(result.headers['content-range'],`bytes ${start}-${end}/10`);
    assert.equal(Number(result.headers['content-length']),end-start+1);assert.equal(result.body.toString(),'0123456789'.slice(start,end+1));
    assert.equal(result.headers['content-type'],'audio/mpeg');assert.equal(result.headers['accept-ranges'],'bytes');
  });
}
test('Range HEAD has206 headers and no body; malformed/multiple/outside ranges return416',async t=>{
  const{address}=await fixture(t);
  const head=await raw(address,'/studio/assets/audio/1.1.mp3',{method:'HEAD',headers:{Range:'bytes=2-5'}});
  assert.equal(head.status,206);assert.equal(head.headers['content-length'],'4');assert.equal(head.body.length,0);
  for(const range of ['bytes=10-','bytes=2-1','bytes=-0','bytes=-','items=0-1','bytes=0-1,3-4','bytes=9007199254740993-']){
    const result=await raw(address,'/studio/assets/audio/1.1.mp3',{headers:{Range:range}});
    assert.equal(result.status,416,range);assert.equal(result.headers['content-range'],'bytes */10');assert.equal(result.body.length,0);
  }
  assert.equal(parseByteRange('bytes=0-',0),false);
});
test('unverifiable If-Range ignores Range and returns the complete file with200',async t=>{
  const{address}=await fixture(t);
  for(const validator of ['"stale-etag"','Wed, 21 Oct 2015 07:28:00 GMT']){
    const result=await raw(address,'/studio/assets/audio/1.1.mp3',{headers:{Range:'bytes=2-5','If-Range':validator}});
    assert.equal(result.status,200);assert.equal(result.headers['content-range'],undefined);
    assert.equal(result.headers['content-length'],'10');assert.equal(result.body.toString(),'0123456789');
  }
});
test('static routes reject traversal, hidden files, unsupported methods and nonpublic paths',async t=>{
  const{address}=await fixture(t);
  for(const path of ['/studio/../server.mjs','/studio/%2e%2e/server.mjs','/studio/.env','/studio/%2eenv','/studio/assets%2faudio/1.1.mp3','/studio/%5c..%5cserver.mjs','//another.test/studio/','/server.mjs','/lib/mobile-api.mjs','/studio/%XX']){
    const result=await raw(address,path);assert.ok([400,404].includes(result.status),path);assert.ok(!result.body.toString().includes('should not be served'));
  }
  const result=await raw(address,'/studio/index.html',{method:'POST'});assert.equal(result.status,405);assert.equal(result.headers.allow,'GET, HEAD');
});
test('static symlinks cannot escape public studio root',async t=>{
  const{address,root,base}=await fixture(t);const outside=join(base,'outside');await mkdir(outside);await writeFile(join(outside,'hidden.js'),'outside-private-fixture');
  try{await symlink(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir')}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symlink creation unavailable in this execution environment');return}throw error}
  const result=await raw(address,'/studio/linked/hidden.js');assert.equal(result.status,404);assert.ok(!result.body.toString().includes('outside-private-fixture'));
});
test('reverse proxy API trusts configured HTTPS origin and ignores Host/forwarding headers',async t=>{
  const{address}=await fixture(t);
  const headers={Origin:ORIGIN,'Content-Type':'application/json',Host:'internal.local:3000','X-Forwarded-Host':'evil.test','X-Forwarded-Proto':'http',Forwarded:'proto=http;host=evil.test'};
  const result=await raw(address,'/api/config',{method:'POST',headers,body:'{}'});
  assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');assert.equal(JSON.parse(result.body).configured,false);
  const blocked=await raw(address,'/api/config',{method:'POST',headers:{...headers,Origin:'https://evil.test','X-Forwarded-Host':'learn.example.test','X-Forwarded-Proto':'https'},body:'{}'});
  assert.equal(blocked.status,403);assert.equal(JSON.parse(blocked.body).error.code,'ORIGIN_BLOCKED');
  const absent=await raw(address,'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(absent.status,403);
});
test('API responses and static requests with credential headers are never cached',async t=>{
  const{address}=await fixture(t,{apiHandler:async()=>new Response('{}',{headers:{'Cache-Control':'public, max-age=999'}})});
  assert.equal((await raw(address,'/api/config')).headers['cache-control'],'no-store');
  assert.equal((await raw(address,'/studio/index.html',{headers:{'X-Kaikou-Key':'fixture-only'}})).headers['cache-control'],'no-store');
});
test('declared and chunked uploads over12MiB fail before handler',async t=>{
  let called=0;const{address}=await fixture(t,{apiHandler:async()=>{called++;return new Response('{}')}});
  const declared=await raw(address,'/api/voice',{method:'POST',headers:{'Content-Length':String(MAX_BODY_BYTES+1)}});
  assert.equal(declared.status,413);
  const chunked=await raw(address,'/api/voice',{method:'POST',headers:{'Transfer-Encoding':'chunked'},body:Buffer.alloc(MAX_BODY_BYTES+1,32)});
  assert.equal(chunked.status,413);assert.equal(called,0);
});
test('stalled upload receives408 and does not invoke API',async t=>{
  let called=0;const{address}=await fixture(t,{uploadTimeoutMs:30,apiHandler:async()=>{called++;return new Response('{}')}});
  const result=await raw(address,'/api/voice',{method:'POST',headers:{'Content-Length':'1'},open:true});
  assert.equal(result.status,408);assert.equal(called,0);
});
test('client disconnect aborts in-flight Fetch API work after request body was read',async t=>{
  let signal;let started,stopped;const ready=new Promise(resolve=>started=resolve),aborted=new Promise(resolve=>stopped=resolve);
  const{address}=await fixture(t,{apiHandler:async request=>{signal=request.signal;started();await new Promise(resolve=>request.signal.addEventListener('abort',()=>{stopped();resolve()},{once:true}));return new Response('{}')}});
  let client;
  const pending=raw(address,'/api/voice',{method:'POST',body:'{}',onRequest:request=>{client=request}}).catch(()=>{});
  await ready;client.destroy();await Promise.race([aborted,new Promise((_,reject)=>setTimeout(()=>reject(Error('Abort was not propagated')),1000))]);
  assert.equal(signal.aborted,true);await pending;
});
test('API total timeout returns504 and propagates abort',async t=>{
  let aborted=false;const{address}=await fixture(t,{apiTimeoutMs:30,apiHandler:async request=>{await new Promise(resolve=>request.signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true}));return new Response('{}')}});
  const result=await raw(address,'/api/config');assert.equal(result.status,504);assert.equal(aborted,true);assert.equal(result.headers['cache-control'],'no-store');
});

import {createServer} from 'node:http';
import {createReadStream, realpathSync} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {dirname, extname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {handleMobileApi, MAX_BODY_BYTES} from './lib/mobile-api.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.png':'image/png','.jpg':'image/jpeg',
  '.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.txt':'text/plain; charset=utf-8'};
const HOP_HEADERS=new Set(['connection','transfer-encoding','keep-alive','upgrade','trailer','proxy-authenticate','proxy-authorization']);

class HttpError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
export function validatePublicOrigin(value){
  if(!value)throw new Error('PUBLIC_ORIGIN must be explicitly set, for example https://learn.example.com');
  let url;try{url=new URL(value)}catch{throw new Error('PUBLIC_ORIGIN must be an absolute origin')}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
    throw new Error('PUBLIC_ORIGIN must contain only scheme, host and optional port');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))
    throw new Error('Production PUBLIC_ORIGIN must use HTTPS; HTTP is allowed only for loopback tests');
  return url.origin;
}
export function parseByteRange(header,size){
  if(header===undefined)return null;
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||(!match[1]&&!match[2])||size===0)return false;
  let start,end;
  if(!match[1]){
    const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return false;
    start=Math.max(0,size-suffix);end=size-1;
  }else{
    start=Number(match[1]);end=match[2]?Number(match[2]):size-1;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return false;
    end=Math.min(end,size-1);
  }
  return {start,end};
}
function requestPath(target){
  if(!target?.startsWith('/')||target.startsWith('//')||/[\\\x00-\x20\x7f#]/.test(target))throw new HttpError(400,'INVALID_PATH','请求路径无效。');
  const raw=target.split('?')[0];
  if(/%(?:2f|5c|00)/i.test(raw))throw new HttpError(400,'INVALID_PATH','请求路径无效。');
  let path;try{path=decodeURIComponent(raw)}catch{throw new HttpError(400,'INVALID_PATH','请求路径无效。')}
  if(/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(part=>part.startsWith('.')))
    throw new HttpError(404,'NOT_FOUND','没有这个资源。');
  return path;
}
function inside(root,file){const path=relative(root,file);return !path.startsWith('..')&&!isAbsolute(path)}
function sendError(response,status,code,message,method){
  if(response.destroyed||response.writableEnded)return;
  if(response.headersSent){response.destroy();return}
  const body=Buffer.from(JSON.stringify({error:{code,message}}));
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Content-Length':body.length});
  response.end(method==='HEAD'?undefined:body);
}
function readBody(request,signal,timeoutMs){
  const declared=request.headers['content-length'];
  if(declared!==undefined&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))))
    throw new HttpError(400,'INVALID_LENGTH','请求长度无效。');
  if(Number(declared)>MAX_BODY_BYTES)throw new HttpError(413,'UPLOAD_TOO_LARGE','请求超过 12 MB 上限。');
  return new Promise((resolveBody,reject)=>{
    let bytes=0;const chunks=[];
    const cleanup=()=>{clearTimeout(timer);request.off('data',data);request.off('end',end);request.off('error',error);signal.removeEventListener('abort',abort)};
    const fail=value=>{cleanup();request.pause();reject(value)};
    const data=chunk=>{bytes+=chunk.length;if(bytes>MAX_BODY_BYTES){fail(new HttpError(413,'UPLOAD_TOO_LARGE','请求超过 12 MB 上限。'));return}chunks.push(chunk)};
    const end=()=>{cleanup();resolveBody(Buffer.concat(chunks,bytes))};
    const error=()=>fail(new HttpError(400,'UPLOAD_FAILED','上传未完成，请重试。'));
    const abort=()=>fail(new HttpError(499,'CANCELLED','请求已取消。'));
    const timer=setTimeout(()=>fail(new HttpError(408,'UPLOAD_TIMEOUT','上传超时，请缩短录音后重试。')),timeoutMs);
    request.on('data',data);request.once('end',end);request.once('error',error);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
}

/** Host/Forwarded headers never determine the trusted browser origin. */
export function createStudioServer({publicOrigin,staticRoot=resolve(ROOT,'public/studio'),apiHandler=handleMobileApi,
  uploadTimeoutMs=30000,apiTimeoutMs=180000}={}){
  const origin=validatePublicOrigin(publicOrigin),root=realpathSync(staticRoot);
  const server=createServer({maxHeaderSize:16384},async(request,response)=>{
    response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','no-referrer');
    const controller=new AbortController();
    const aborted=()=>controller.abort();
    const disconnected=()=>{if(!response.writableFinished)controller.abort()};
    request.once('aborted',aborted);request.on('error',aborted);response.once('close',disconnected);
    let timer;
    try{
      const path=requestPath(request.url);
      if(path==='/api'||path.startsWith('/api/')){
        response.setHeader('Cache-Control','no-store');
        timer=setTimeout(()=>{controller.abort();sendError(response,504,'API_TIMEOUT','语音请求超时，请重试。',request.method)},apiTimeoutMs);
        let body;
        if(request.method==='POST')body=await readBody(request,controller.signal,uploadTimeoutMs);
        else if(Number(request.headers['content-length']||0)>0||request.headers['transfer-encoding'])
          throw new HttpError(400,'UNEXPECTED_BODY','此请求不能附带正文。');
        const headers=new Headers();
        for(const[name,value]of Object.entries(request.headers)){
          if(value===undefined||HOP_HEADERS.has(name)||name==='host'||name==='forwarded'||name.startsWith('x-forwarded-'))continue;
          headers.set(name,Array.isArray(value)?value.join(', '):value);
        }
        const target=new URL(request.url,origin);
        // API paths were validated above; PUBLIC_ORIGIN alone defines expected Origin.
        const incoming=new Request(target,{method:request.method,headers,signal:controller.signal,
          ...(body===undefined?{}:{body})});
        const result=await apiHandler(incoming);
        if(controller.signal.aborted||response.destroyed)return;
        response.statusCode=result.status;
        for(const[name,value]of result.headers)if(!HOP_HEADERS.has(name))response.setHeader(name,value);
        response.setHeader('Cache-Control','no-store');
        if(request.method==='HEAD'||!result.body){await result.body?.cancel();response.end()}
        else await pipeline(Readable.fromWeb(result.body),response);
        return;
      }
      if(!['GET','HEAD'].includes(request.method)){response.setHeader('Allow','GET, HEAD');throw new HttpError(405,'METHOD_NOT_ALLOWED','静态资源只接受 GET 或 HEAD。')}
      if(path==='/'||path==='/studio'){
        response.writeHead(302,{Location:'/studio/','Cache-Control':'no-store','Content-Length':'0'});response.end();return;
      }
      if(!path.startsWith('/studio/'))throw new HttpError(404,'NOT_FOUND','没有这个资源。');
      const name=path==='/studio/'?'index.html':path.slice('/studio/'.length);
      const candidate=resolve(root,name);
      if(!inside(root,candidate)||!MIME[extname(candidate).toLowerCase()])throw new HttpError(404,'NOT_FOUND','没有这个资源。');
      let file,info;try{file=await realpath(candidate);info=await stat(file)}catch{throw new HttpError(404,'NOT_FOUND','没有这个资源。')}
      if(!inside(root,file)||!info.isFile())throw new HttpError(404,'NOT_FOUND','没有这个资源。');
      // No ETag/Last-Modified validator is published, so If-Range cannot match.
      const range=request.headers['if-range']===undefined?parseByteRange(request.headers.range,info.size):null;
      response.setHeader('Accept-Ranges','bytes');response.setHeader('Content-Type',MIME[extname(candidate).toLowerCase()]);
      const sensitive=Object.keys(request.headers).some(key=>key==='authorization'||key.startsWith('x-kaikou-'));
      response.setHeader('Cache-Control',sensitive?'no-store':name==='sw.js'||name==='index.html'?'no-cache':'public, max-age=3600');
      if(range===false){response.writeHead(416,{'Content-Range':`bytes */${info.size}`,'Content-Length':'0'});response.end();return}
      const start=range?.start??0,end=range?.end??info.size-1;
      response.setHeader('Content-Length',range?end-start+1:info.size);
      if(range)response.setHeader('Content-Range',`bytes ${start}-${end}/${info.size}`);
      response.statusCode=range?206:200;
      if(request.method==='HEAD'||info.size===0){response.end();return}
      await pipeline(createReadStream(file,{start,end}),response);
    }catch(error){
      if(!response.headersSent&&!response.destroyed&&!request.complete)response.setHeader('Connection','close');
      if(!controller.signal.aborted)sendError(response,error instanceof HttpError?error.status:500,
        error instanceof HttpError?error.code:'SERVER_ERROR',error instanceof HttpError?error.message:'服务暂时无法完成请求。',request.method);
    }finally{
      clearTimeout(timer);request.off('aborted',aborted);response.off('close',disconnected);
    }
  });
  server.requestTimeout=35000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000);
    if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be1–65535');
    const server=createStudioServer({publicOrigin:process.env.PUBLIC_ORIGIN});
    server.on('error',()=>{console.error('Unable to listen; check HOST/PORT permissions and availability.');process.exitCode=1});
    server.listen(port,host,()=>console.log(`KaiKou Node service listening on ${host}:${port}; public origin ${validatePublicOrigin(process.env.PUBLIC_ORIGIN)}`));
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
      server.close(()=>process.exit(0));server.closeIdleConnections();
      setTimeout(()=>{server.closeAllConnections();process.exit(0)},5000).unref();
    });
  }catch(error){console.error(error.message);process.exitCode=1}
}

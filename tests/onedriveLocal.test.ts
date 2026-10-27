import {strict as assert} from 'node:assert';
import {FakeFsOnedrive,DEFAULT_ONEDRIVE_CONFIG,setConfigBySuccessfullAuthInplace,sendAuthReq,latestDriveItems} from '../src/fsOnedrive';
describe('OneDrive local authorization fixes',()=>{
 afterEach(()=>{delete (global as any).__obsidianRequest;});
 it('converts expiry seconds to milliseconds and retains the refresh token if not rotated',async()=>{const config={...DEFAULT_ONEDRIVE_CONFIG,refreshToken:'existing'};const now=Date.now();await setConfigBySuccessfullAuthInplace(config,{token_type:'Bearer',access_token:'new-access',expires_in:3600,scope:''},async()=>{});assert.equal(config.refreshToken,'existing');assert.ok(config.accessTokenExpiresAtTime>now+3400000);});
 it('rejects a token request failure instead of leaving an undefined response',async()=>{(global as any).__obsidianRequest=async()=>{throw new Error('test network failure');};let caught=false;await assert.rejects(()=>sendAuthReq('client','https://example.invalid','code','verifier',()=>{caught=true;}),/test network failure/);assert.equal(caught,true);});
 it('falls back from app-folder PUT to POST without replacing an existing directory',async()=>{const config={...DEFAULT_ONEDRIVE_CONFIG,accessToken:'a',refreshToken:'r',accessTokenExpiresAtTime:Date.now()+3600000};const client=new FakeFsOnedrive(config,'vault',async()=>{});const methods:string[]=[];(global as any).__obsidianRequest=async(args:any)=>{methods.push(args.method);if(args.method==='PUT')throw new Error('PUT not supported');assert.equal(JSON.parse(args.body)['@microsoft.graph.conflictBehavior'],'fail');return '{}';};await client._createApprootFolder('test');assert.deepEqual(methods,['PUT','POST']);});
});

describe('OneDrive delta compatibility',()=>{it('uses the last occurrence by ID and removes deletion tombstones',()=>{const result=latestDriveItems([{id:'a',name:'old'},{id:'b',name:'deleted'},{id:'a',name:'latest'},{id:'b',deleted:{state:'deleted'}}]);assert.deepEqual(result.map(x=>x.name),['latest']);});});

describe('OneDrive HTTP failure handling',()=>{
 const realFetch=global.fetch;
 afterEach(()=>{global.fetch=realFetch;delete (global as any).__obsidianRequest;delete (global as any).__obsidianRequestUrl;});
 const client=()=>new FakeFsOnedrive({...DEFAULT_ONEDRIVE_CONFIG,accessToken:'a',refreshToken:'r',accessTokenExpiresAtTime:Date.now()+3600000},'vault',async()=>{});
 it('rejects a non-success direct upload instead of treating it as uploaded',async()=>{
  global.fetch=async()=>new Response('denied',{status:403});
  await assert.rejects(()=>(client() as any)._putArrayBuffer('/file',new ArrayBuffer(1)),/HTTP 403/);
 });
 it('falls back to requestUrl when a download URL returns an HTTP error',async()=>{
  global.fetch=async()=>new Response('expired',{status:403});
  (global as any).__obsidianRequest=async()=>JSON.stringify({'@microsoft.graph.downloadUrl':'https://download.invalid/file'});
  (global as any).__obsidianRequestUrl=async()=>({arrayBuffer:new Uint8Array([1,2,3]).buffer});
  const content=await (client() as any)._readFileFromRoot('/file');
  assert.deepEqual([...new Uint8Array(content)],[1,2,3]);
 });
});

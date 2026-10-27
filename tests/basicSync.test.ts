import {strict as assert} from 'node:assert';
import type {Entity,RemotelySavePluginSettings} from '../src/baseTypes';
import {planSync,enforceProtection,type BasicHistory} from '../src/syncPlan';
import {executePlan,syncer,isMissingError} from '../src/sync';
import {FakeFsEncrypt} from '../src/fsEncrypt';
import {stripPaidConfig} from '../src/settingsCompatibility';
const options=(patch:any={})=>({serviceType:'onedrive',syncDirection:'bidirectional',conflictAction:'keep_newer',protectModifyPercentage:50,syncUnderscoreItems:false,onedrive:{emptyFile:'skip'},...patch} as RemotelySavePluginSettings);
const e=(key='a.md',time=10000,size=5):Entity=>({key,keyRaw:key,mtimeCli:time,mtimeSvr:time,size,sizeRaw:size});
const hist=(entity:Entity):BasicHistory=>({...entity,basicLocal:{...entity},basicRemote:{...entity}});
const op=(local:Entity[],remote:Entity[],previous:BasicHistory[]=[],patch:any={})=>planSync(local,remote,previous,options(patch));
class MemoryFs{
 kind='memory'; files=new Map<string,{entity:Entity;body:ArrayBuffer}>();writes=0;failWrite=false;onRead?:()=>void;
 put(entity:Entity,body=new ArrayBuffer(entity.sizeRaw)){this.files.set(entity.key!,{entity:{...entity},body});return this;}
 async walk(){return [...this.files.values()].map(x=>({...x.entity}));}
 async stat(key:string){const x=this.files.get(key);if(!x)throw Object.assign(new Error('not found'),{code:'ENOENT'});return {...x.entity};}
 async mkdir(key:string){this.put(e(key,0,0));return this.stat(key);}
 async readFile(key:string){const body=this.files.get(key)!.body;this.onRead?.();return body;}
 async writeFile(key:string,body:ArrayBuffer,time:number){if(this.failWrite)throw new Error('write failed');this.writes++;this.put(e(key,time,body.byteLength),body);return this.stat(key);}
 async rm(key:string){this.files.delete(key);}
 allowEmptyFile(){return true;}
 async isPasswordOk(){return {ok:true};}
 async encryptEntity(entity:Entity){return {...entity,sizeEnc:entity.sizeRaw};}
 async closeResources(){}
}
async function execute(plan:any[],l:MemoryFs,r:MemoryFs){const saved:BasicHistory[]=[],removed:string[]=[];await executePlan(plan,l as any,r as any,options(),async h=>{saved.push(h);},async k=>{removed.push(k);},async()=>{});return {saved,removed};}
describe('Basic sync planning without subscription dependencies',()=>{
 it('plans both initial upload and initial download',()=>{assert.equal(op([e()],[])[0].operation,'upload');assert.equal(op([],[e()])[0].operation,'download');});
 it('keeps equal files and imports existing history',()=>assert.equal(op([e()],[e()],[e()])[0].operation,'equal'));
 it('propagates an isolated local edit',()=>assert.equal(op([e('a.md',20000)],[e()],[hist(e())])[0].operation,'upload'));
 it('propagates an isolated remote edit',()=>assert.equal(op([e()],[e('a.md',20000)],[hist(e())])[0].operation,'download'));
 it('propagates tracked deletions, rather than resurrecting files',()=>{assert.equal(op([],[e()],[hist(e())])[0].operation,'delete_remote');assert.equal(op([e()],[],[hist(e())])[0].operation,'delete_local');});
 it('preserves an edit made on the surviving side of a deletion',()=>assert.equal(op([e('a.md',20000)],[],[hist(e())])[0].operation,'upload'));
 it('resolves concurrent edits by newer time or larger size',()=>{assert.equal(op([e('a.md',30000,4)],[e('a.md',20000,8)],[hist(e())])[0].operation,'upload');assert.equal(op([e('a.md',30000,4)],[e('a.md',20000,8)],[hist(e())],{conflictAction:'keep_larger'})[0].operation,'download');});
 it('respects upload-only and download-only modes',()=>{assert.equal(op([],[e()],[],{syncDirection:'incremental_push_only'})[0].operation,'skip');assert.equal(op([e()],[],[],{syncDirection:'incremental_pull_only'})[0].operation,'skip');});
 it('only propagates deletes when the directional option permits them',()=>{assert.equal(op([],[e()],[hist(e())],{syncDirection:'incremental_push_only'})[0].operation,'skip');assert.equal(op([],[e()],[hist(e())],{syncDirection:'incremental_push_and_delete_only'})[0].operation,'delete_remote');});
 it('applies ignores, allowlists, hidden files, and own-config exclusions',()=>{const p=op([e('.hidden'),e('_hidden'),e('a.md'),e('b.txt'),e('.obsidian/plugins/remotely-save/data.json')],[],[],{onlyAllowPaths:['\\.md$'],syncConfigDir:true});assert.deepEqual(p.map(a=>a.key),['a.md']);assert.equal(op([e('a.md')],[],[],{ignorePaths:['a\\.md']}).length,0);});
 it('rejects invalid regex and remote path traversal before mutations',()=>{assert.throws(()=>op([e()],[],[],{ignorePaths:['[']}));assert.throws(()=>op([],[e('../escape.md')]));});
 it('skips oversized files and never recursively deletes a directory',()=>{assert.equal(op([e('a.md',10000,100)],[],[],{skipSizeLargerThan:10})[0].operation,'skip');assert.equal(op([e('folder/',0,0)],[],[hist(e('folder/',0,0))])[0].operation,'mkdir_remote');});
 it('enforces modification protection before execution',()=>{assert.throws(()=>enforceProtection(op([e('a.md',20000)],[e()]),50));assert.doesNotThrow(()=>enforceProtection(op([e()],[]),0));});
 it('removes retired account data without changing OneDrive authorization or settings',()=>{const original=options({pro:{accessToken:'retired'},onedrive:{refreshToken:'preserve',clientID:'same',remoteBaseDir:'same'},autoRunEveryMilliseconds:300000});const result=stripPaidConfig(original);assert.ok(!('pro'in result));assert.deepEqual(result.onedrive,original.onedrive);assert.equal(result.autoRunEveryMilliseconds,300000);assert.ok('pro'in original);});
});
describe('Basic sync execution and failure recovery',()=>{
 it('uploads bytes and writes two-sided history only after success',async()=>{const l=new MemoryFs().put(e()),r=new MemoryFs();const result=await execute(op(await l.walk(),[]),l,r);assert.equal(r.files.get('a.md')!.body.byteLength,5);assert.equal(result.saved.length,1);assert.ok(result.saved[0].basicRemote);});
 it('downloads into nested folders',async()=>{const l=new MemoryFs(),r=new MemoryFs().put(e('dir/sub/a.md'));await execute(op([],await r.walk()),l,r);assert.ok(l.files.has('dir/sub/a.md'));assert.ok(l.files.has('dir/sub/'));});
 it('does not advance history on a failed upload',async()=>{const l=new MemoryFs().put(e()),r=new MemoryFs();r.failWrite=true;const saved:any[]=[];await assert.rejects(()=>executePlan(op(awaitable(l),[]),l as any,r as any,options(),async h=>{saved.push(h);},async()=>{},async()=>{}),/write failed/);assert.equal(saved.length,0);});
 it('detects source edits during read before overwriting remote',async()=>{const l=new MemoryFs().put(e()),r=new MemoryFs();l.onRead=()=>l.put(e('a.md',20000));await assert.rejects(()=>execute(op(awaitable(l),[]),l,r),/新修改/);assert.equal(r.writes,0);});
 it('detects newly created targets after planning',async()=>{const l=new MemoryFs().put(e()),r=new MemoryFs();const plan=op(await l.walk(),[]);r.put(e('a.md',40000));await assert.rejects(()=>execute(plan,l,r),/出现新文件/);assert.equal(r.writes,0);});
 it('does not delete a file if its counterpart reappears',async()=>{const l=new MemoryFs().put(e()),r=new MemoryFs();const plan=op(await l.walk(),[],[hist(e())]);r.put(e('a.md',40000));await assert.rejects(()=>execute(plan,l,r),/出现新文件/);assert.ok(l.files.has('a.md'));});
 it('performs dry runs without file writes, history changes or a success timestamp',async()=>{const l=new MemoryFs().put(e()),r=new MemoryFs(),saved:any[]=[],status:any[]=[],marks:boolean[]=[];const table=(values:any={})=>({async getItems(){return values;},async setItem(k:string,v:any){saved.push([k,v]);},async removeItem(){throw new Error('history should not change');}});const db={prevSyncRecordsTbl:table(),syncPlansTbl:table()}as any;const result=await syncer(l as any,r as any,r as any,undefined,db,'dry','onedrive-default-1','v','.obsidian',options(),'0.6.0',async()=>{},undefined,async n=>{marks.push(n);},async()=>{},async(_,e)=>{throw e;},async()=>{},async(...args)=>{status.push(args);},async()=>{});assert.equal(result.upload,1);assert.equal(l.writes+r.writes,0);assert.equal(saved.length,1);assert.deepEqual(marks,[true,false]);assert.equal(status.length,1);});
});
function awaitable(fs:MemoryFs){return [...fs.files.values()].map(x=>({...x.entity}));}

describe('Bounded transfer concurrency',()=>{it('honors the saved concurrency and waits for every in-flight operation',async()=>{const l=new MemoryFs(),r=new MemoryFs();for(let i=0;i<5;i++)l.put(e(`f${i}.md`));let active=0,peak=0;const write=r.writeFile.bind(r);r.writeFile=async(...args:Parameters<typeof write>)=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));try{return await write(...args);}finally{active--;}};await executePlan(op(await l.walk(),[]),l as any,r as any,options({concurrency:2}),async()=>{},async()=>{},async()=>{});assert.equal(peak,2);assert.equal(active,0);assert.equal(r.writes,5);});});

describe('Encryption adapter compatibility',()=>{it('registers a new unencrypted key before preflight and uploads through the real adapter',async()=>{const l=new MemoryFs().put(e()),raw=new MemoryFs(),remote=new FakeFsEncrypt(raw as any,'','rclone-base64');await remote.walk();const local=[await remote.encryptEntity(e())];const plan=planSync(local,await remote.walk(),[],options());const saved:any[]=[];await executePlan(plan,l as any,remote,options(),async h=>{saved.push(h);},async()=>{},async()=>{});assert.equal(raw.writes,1);assert.equal(saved.length,1);});});

describe('First-party local filesystem errors',()=>{it('recognizes missing-file errors without hiding authentication or network failures',()=>{assert.equal(isMissingError(new Error("fixture.md doesn't exist cannot run stat")),true);assert.equal(isMissingError(new Error('fixture.md does not exist! cannot stat for local')),true);assert.equal(isMissingError(Object.assign(new Error('network'),{status:401})),false);assert.equal(isMissingError(Object.assign(new Error('DNS not found'),{code:'ENOTFOUND'})),false);});});

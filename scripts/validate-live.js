(async()=>{
 const p=app.plugins.plugins['remotely-save'];
 const folder='RemotelySave验证临时';if(app.vault.getAbstractFileByPath(folder))throw new Error('验证目录已存在');
 const root='rs-engine-validation-'+Date.now(),file=folder+'/probe.md',test=Object.create(p);
 test.settings=structuredClone(p.settings);Object.assign(test.settings,{onlyAllowPaths:['^'+folder+'/'],ignorePaths:[],syncDirection:'bidirectional',protectModifyPercentage:100,autoRunEveryMilliseconds:-1,initRunAfterMilliseconds:-1,syncOnSaveAfterMilliseconds:-1});test.settings.onedrive.remoteBaseDir=root;
 Object.assign(test,{isSyncing:false,syncEvent:undefined,syncRibbon:undefined,statusBarElement:document.createElement('span')});
 const table=()=>{const data=new Map();return{getItems:async()=>Object.fromEntries(data),getItem:async k=>data.get(k),setItem:async(k,v)=>{data.set(k,v);return v;},removeItem:async k=>{data.delete(k);},keys:async()=>[...data.keys()]};};
 test.db={prevSyncRecordsTbl:table(),syncPlansTbl:table(),simpleKVForMiscTbl:table()};
 test.saveSettings=async()=>{for(const key of ['accessToken','refreshToken','accessTokenExpiresInSeconds','accessTokenExpiresAtTime'])p.settings.onedrive[key]=test.settings.onedrive[key];await p.saveSettings();};
 const result={isolatedRoot:root},client=test.createRemoteClient();
 try{
  await app.vault.createFolder(folder);await app.vault.create(file,'initial upload fixture');
  await test.syncRun('dry');result.dryUpload=test.lastSyncSummary.upload;result.dryHistory=(await test.db.prevSyncRecordsTbl.keys()).length;
  await test.syncRun('manual');result.upload=test.lastSyncSummary.upload;result.uploadBytes=new TextDecoder().decode(await client.readFile(file))==='initial upload fixture';
  const time=Date.now()+2000;await client.writeFile(file,new TextEncoder().encode('remote edit fixture').buffer,time,time);
  await test.syncRun('manual');result.download=test.lastSyncSummary.download;result.downloadBytes=(await app.vault.adapter.read(file))==='remote edit fixture';
  await app.vault.trash(app.vault.getFileByPath(file),false);await test.syncRun('manual');result.propagatedDelete=test.lastSyncSummary.deleteRemote;result.remoteFileDeleted=!(await client.walk()).some(f=>f.key===file);
 }catch(error){result.error=error.message;result.status=error.status;}
 finally{const local=app.vault.getAbstractFileByPath(folder);if(local)await app.vault.trash(local,false);try{await client._deleteJson('/drive/special/approot:/'+root);result.remoteFixtureCleaned=true;}catch(error){result.cleanupError=error.message;}}
 const fs=require('fs'),path=require('path'),repo=path.resolve(process.env.REMOTELY_SAVE_REPO||'.'),out=path.join(repo,'validation');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'onedrive-live.json'),JSON.stringify(result,null,2));return JSON.stringify(result);
})()

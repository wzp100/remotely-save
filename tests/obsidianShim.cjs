const Module=require('node:module');const orig=Module._load;
const moment=require('moment');
const stub={Platform:{isDesktopApp:true,isMobileApp:false,isAndroidApp:false},requireApiVersion:()=>true,moment,Notice:class{},Plugin:class{},PluginSettingTab:class{},Modal:class{},TFile:class{},TFolder:class{},normalizePath:p=>p.replace(/\\/g,'/'),request:async args=>{if(global.__obsidianRequest)return global.__obsidianRequest(args);throw new Error('Network disabled in tests');},requestUrl:async args=>{if(global.__obsidianRequestUrl)return global.__obsidianRequestUrl(args);throw new Error('Network disabled in tests');}};
Module._load=function(name,parent,isMain){if(name==='obsidian')return stub;if(/\.worker(?:\.ts)?$/.test(name))return class{};return orig.call(this,name,parent,isMain);};
global.window={moment,crypto:require('node:crypto').webcrypto};

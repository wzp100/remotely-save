import 'dotenv/config';
import esbuild from 'esbuild';
import inlineWorkerPlugin from 'esbuild-plugin-inline-worker';
import fs from 'node:fs';
const prod=process.argv.includes('production');
const config={banner:{js:'/* Remotely Save local fork: modified Apache-2.0 sources; integrated console and basic sync. */'},entryPoints:['src/main.ts'],bundle:true,external:['node:*','obsidian','electron','fs','tls','net','http','https','vm'],inject:['./esbuild.injecthelper.mjs'],format:'cjs',target:'es2020',logLevel:'info',sourcemap:!prod,treeShaking:true,minify:prod,outfile:'main.js',metafile:true,define:{global:'window','global.DEFAULT_DROPBOX_APP_KEY':JSON.stringify(process.env.DROPBOX_APP_KEY||''),'global.DEFAULT_ONEDRIVE_CLIENT_ID':JSON.stringify(process.env.ONEDRIVE_CLIENT_ID||''),'global.DEFAULT_ONEDRIVE_AUTHORITY':JSON.stringify(process.env.ONEDRIVE_AUTHORITY||''),'process.env.NODE_DEBUG':'undefined','process.env.DEBUG':'undefined'},plugins:[inlineWorkerPlugin()],loader:{'.svg':'text'}};
if(process.argv.includes('--watch')){const ctx=await esbuild.context(config);await ctx.watch();}
else{const result=await esbuild.build(config);fs.writeFileSync('build-meta.json',JSON.stringify(result.metafile));}

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileKind, validateUpload, safeMediaURL } from '../web/studio.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('drop accepts image, audio, video and other files without misclassifying them',()=>{
 assert.equal(fileKind('image/png'),'image'); assert.equal(fileKind('audio/wav'),'audio');
 assert.equal(fileKind('video/mp4'),'video'); assert.equal(fileKind('application/pdf'),'file');
 assert.equal(fileKind(''),'file');
});
test('rejects empty and oversized files before sending them to storage',()=>{
 assert.throws(()=>validateUpload({name:'empty.png',size:0,type:'image/png'}),/empty/);
 assert.throws(()=>validateUpload({name:'large.mp4',size:26*1024*1024,type:'video/mp4'}),/25 MB/);
 assert.equal(validateUpload({name:'voice.wav',size:100,type:'audio/wav'}),'audio');
});
test('does not render script or data URLs from shared event metadata',()=>{
 assert.equal(safeMediaURL('javascript:alert(1)'),null);assert.equal(safeMediaURL('data:text/html,test'),null);
 assert.equal(safeMediaURL(undefined),null);assert.equal(safeMediaURL('https://example.com/a.mp4'),'https://example.com/a.mp4');
});
const source=new URL('../',import.meta.url);
const original=execFileSync('git',['show','b7456eb0a2d03e3d7145be7dbd1524b9042a30b1:web/index.html'],{cwd:source,encoding:'utf8'});
const revised=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const ids=html=>[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
test('every pre-existing UI hook remains exactly once',()=>{
 const revisedIDs=ids(revised);for(const id of ids(original))assert.equal(revisedIDs.filter(value=>value===id).length,1,id);
 assert.equal(new Set(revisedIDs).size,revisedIDs.length,'duplicate IDs');
});
test('core application behavior is preserved around additive presentation hooks',()=>{
 const before=execFileSync('git',['show','b7456eb0a2d03e3d7145be7dbd1524b9042a30b1:web/app.js'],{cwd:source,encoding:'utf8'});
 const after=readFileSync(new URL('../web/app.js',import.meta.url),'utf8')
 .replace('import { initStudio, renderAttachment } from "./studio.mjs";\n','')
 .replace('  renderAttachment(e, li);\n','')
 .replace('\n// Studio presentation uses the existing room, composer, storage and realtime paths.\ninitStudio({ room, getAuthor: () => me, postNote, shareImage, sb, toast, stopMic });\n','');
 assert.equal(after,before);
});

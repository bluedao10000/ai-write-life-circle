import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
// ZIP order and filenames intentionally disagree with spine/narrative order.
export async function importSyntheticEpub(f,count){
 const file=join(f.directory,'synthetic-bulk.epub');
 const result=spawnSync('python3',['-c',`
import zipfile,sys
n=int(sys.argv[2]);parts=[(i,f'{n-i+1:06d}.xhtml') for i in range(1,n+1)]
with zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:
 z.writestr('mimetype','application/epub+zip',compress_type=zipfile.ZIP_STORED)
 z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>')
 manifest='<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'+''.join(f'<item id="c{i}" href="{name}" media-type="application/xhtml+xml"/>' for i,name in parts)
 spine=''.join(f'<itemref idref="c{i}"/>' for i,name in parts)
 z.writestr('OEBPS/content.opf',f'<package version="3.0"><metadata><title>合成全书回填</title><creator>Fixture</creator></metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>')
 toc=''.join(f'<li><a href="{name}">第{i}章</a></li>' for i,name in parts)
 z.writestr('OEBPS/nav.xhtml',f'<html><body><nav type="toc"><ol>{toc}</ol></nav></body></html>')
 for i,name in reversed(parts):z.writestr('OEBPS/'+name,f'<html><body><h1>第{i}章</h1><p>合成原文第 {i} 章。</p></body></html>')
`,file,String(count)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const form=new FormData();form.set('file',new Blob([await readFile(file)],{type:'application/epub+zip'}),'synthetic-bulk.epub');
 const preview=await f.call('/v1/studio/imports',{method:'POST',status:201,body:form});assert.equal(preview.chapters.length,count);
 const book=await f.call('/v1/studio/imports/'+preview.importId,{method:'POST',status:201,body:{fingerprint:preview.fingerprint,title:preview.title,volumes:preview.volumes,chapters:preview.chapters.map(c=>({chapterId:c.chapterId,title:c.title,...(c.volumeId?{volumeId:c.volumeId}:{})}))}});
 assert.equal(book.chapters.length,count);assert.equal(f.calls,0,'import itself cannot call any model');return book;
}

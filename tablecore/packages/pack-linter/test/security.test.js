import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

test('default pack linter refuses JavaScript module inputs before execution',()=>{
 // Previously hardcoded to an absolute /mnt/data/b20audit path specific to
 // one sandbox environment, which made the test fail with ENOENT anywhere
 // else (including a clean checkout of this repo). Using a fresh temp dir
 // makes the test self-contained and portable, with no behavior change to
 // what's actually being verified.
 const dir=mkdtempSync(join(tmpdir(),'tablecore-pack-lint-security-'));
 const marker=resolve(dir,'PWNED_STATIC'); try{readFileSync(marker); }catch{}
 const evil=resolve(dir,'evil-static.mjs');
 writeFileSync(evil, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'x'); export default {};\n`);
 const r=spawnSync(process.execPath,['tools/tablecore-pack-lint.js',evil],{cwd:resolve('.'),encoding:'utf8'});
 assert.notEqual(r.status,0);
 try{readFileSync(marker); assert.fail('unsafe module was executed');}catch(e){if(e.code!=='ENOENT')throw e;}
 rmSync(dir,{force:true,recursive:true});
});

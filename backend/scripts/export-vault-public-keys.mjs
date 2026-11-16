// Reads already provisioned, non-exportable Vault keys. Exports public SPKI only.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createPublicKey} from 'node:crypto';
import {resolve,join} from 'node:path';
import {privateFile,vaultLoader} from '../dist/custody.js';
import {sha} from '../dist/bid-protocol.js';
const source=process.argv[2];if(!source)throw new Error('Supply a JSON array of exactly three {name,version} bindings in initial, technical, financial order.');
const bindings=JSON.parse(await readFile(source,'utf8'));
if(!Array.isArray(bindings)||bindings.length!==3||bindings.some(k=>!/^[-a-zA-Z0-9_]+$/.test(k.name)||!Number.isSafeInteger(k.version)||k.version<1))throw new Error('Invalid public key binding file.');
const address=new URL(process.env.VAULT_ADDR??''),mount=process.env.VAULT_TRANSIT_MOUNT??'transit';
if(address.protocol!=='https:'||address.origin+'/'!==address.href||!/^[-a-zA-Z0-9_]+$/.test(mount))throw new Error('Configure an HTTPS Vault origin and mount.');
const root=resolve(process.env.OPENING_KEYS_DIR??'opening-keys');await mkdir(root,{recursive:true,mode:0o700});
const manifest=[];
for(const [part,binding]of bindings.entries()){
 const token=await privateFile(process.env.VAULT_TOKEN_FILE,4096);
 let key;try{const res=await fetch(new URL(`/v1/${mount}/keys/${binding.name}`,address),{headers:{'X-Vault-Token':token.toString('utf8').trim()},redirect:'error',signal:AbortSignal.timeout(10000)});if(!res.ok)throw new Error('Vault key read failed.');key=(await res.json()).data;}finally{token.fill(0);}
 if(key.type!=='rsa-3072'||key.exportable!==false||key.allow_plaintext_backup!==false)throw new Error('Vault key must be non-exportable RSA 3072 without plaintext backup.');
 const der=createPublicKey(key.keys[String(binding.version)].public_key).export({type:'spki',format:'der'}),fingerprint=await sha(der);
 const entry={...binding,fingerprint};
 // Use the same metadata/fingerprint gate as the live custody adapter.
 await vaultLoader({address:address.origin,mount,tokenFile:process.env.VAULT_TOKEN_FILE,keys:[entry]})(part,fingerprint);
 const target=join(root,fingerprint+'.json'),publicValue=JSON.stringify({fingerprint,spki:der.toString('base64')});
 try{await writeFile(target,publicValue,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||await readFile(target,'utf8')!==publicValue)throw e;}
 manifest.push(entry);console.log(`${['initial','technical','financial'][part]} public fingerprint: ${fingerprint}`);
}
const output=resolve(process.env.VAULT_KEY_MANIFEST??'vault-key-manifest.json');await writeFile(output,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(`Public-only pinned key manifest saved to ${output}. Publish new tenders using these fingerprints.`);

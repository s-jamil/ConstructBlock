import {generateKeyPairSync,createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
// Local capstone helper. Private material is outside the API public/storage roots.
const keyDirectory=resolve('opening-keys'), custodyDirectory=resolve('..','.constructblock-custody',randomUUID());
await mkdir(keyDirectory,{recursive:true,mode:0o700});await mkdir(custodyDirectory,{recursive:true,mode:0o700});
for (const part of ['initial','technical','financial']) {
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:3072});
 const der=publicKey.export({type:'spki',format:'der'});
 const fingerprint='0x'+createHash('sha256').update(der).digest('hex');
 await writeFile(join(keyDirectory,fingerprint+'.json'),JSON.stringify({fingerprint,spki:der.toString('base64')}),{flag:'wx',mode:0o600});
 await writeFile(join(custodyDirectory,part+'.pem'),privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
 console.log(`${part}: ${fingerprint}`);
}
console.log(`Development private keys retained in ${custodyDirectory}. Do not share or commit them. This is not production custody separation.`);

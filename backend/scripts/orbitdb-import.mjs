import {resolve} from 'node:path';
import {FilesystemCiphertextStore} from '../dist/ciphertext-store.js';
import {OrbitDbClient,defaultOrbitSocket} from '../dist/orbitdb-client.js';
import {bytes,sha,canonicalBundle,validateBundle} from '../dist/bid-protocol.js';
try{
 const source=new FilesystemCiphertextStore(resolve(process.env.STORAGE_DIR??'storage'));
 const target=new OrbitDbClient(process.env.ORBITDB_SOCKET??defaultOrbitSocket());
 await target.info();let count=0;
 for(const id of await source.ids()){
  const raw=await source.get(id),bundle=await validateBundle(JSON.parse(raw)),serialized=canonicalBundle(bundle);
  if(await sha(bytes(serialized))!==id)throw new Error('Source package integrity verification failed. Import stopped; source files were preserved.');
  await target.put(id,serialized);if(await target.get(id)!==serialized)throw new Error('Imported package verification failed.');count++;
 }
 console.log(`Verified and imported ${count} encrypted packages. Source files were preserved; no blockchain or key change was made.`);
}catch(e){console.error(e.message??'Encrypted database import failed.');process.exitCode=1;}

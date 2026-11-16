// Invoked by the opt-in live test in a separate OS process. Outputs hashes only.
import {readFile} from 'node:fs/promises';
import {openOrbitRuntime} from '../dist/orbitdb-runtime.js';
import {OrbitDbCiphertextStore} from '../dist/orbitdb-store.js';
import {sha,bytes} from '../dist/bid-protocol.js';
const [action,directory,file,id]=process.argv.slice(2),runtime=await openOrbitRuntime(directory);
try{
 const store=new OrbitDbCiphertextStore(runtime.database);
 if(action==='write')await store.put(id,await readFile(file,'utf8'));
 else if(action!=='read')throw new Error('Unknown live test action.');
 const value=await store.get(id);if(value===undefined)throw new Error('Stored encrypted package missing.');
 console.log(JSON.stringify({address:runtime.address,contentId:await sha(bytes(value)),count:(await store.ids()).length}));
}finally{await runtime.close();}

// One process owns OrbitDB's LevelDB files; API and document service use its
// private local socket and never open the same database directory concurrently.
import {resolve} from 'node:path';
import {openOrbitRuntime} from '../dist/orbitdb-runtime.js';
import {OrbitDbCiphertextStore} from '../dist/orbitdb-store.js';
import {OrbitDbClient,defaultOrbitSocket} from '../dist/orbitdb-client.js';
import {serveOrbitStorage} from '../dist/orbitdb-server.js';
const action=process.argv[2]??'start';
try{
 const socket=process.env.ORBITDB_SOCKET??defaultOrbitSocket();
 if(action==='status')console.log(JSON.stringify(await new OrbitDbClient(socket,true).info(),null,2));
 else if(action==='start'){
  const directory=resolve(process.env.ORBITDB_DIR??'orbitdb-data');
  const runtime=await openOrbitRuntime(directory);let owner;
  try{owner=await serveOrbitStorage(new OrbitDbCiphertextStore(runtime.database),socket,{provider:'orbitdb',schema:'constructBlock-orbitdb-v1',address:runtime.address,sync:false});}catch(e){await runtime.close();throw e;}
  console.log('OrbitDB encrypted storage ready. Socket:',socket);
  console.log('Database:',runtime.address,'; peer synchronization disabled.');
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;try{await owner.close();await runtime.close();}catch{console.error('OrbitDB shutdown failed; inspect database locks before restarting.');process.exitCode=1;}};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  owner.server.on('error',()=>{console.error('OrbitDB socket failed.');void stop();});
 }else throw new Error('Use start or status.');
}catch(e){console.error(e.message??'OrbitDB startup failed.');process.exitCode=1;}

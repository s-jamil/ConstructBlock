import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createOrbitDB} from '@orbitdb/core';
import {createHelia} from 'helia';
import {LevelBlockstore} from 'blockstore-level';
import {gossipsub} from '@libp2p/gossipsub';
import {identify} from '@libp2p/identify';

export async function openDatabase(directory){
 await mkdir(directory,{recursive:true,mode:0o700});
 const meta=await lstat(directory);
 if(!meta.isDirectory()||meta.isSymbolicLink()||(meta.mode&0o077)!==0)throw new Error('OrbitDB data directory must be a private regular directory (mode 0700).');
 const blockstore=new LevelBlockstore(join(directory,'blocks'));
 let helia,orbit;
 try{
  // No public discovery, routers, brokers, listening addresses or database sync.
  // Persistent blockstore + OrbitDB keystore/heads survive process restarts.
  helia=await createHelia({blockstore,routers:[],blockBrokers:[],libp2p:{addresses:{listen:[]},peerDiscovery:[],services:{identify:identify(),pubsub:gossipsub({allowPublishToZeroTopicPeers:true})}}});
  orbit=await createOrbitDB({ipfs:helia,id:'constructBlock-encrypted-storage',directory:join(directory,'orbitdb')});
  const file=join(directory,'database-address.json');let address;
  try{const saved=JSON.parse(await readFile(file,'utf8'));if(saved.schema!=='constructBlock-orbitdb-address-v1'||typeof saved.address!=='string'||!saved.address.startsWith('/orbitdb/'))throw new Error('Invalid database address configuration.');address=saved.address;}catch(e){if(e.code!=='ENOENT')throw e;}
  const database=await orbit.open(address??'constructBlock-encrypted-bids-v1',{type:'documents',sync:false});
  if(database.type!=='documents'||!database.access.write?.includes(orbit.identity.id)||database.access.write.includes('*'))throw new Error('OrbitDB must use its restricted owner write identity.');
  if(!address)await writeFile(file,JSON.stringify({schema:'constructBlock-orbitdb-address-v1',address:database.address},null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
  return {database,address:database.address,close:async()=>{try{await orbit.stop();}finally{await helia.stop();}}};
 }catch(error){await orbit?.stop().catch(()=>{});await helia?.stop().catch(()=>{});throw error;}
}

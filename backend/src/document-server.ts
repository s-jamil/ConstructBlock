import {configuredCiphertextStore} from './orbitdb-client.ts';
// Start independently; do not add custody credentials to the public API environment.
import {resolve} from 'node:path';
import {BlockchainService} from './blockchain.ts';
import {loadConfig} from './config.ts';
import {EncryptedStorage} from './storage.ts';
import {configuredKeyLoader} from './custody.ts';
import {DocumentService} from './document-service.ts';
import {createDocumentApp} from './document-app.ts';
try{
 const config=loadConfig(),port=Number(process.env.DOCUMENT_PORT??'3002');
 if(!Number.isInteger(port)||port<1||port>65535||port===config.port)throw new Error('Set a separate valid DOCUMENT_PORT.');
 const loadKey=await configuredKeyLoader();
 const origin=process.env.DOCUMENT_ORIGIN??(process.env.NODE_ENV==='production'?'':'http://127.0.0.1:5173');
 if(process.env.NODE_ENV==='production'&&!origin.startsWith('https://'))throw new Error('Production document origin requires HTTPS.');
 const chain=new BlockchainService(config),storage=new EncryptedStorage(chain,process.env.STORAGE_DIR,process.env.OPENING_KEYS_DIR,undefined,configuredCiphertextStore(process.env,true));
 const service=new DocumentService(chain,storage,loadKey,resolve(process.env.DOCUMENT_AUDIT_DIR??'document-audit'));
 const server=createDocumentApp(service,origin).listen(port,'127.0.0.1',()=>console.log(`Restricted document service listening on loopback port ${port}.`));
 server.on('error',()=>{console.error('Cannot start restricted document listener.');chain.provider.destroy();process.exitCode=1;});
 const stop=()=>server.close(()=>chain.provider.destroy());process.once('SIGTERM',stop);process.once('SIGINT',stop);
}catch{console.error('Document service configuration failed. Check deployment, origin and explicit custody configuration.');process.exitCode=1;}

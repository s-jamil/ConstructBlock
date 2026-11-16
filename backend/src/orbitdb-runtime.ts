import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {OrbitDocuments} from './orbitdb-store.ts';
export interface OrbitRuntime {database:OrbitDocuments;address:string;close():Promise<void>}
export async function openOrbitRuntime(directory:string):Promise<OrbitRuntime>{
 const moduleUrl=pathToFileURL(resolve(import.meta.dirname,'../orbitdb-runtime/index.mjs')).href;
 let runtime;
 try{runtime=await import(moduleUrl);}catch(e){
  if((e as NodeJS.ErrnoException).code==='ERR_MODULE_NOT_FOUND')throw new Error('OrbitDB dependencies are missing. Run npm run orbitdb:install from the project root, then retry.');throw e;
 }
 return runtime.openDatabase(directory);
}

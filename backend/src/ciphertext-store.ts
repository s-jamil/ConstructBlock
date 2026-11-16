import {mkdir,readFile,open,link,unlink,readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError} from './errors.ts';
import {MAX_BUNDLE_BYTES} from './bid-protocol.ts';
export interface CiphertextStore {
 get(contentId:string):Promise<string|undefined>;
 put(contentId:string,serialized:string):Promise<void>;
 ids():Promise<string[]>;
}
export function validContentId(value:unknown):value is string{return typeof value==='string'&&/^0x[0-9a-f]{64}$/.test(value);}
export class FilesystemCiphertextStore implements CiphertextStore {
 readonly root:string;readonly quota:number;
 constructor(root:string,quota=256*1024*1024){this.root=root;this.quota=quota;}
 async get(contentId:string){
  if(!validContentId(contentId))throw new ApiError(400,'INVALID_CONTENT_ID','Invalid encrypted content identifier.');
  try{const file=join(this.root,contentId+'.json');if((await stat(file)).size>MAX_BUNDLE_BYTES)throw new ApiError(409,'STORAGE_CORRUPT','Encrypted object exceeds the package limit.');return await readFile(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
 }
 async ids(){try{return (await readdir(this.root)).filter(n=>/^0x[0-9a-f]{64}\.json$/.test(n)).map(n=>n.slice(0,-5));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
 async put(contentId:string,serialized:string){
  if(!validContentId(contentId))throw new ApiError(400,'INVALID_CONTENT_ID','Invalid encrypted content identifier.');
  await mkdir(this.root,{recursive:true,mode:0o700});
  const target=join(this.root,contentId+'.json');
  try {const existing=await readFile(target,'utf8');if(existing!==serialized)throw new Error('Storage corruption');return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const names=(await readdir(this.root)).filter(n=>/^0x[0-9a-f]{64}\.json$/.test(n));
  const sizes=await Promise.all(names.map(async n=>(await stat(join(this.root,n))).size));
  if(names.length>=1000 || sizes.reduce((a,b)=>a+b,0)+Buffer.byteLength(serialized)>this.quota)
   throw new ApiError(507,'STORAGE_FULL','Development storage quota reached. Contact the administrator.');
  const temp=join(this.root,'.upload-'+randomUUID());
  try {
   const f=await open(temp,'wx',0o600);try {await f.writeFile(serialized,'utf8');await f.sync();}finally {await f.close();}
   // Publish complete immutable content without overwriting an existing object.
   await link(temp,target);
  } finally {await unlink(temp).catch(()=>{});}
 }
}

// Uses an external JSON-RPC signing gateway; no wallet private key is loaded here.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JsonRpcProvider,FetchRequest,getAddress} from 'ethers';
import {loadConfig} from '../dist/config.js';
import {BlockchainService} from '../dist/blockchain.js';
import {configuredKeyLoader} from '../dist/custody.js';
import {validateOpeningRequest} from '../dist/opening-protocol.js';
import {processOpening} from '../dist/opening-worker.js';
const args={};const flags=process.argv.slice(2);for(let i=0;i<flags.length;i+=2){if(!['--tender','--bidder','--version','--part','--actor'].includes(flags[i])||!flags[i+1]||args[flags[i].slice(2)])throw new Error('Use --tender --bidder --version --part --actor exactly once each.');args[flags[i].slice(2)]=flags[i+1];}
const config=loadConfig(),chain=new BlockchainService(config);let signing;
function endpoint(value){const u=new URL(value);if(u.username||u.password||u.hash||u.search||u.pathname!=='/'||(u.protocol!=='https:'&&!(config.chainId===31337n&&u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname))))throw new Error('Use HTTPS origins; loopback HTTP is restricted to local chain 31337.');return u;}
try{
 const signerUrl=endpoint(process.env.OPENING_SIGNER_RPC_URL),storageUrl=endpoint(process.env.STORAGE_API_URL);
 const rpc=new FetchRequest(signerUrl.href);rpc.timeout=10000;signing=new JsonRpcProvider(rpc,undefined,{batchMaxCount:1});
 const signer=await signing.getSigner(getAddress(args.actor)),status=await chain.status(),part=['initial','technical','financial'].indexOf(args.part);
 const request=validateOpeningRequest({context:{chainId:status.chainId,workflow:config.workflowAddress.toLowerCase(),tenderId:args.tender,bidder:getAddress(args.bidder).toLowerCase(),version:args.version},part,service:getAddress(args.actor).toLowerCase(),timestamp:Date.now().toString()});
 const loadKey=await configuredKeyLoader(),root=resolve('reports','openings');await mkdir(root,{recursive:true,mode:0o700});const file=join(root,Date.now()+'-'+randomUUID()+'.json');
 const report=await processOpening({chain,signer,request,loadKey,retrieve:async(body,signature)=>{
  const response=await fetch(new URL('/api/storage/openings/retrieve',storageUrl),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Opening-Signature':signature},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error('Encrypted opening retrieval was denied or unavailable.');return response.json();
 },onSubmitted:async hash=>{await writeFile(file,JSON.stringify({status:'pending',request,transactionHash:hash},null,2),{mode:0o600,flush:true});console.log('Submitted result transaction:',hash);}});
 await writeFile(file,JSON.stringify(report,null,2),{mode:0o600,flush:true});console.log(JSON.stringify({status:report.status,verified:report.verified,code:report.code,transactionHash:report.transactionHash,report:file}));
}catch(e){console.error(e?.code??'OPENING_FAILED','Opening verification stopped. Inspect any printed transaction hash and operator configuration before retrying.');process.exitCode=1;}
finally{chain.provider.destroy();signing?.destroy();}

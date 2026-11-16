import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Contract,getAddress} from 'ethers';
import {loadConfig} from '../dist/config.js';
import {BlockchainService} from '../dist/blockchain.js';
import {validateOpeningRequest} from '../dist/opening-protocol.js';
import {loadOpeningKey,processOpening} from '../dist/opening-worker.js';
import artifact from '../dist/abi/ProcurementWorkflow.json' with {type:'json'};
const [action,...flags]=process.argv.slice(2),args={};
for(let i=0;i<flags.length;i+=2){if(!flags[i]?.startsWith('--')||!flags[i+1])throw new Error('Use --option value pairs.');args[flags[i].slice(2)]=flags[i+1];}
const allowed=['tender','bidder','version','part','actor','custody-dir'];
if(Object.keys(args).some(k=>!allowed.includes(k))||!['request','verify'].includes(action))throw new Error('Use request or verify with --tender --part --actor; verify also requires --bidder --version --custody-dir.');
if(!/^[1-9][0-9]{0,77}$/.test(args.tender??'')||BigInt(args.tender)>=2n**256n)throw new Error('Provide a positive tender ID.');
const part=['initial','technical','financial'].indexOf(args.part);if(part<0)throw new Error('Part must be initial, technical or financial.');
const config=loadConfig(),chain=new BlockchainService(config);
try{
 const status=await chain.status();if(status.chainId!=='31337')throw new Error('This unlocked-account operator helper is restricted to local Hardhat chain 31337.');
 const signer=await chain.provider.getSigner(getAddress(args.actor)),workflow=new Contract(config.workflowAddress,artifact.abi,signer);
 if(action==='request'){
  const tender=await workflow.getTender(args.tender);
  if(Number(tender.state)===0){if(part!==0)throw new Error("Close and authorize the initial stage before requesting later parts.");await workflow.closeTender.staticCall(args.tender);const tx=await workflow.closeTender(args.tender);console.log('Close transaction:',tx.hash);await tx.wait();}
  await workflow.requestOpening.staticCall(args.tender,part);const tx=await workflow.requestOpening(args.tender,part);console.log('Opening request transaction:',tx.hash);await tx.wait();
 }else{
  if(!args['custody-dir'])throw new Error('Supply the development custody directory printed by keys:generate.');
  const request=validateOpeningRequest({context:{chainId:status.chainId,workflow:config.workflowAddress.toLowerCase(),tenderId:args.tender,bidder:getAddress(args.bidder).toLowerCase(),version:args.version},part,service:getAddress(args.actor).toLowerCase(),timestamp:Date.now().toString()});
  const custody=resolve(args['custody-dir']);
  const reportRoot=resolve('reports','openings');await mkdir(reportRoot,{recursive:true,mode:0o700});
  const file=join(reportRoot,Date.now()+'-'+randomUUID()+'.json');
  const report=await processOpening({chain,signer,request,loadKey:(p,f)=>loadOpeningKey(custody,p,f),
   retrieve:async(body,signature)=>{
    const res=await fetch(`http://127.0.0.1:${config.port}/api/storage/openings/retrieve`,{method:'POST',headers:{'Content-Type':'application/json','X-Opening-Signature':signature},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
    const value=await res.json();if(!res.ok)throw new Error(value?.error?.message??'Opening retrieval failed.');return value;
   },onSubmitted:async hash=>{await writeFile(file,JSON.stringify({status:'pending',request,transactionHash:hash},null,2),{mode:0o600,flush:true});console.log('Result transaction:',hash);}});
  await writeFile(file,JSON.stringify(report,null,2),{mode:0o600,flush:true});
  console.log(JSON.stringify({status:report.status,verified:report.verified,code:report.code,transactionHash:report.transactionHash,report:file},null,2));
 }
}catch(e){console.error(e?.code??'OPENING_FAILED',e?.message??'Opening failed.');process.exitCode=1;}
finally{chain.provider.destroy();}

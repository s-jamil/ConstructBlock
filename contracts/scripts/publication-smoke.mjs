import assert from 'node:assert/strict';
import hre from 'hardhat';
import { connectOfficer, submitPublication, checkPublication } from '../../frontend/src/publication.ts';
import { createApp } from '../../backend/dist/app.js';
import { BlockchainService } from '../../backend/dist/blockchain.js';
import { inject } from '../../backend/test/inject.mjs';
const connection = await hre.network.create();
const { ethers } = connection;
const [government, officer, commission, outsider] = await ethers.getSigners();
const registry = await ethers.deployContract('RoleRegistry', [government.address, 86400]);
await registry.waitForDeployment();
for (const [role, actor] of [[await registry.OFFICER_ROLE(), officer], [await registry.COMMISSION_ROLE(), commission]])
 await (await registry.grantRole(role, actor.address)).wait();
const workflow = await ethers.deployContract('ProcurementWorkflow', [await registry.getAddress()]);
await workflow.waitForDeployment();
const deployment = {ready:true,chainId:'31337',expectedChainId:'31337',blockNumber:0,contracts:{roleRegistry:await registry.getAddress(),procurementWorkflow:await workflow.getAddress(),registryLinked:true}};
let sends = 0;
function wallet(account, chain) { return { request:async ({method, params}) => {
 if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
 if (method === 'eth_chainId' && chain) return chain;
 if (method === 'eth_sendTransaction') { assert.equal(params[0].from.toLowerCase(), account.toLowerCase()); sends++; }
 return connection.provider.request({method,params:params ?? []});
}}; }
const approvedWallet = wallet(officer.address);
const input = {dossierDigest:ethers.id('publication integration dossier'),deadline:BigInt((await ethers.provider.getBlock('latest')).timestamp+3600),commission:commission.address,requiresTechnicalOffer:false,keyFingerprints:[ethers.id('initial key'),ethers.ZeroHash,ethers.id('financial key')]};
const provider = new ethers.BrowserProvider(connection.provider,undefined,{cacheTimeout:-1});
try {
 await assert.rejects(connectOfficer(wallet(officer.address,'0x1'),deployment),{code:'WRONG_CHAIN'});
 await assert.rejects(connectOfficer(wallet(outsider.address),deployment),{code:'NOT_OFFICER'});
 console.log('PASS wrong network and unapproved officer rejected');
 const session = await connectOfficer(approvedWallet,deployment);
 await assert.rejects(submitPublication(session,{...input,commission:outsider.address}),{code:'NOT_COMMISSION'});
 await assert.rejects(submitPublication(session,{...input,deadline:1n}),{code:'DEADLINE_PASSED'});
 await assert.rejects(submitPublication(session,input,()=>false),{code:'WALLET_CHANGED'});
 await assert.rejects(submitPublication({...session,injected:wallet(outsider.address)},input),{code:'WALLET_CHANGED'});
 assert.equal(sends,0);
 console.log('PASS invalid commission, deadline and changed wallet never send a transaction');
 const submission = await submitPublication(session,input);
 assert.equal(sends,1);
 const receipt = await checkPublication(approvedWallet,submission);
 assert.equal(receipt.tenderId,'1'); assert.equal(receipt.transactionHash,submission.hash);
 await assert.rejects(checkPublication(wallet(officer.address,'0x1'),submission),{code:'WRONG_CHAIN'});
 console.log('PASS wallet-signed publication and matching receipt confirmation');
 const config = {port:3001,rpcUrl:'http://127.0.0.1:8545',chainId:31337n,rpcTimeoutMs:2000,registryAddress:deployment.contracts.roleRegistry,workflowAddress:deployment.contracts.procurementWorkflow};
 const app = createApp(new BlockchainService(config,provider));
 const response = await inject(app,{method:'GET',url:`/api/tenders/${receipt.tenderId}`});
 assert.equal(response.statusCode,200);
 const tender = JSON.parse(response.payload);
 assert.equal(tender.state,'Open'); assert.equal(tender.dossierDigest,input.dossierDigest); assert.equal(tender.deadlineTimestamp,input.deadline.toString());
 console.log('PASS newly published tender is available through the public API');
 await (await registry.revokeRole(await registry.OFFICER_ROLE(),officer.address)).wait();
 await assert.rejects(submitPublication(session,input),{code:'NOT_OFFICER'});
 assert.equal(sends,1);
 console.log('PASS role revocation after connection prevents publication');
} finally { provider.destroy(); await connection.close(); }

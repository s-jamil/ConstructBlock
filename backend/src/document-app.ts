import express,{type ErrorRequestHandler} from 'express';
import {ApiError} from './errors.ts';
import type {DocumentService} from './document-service.ts';
export function createDocumentApp(service:DocumentService,allowedOrigin:string){
 const origin=new URL(allowedOrigin);if(origin.origin!==allowedOrigin)throw new Error('DOCUMENT_ORIGIN must be an exact origin without a trailing slash.');
 const app=express();app.disable('x-powered-by');
 app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});next();});
 const rates=new Map<string,{until:number;count:number}>();
 app.post('/api/documents/view',(req,_res,next)=>{
  if(req.get('Origin')!==allowedOrigin||req.get('Sec-Fetch-Site')==='cross-site')return next(new ApiError(403,'ORIGIN_DENIED','Document requests must come from the configured application origin.'));
  if(!req.is('application/json'))return next(new ApiError(415,'JSON_REQUIRED','Send a JSON viewing authorization.'));
  const now=Date.now();for(const [key,v]of rates)if(v.until<now)rates.delete(key);
  const key=req.socket.remoteAddress??'local',rate=rates.get(key)??{until:now+60000,count:0};rates.set(key,rate);
  if(++rate.count>20||rates.size>1000)return next(new ApiError(429,'RATE_LIMITED','Too many document requests. Wait one minute.'));
  next();
 },express.json({limit:'8kb',strict:true}),async(req,res)=>{res.json(await service.view(req.body,req.get('X-Document-Signature')??''));});
 app.use((_req,_res,next)=>next(new ApiError(404,'ROUTE_NOT_FOUND','No document endpoint exists at this path.')));
 const errors:ErrorRequestHandler=(error,_req,res,_next)=>{
  const e=error instanceof ApiError?error:error?.type==='entity.too.large'?new ApiError(413,'REQUEST_TOO_LARGE','Viewing request exceeds the limit.'):error?.type==='entity.parse.failed'?new ApiError(400,'INVALID_JSON','Invalid viewing JSON.'):new ApiError(503,'DOCUMENT_SERVICE_FAILED','Document service unavailable. No document was released.');
  res.status(e.status).json({error:{code:e.code,message:e.message}});
 };app.use(errors);return app;
}

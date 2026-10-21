'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const validator = require(workerData.validator);
const { readGlb } = require('./motion-library.cjs');
(async()=>{
  const bytes=workerData.bytes ? Buffer.from(workerData.bytes) : fs.readFileSync(workerData.filename); readGlb(bytes);
  const quality=await validator.validateBytes(new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength),{maxIssues:100});
  parentPort.postMessage({ok:true,issues:quality.issues});
})().catch(error=>parentPort.postMessage({ok:false,error:String(error.message).slice(0,1500)}));

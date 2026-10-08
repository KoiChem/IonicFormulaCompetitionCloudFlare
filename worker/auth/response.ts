export async function readBoundedJson(response:Response,limit=16384):Promise<Record<string,unknown>>{
 if(!response.body)throw new Error('empty oauth response');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>limit){await reader.cancel();throw new Error('oversized oauth response');}chunks.push(item.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 const value:unknown=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid oauth response');return value as Record<string,unknown>;
}

import {expect,it,vi} from 'vitest';
import {readBoundedJson} from '../../worker/auth/response';
it('rejects oversized token responses while streaming and cancels the body',async()=>{
 const cancel=vi.fn(),stream=new ReadableStream({pull(c){c.enqueue(new Uint8Array(8192));},cancel});await expect(readBoundedJson(new Response(stream),16384)).rejects.toThrow();expect(cancel).toHaveBeenCalledTimes(1);
});
it('accepts bounded JSON objects only',async()=>{expect(await readBoundedJson(Response.json({id_token:'signed'}))).toEqual({id_token:'signed'});await expect(readBoundedJson(Response.json([]))).rejects.toThrow();});

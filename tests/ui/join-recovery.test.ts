import {it,expect,vi,beforeEach} from 'vitest';
vi.mock('../../src/features/play/useRoomSync',()=>({postJson:vi.fn(),fetchJsonWithTimeout:vi.fn()}));
import {postJson,fetchJsonWithTimeout} from '../../src/features/play/useRoomSync';
import {submitPendingJoin} from '../../src/features/setup/join-recovery';
const draft={token:'same-token',requestId:'same-request',nickname:'生徒'};
beforeEach(()=>vi.resetAllMocks());
it('recovers a committed join when its response times out, without creating another participant',async()=>{
 vi.mocked(postJson).mockRejectedValue(Object.assign(new Error('timeout'),{code:'timeout'}));
 vi.mocked(fetchJsonWithTimeout).mockResolvedValue({participant:{id:'already-joined',nickname:'生徒'},room:{state:'PREPARING'}});
 expect(await submitPendingJoin('room',draft)).toEqual({participant:{id:'already-joined',nickname:'生徒'}});
 expect(postJson).toHaveBeenCalledTimes(1);
 expect(fetchJsonWithTimeout).toHaveBeenCalledWith('/api/rooms/room/state',expect.objectContaining({headers:{authorization:'Bearer same-token'}}),10000);
});
it('preserves an uncertain join when recovery also fails',async()=>{
 const timeout=Object.assign(new Error('timeout'),{code:'timeout'});
 vi.mocked(postJson).mockRejectedValue(timeout);
 vi.mocked(fetchJsonWithTimeout).mockRejectedValue(Object.assign(new Error('not yet committed'),{status:401}));
 await expect(submitPendingJoin('room',draft)).rejects.toBe(timeout);
});
it('does not recover a definitive nickname or capacity rejection',async()=>{
 const conflict=Object.assign(new Error('capacity'),{status:409,code:'capacity'});
 vi.mocked(postJson).mockRejectedValue(conflict);
 await expect(submitPendingJoin('room',draft)).rejects.toBe(conflict);
 expect(fetchJsonWithTimeout).not.toHaveBeenCalled();
});

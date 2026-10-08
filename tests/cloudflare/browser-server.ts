import {createWorkerFixture} from './helpers.ts';
const fixture=await createWorkerFixture('tests/cloudflare/browser-worker.ts',{port:8789,assetsDirectory:'dist',durableObjects:{ROOMS:'RoomCoordinator'},bindings:{MASTER_TEACHER_EMAIL:'master@example.com',GOOGLE_CLIENT_ID:'fixture',GOOGLE_CLIENT_SECRET:'fixture',APP_ORIGIN:'https://test'}});
console.log('Independent native loopback fixture ready on http://127.0.0.1:8789; Google identity and HTTPS transport are fixture-only.');
process.on('SIGINT',async()=>{await fixture.close();process.exit();});

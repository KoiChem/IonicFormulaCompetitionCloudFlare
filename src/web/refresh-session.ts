/** Share recovery across concurrent 401s without replaying any API mutation. */
export function sessionRefresher(refresh:()=>Promise<unknown>) {
  let pending:Promise<unknown>|undefined;
  return ()=>pending??=(refresh().finally(()=>{pending=undefined;}));
}

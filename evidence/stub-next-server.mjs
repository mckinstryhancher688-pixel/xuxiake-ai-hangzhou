/**
 * 仅供 evidence 里的进程内路由测试使用：把 `next/server` 换成这份桩。
 * 真实服务里 connection() 只是告诉 Next「这个处理函数要按请求实时执行、不要预渲染」，
 * 与路由里的任何业务逻辑无关；脱离 Next 请求上下文直接调路由函数时它会抛错，所以这里给一个空实现。
 * 业务逻辑（参数校验、求解、门禁、计数）全部走真实源码，没有被替换。
 */
export async function connection() {}

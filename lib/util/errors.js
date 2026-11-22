// 资源缺失（快照、清单、路径）与内部故障分开报：前者 404，后者 500。
// 用 status 字段而不是只靠 instanceof：宿主可能把插件模块加载成两份，类对象不相等。
export class NotFoundError extends Error {
  constructor(message) { super(message); this.name = "NotFoundError"; this.status = 404; }
}

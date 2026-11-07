/**
 * 数据可信说明：不折叠，放在行程栏顶部一眼能看到。
 * 只声明这个演示真实具备的口径；没有价格数据就明说没有，不承诺预算。
 */
export function DataTrustNote() {
  return (
    <section aria-label="数据可信说明" className="rounded-xl border border-line bg-paper px-3 py-2">
      <h2 className="text-[11px] font-semibold text-ink-700">数据可信说明</h2>
      <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-ink-500">
        <li>· 地点名称与「在飞猪查看」链接来自飞猪真实返回；行程卡逐张标注查询时间（杭州时间），✓已校验只在来源校验通过时点亮。</li>
        <li>· 坐标、步行距离／时长与营业时间来自高德实测；每站停留 30 分钟、缓冲 20 分钟是产品设定；「已到达」是手动模拟，不是真实 GPS。</li>
        <li>· 飞猪与高德都没有返回价格字段：本演示没有任何门票／酒店价格，不构成预算保证。</li>
        <li>· 查不到的数据一律明说（如「高德未返回地址」「营业时间无法核实」），绝不用常识补数字。</li>
      </ul>
    </section>
  );
}
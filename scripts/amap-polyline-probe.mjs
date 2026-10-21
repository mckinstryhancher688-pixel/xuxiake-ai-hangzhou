// 实测高德步行路径规划 2.0 到底在什么 show_fields 下才给导航折线。
// 用法：node --env-file=.env.local scripts/amap-polyline-probe.mjs
// 只发 2 次真实请求，用来决定服务端要缓存哪种形状的数据。
const key = process.env.AMAP_WEB_KEY;
if (!key) throw new Error("缺少 AMAP_WEB_KEY");

// 高德坐标顺序是「经度,纬度」，写反会直接 INVALID_PARAMS
const origin = "120.158818,30.256583"; // 湖滨公园（本项目固定起点，高德实测坐标）
const destination = "120.159282,30.247034"; // 西湖天地

async function ask(showFields) {
  const url = new URL("https://restapi.amap.com/v5/direction/walking");
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destination);
  url.searchParams.set("show_fields", showFields);
  url.searchParams.set("key", key);
  const response = await fetch(url);
  const json = await response.json();
  const path = json.route?.paths?.[0];
  const steps = Array.isArray(path?.steps) ? path.steps : [];
  const polylines = steps.map((step) => step.polyline).filter(Boolean);
  const totalChars = polylines.reduce((sum, item) => sum + item.length, 0);
  console.log(`show_fields=${showFields}`);
  console.log(
    `  status=${json.status} info=${json.info} infocode=${json.infocode ?? "-"}` +
      ` distance=${path?.distance} steps=${steps.length}`,
  );
  console.log(`  steps[].polyline 条数=${polylines.length} 合计字符=${totalChars}`);
  if (polylines[0]) {
    const first = String(polylines[0]);
    const points = first.split(";").filter(Boolean);
    console.log(`  第1段折线点数=${points.length} 首点=${points[0]} 末点=${points[points.length - 1]}`);
    console.log(`  片段预览=${first.slice(0, 90)}…`);
  }
  // 顶层是否还有别的折线字段，避免漏掉官方给的更粗粒度几何
  console.log(`  path 顶层字段=${Object.keys(path ?? {}).join(",")}`);
  if (steps[0]) console.log(`  step 字段=${Object.keys(steps[0]).join(",")}`);
}

await ask("cost");
await ask("cost,polyline");

/**
 * 沿途无障碍洗手间纯函数回归（零付费夹具）。
 * 跑法：node --import ./evidence/register-alias.mjs evidence/toilet-unit.mjs
 */
const { isAccessibleToilet, nearestToilets, toiletText, NEARBY_RADIUS_METERS, AMAP_ACCESSIBLE_TOILET_TYPECODE, TOILET_SCOPE_NOTE } = await import("../src/lib/toilet.ts");

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
};

// 西湖附近真实坐标量级
const ANCHOR = { name: "平湖秋月", position: { lat: 30.252108, lng: 120.145457 } };
const toilets = [
  { id: "t1", name: "无障碍洗手间(平湖秋月)", position: { lat: 30.2521, lng: 120.1455 }, address: "孤山后山路1号", typecode: AMAP_ACCESSIBLE_TOILET_TYPECODE },
  { id: "t2", name: "无障碍洗手间(龙井路)", position: { lat: 30.24959, lng: 120.160869 }, address: "龙井路1号", typecode: AMAP_ACCESSIBLE_TOILET_TYPECODE },
  // 冒充项：普通公厕，不能被选中
  { id: "x1", name: "公共厕所", position: { lat: 30.25211, lng: 120.14551 }, address: "近处但普通", typecode: "200300" },
];

/* 1. 类型判定 */
check("1 分类码 200303 判为无障碍洗手间", isAccessibleToilet({ typecode: "200303", name: "任意" }) === true);
check("1b 普通公厕(200300) 不算", isAccessibleToilet({ typecode: "200300", name: "公共厕所" }) === false);
check("1c 名称明确写「无障碍」时兜底认", isAccessibleToilet({ typecode: null, name: "无障碍洗手间(城市阳台)" }) === true);
check("1d 名称只写「公厕」不认", isAccessibleToilet({ typecode: null, name: "兰心公厕(湖滨三公园)" }) === false);

/* 2. 最近一条 */
const r = nearestToilets(toilets, [ANCHOR]);
check("2 给锚点挑出最近的无障碍洗手间", r.nearest.length === 1 && r.nearest[0].toiletName === "无障碍洗手间(平湖秋月)", r.nearest);
check("2b 距离四舍五入到米，且是直线距离", r.nearest[0].straightLineMeters >= 0 && r.nearest[0].straightLineMeters < 50, r.nearest[0].straightLineMeters);
check("2c 没挑到那条更近的普通公厕", !r.nearest[0].toiletName.includes("公共厕所"));

/* 3. 半径外不给 */
const far = [{ name: "远站", position: { lat: 31.0, lng: 121.4 } }];
const rFar = nearestToilets(toilets, far);
check("3 半径内没有就如实记入 anchorsWithoutToilet", rFar.nearest.length === 0 && rFar.anchorsWithoutToilet.length === 1, rFar.anchorsWithoutToilet);
check("3b 阈值就是常量 " + NEARBY_RADIUS_METERS, NEARBY_RADIUS_METERS === 800);

/* 4. 只有普通公厕时：宁可没有，也不冒充 */
const rFake = nearestToilets(toilets.filter((t) => t.typecode !== "200303" && !/无障碍/.test(t.name)), [ANCHOR]);
check("4 只有普通公厕时返回空而不是凑数", rFake.nearest.length === 0 && rFake.anchorsWithoutToilet.length === 1);

/* 5. 多锚点各自挑各自最近的 */
const rMulti = nearestToilets(toilets, [ANCHOR, { name: "龙井站", position: { lat: 30.2496, lng: 120.1609 } }]);
check("5 每个锚点各挑最近的一条", rMulti.nearest.length === 2 && new Set(rMulti.nearest.map((n) => n.anchorName)).size === 2, rMulti.nearest.map((n) => `${n.anchorName}->${n.toiletName}`));
check("5b 同一景点可被两个锚点共用", rMulti.nearest.length === 2);

/* 6. 文案 */
check("6 文案写明直线距离，不用「附近有」含糊表述", /直线 \d+ 米/.test(toiletText(r.nearest[0])), toiletText(r.nearest[0]));

/* 7. 口径说明必须写明「不代表整条路线无障碍」 */
check("7 口径说明含「不代表整条路线无障碍」", TOILET_SCOPE_NOTE.includes("不代表整条路线无障碍"));
check("7b 口径说明写明是直线距离、不是步行距离", TOILET_SCOPE_NOTE.includes("直线距离") && TOILET_SCOPE_NOTE.includes("不是步行距离"));
check("7c 口径说明写明不代表当天开放", TOILET_SCOPE_NOTE.includes("不代表当天开放"));

/* 8. 空输入不炸 */
const rEmpty = nearestToilets([], [ANCHOR]);
check("8 没有洗手间数据时安全返回", rEmpty.nearest.length === 0 && rEmpty.anchorsWithoutToilet.length === 1);

const failed = results.filter((i) => !i.pass);
console.log(`\n${results.length - failed.length}/${results.length} 无障碍洗手间纯函数检查通过`);
for (const i of failed) console.log(`未通过：${i.name}`);
process.exit(failed.length ? 1 : 0);

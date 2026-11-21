import assert from "node:assert/strict";
import { isAdministrativeOfficeName } from "../src/lib/verification.ts";

// 纯名字护栏的离线回归：飞猪实测把「馒头山社区居委会」标成文创街区候选，
// 这类行政办公点必须在花高德调用之前被剔掉。零真实 API 调用。
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

check("真实踩到的名字会被剔掉", () => {
  assert.equal(isAdministrativeOfficeName("馒头山社区居委会"), true);
});

check("村委会/办事处/政府/服务中心一类同样剔掉", () => {
  for (const name of [
    "某村村民委员会",
    "拱宸桥街道办事处",
    "上城区人民政府",
    "小河党群服务中心",
    "湖墅社区服务中心",
  ]) {
    assert.equal(isAdministrativeOfficeName(name), true, name);
  }
});

check("真实可逛的街区名字一个都不误伤", () => {
  for (const name of [
    "清河坊街",
    "南宋御街",
    "桥西直街",
    "良渚文化村",
    "小河直街",
    "南山路",
    "西湖天地",
    "桥西历史街区",
    "大兜路历史文化街区",
    "馒头山社区",
  ]) {
    assert.equal(isAdministrativeOfficeName(name), false, name);
  }
});

check("首尾空格不影响判定", () => {
  assert.equal(isAdministrativeOfficeName("  馒头山社区居委会  "), true);
});

console.log(`\n${passed}/${passed} 行政办公点名字护栏回归通过（零真实 API 调用）`);

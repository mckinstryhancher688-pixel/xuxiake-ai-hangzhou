import type { Poi } from "@/lib/types";

/**
 * ⚠️ MOCK DATA — 演示用静态数据，不是飞猪/高德实时结果。
 * 坐标为西湖湖滨一带的近似值，仅用于在演示地图上摆出合理相对位置；
 * 停留时间、开放情况均为人工估算，未经现场核实。
 * 接入真实数据后，本文件应只作为 dev 兜底，生产路径走 src/lib/adapters。
 */
export const MOCK_POIS: Poi[] = [
  {
    id: "hubin-park",
    name: "湖滨公园",
    subtitle: "一公园 · 沿湖步道起点",
    category: "landmark",
    position: { lat: 30.2505, lng: 120.1612 },
    stayMinutes: 30,
    opening: "全天开放（演示数据，未核实）",
    openingVerified: false,
    tags: ["看落日", "湖岸线", "人流较多"],
    reason: "零交通成本的起点。先沿湖走一小段，避开湖滨步行街最吵的商铺段，再拐进安静里弄。",
    discovery:
      "湖面上的集贤亭是西湖里少见的、完全建在水中的亭子——退到对岸拍，能把亭子和城市天际线同时框进一张照片。",
    source: "mock",
  },
  {
    id: "hubian-cun",
    name: "湖边邨建筑群",
    subtitle: "石库门里弄 · 近代建筑群",
    category: "quiet-street",
    position: { lat: 30.2536, lng: 120.165 },
    stayMinutes: 40,
    opening: "街区全天可通行，院落部分不对外开放（演示数据，未核实）",
    openingVerified: false,
    tags: ["安静街区", "老建筑", "人文街景"],
    reason: "整条路线里最贴合「安静小街区」的一段：弄堂短、车进不来，砖墙和晾衣杆构成现成的取景框。",
    discovery:
      "这里仍然是有居民生活的里弄，不是景区布景。光线从东侧砖墙斜切进来时，墙面会出现明显的冷暖分界——这是它最出片的二十分钟。",
    source: "mock",
  },
  {
    id: "yongjinmen",
    name: "古湧金门",
    subtitle: "五代吴越国西城门遗址 · 涌金池",
    category: "culture",
    position: { lat: 30.2418, lng: 120.1583 },
    stayMinutes: 30,
    opening: "全天开放（演示数据，未核实）",
    openingVerified: false,
    tags: ["遗址", "湖岸视野", "人少"],
    reason: "从湖滨往南自然串联的一环，人比湖滨少很多，湖岸视野一下子打开。",
    discovery:
      "地面遗存其实很少，值得看的是「水门」这个概念本身——古代船只可以直接从城门驶进城里，涌金池就是当年的港池。",
    source: "mock",
  },
  {
    id: "liulang",
    name: "柳浪闻莺",
    subtitle: "西湖十景之一 · 柳树成荫",
    category: "nature",
    position: { lat: 30.236, lng: 120.1528 },
    stayMinutes: 60,
    opening: "全天开放，园内展馆开放情况未核实（演示数据）",
    openingVerified: false,
    tags: ["自然风光", "安静", "可坐下休息"],
    reason: "全程「自然风光 + 安静」最均衡的一段，也是唯一适合坐下来休息超过半小时的地方。",
    discovery:
      "「闻莺」是听觉景观而不是视觉景观——这条景的设计意图是让你闭眼听。下午鸟鸣比清晨少，但风穿过柳条的声音一直在。",
    source: "mock",
  },
];

export const MOCK_POI_BY_ID: Record<string, Poi> = Object.fromEntries(
  MOCK_POIS.map((poi) => [poi.id, poi]),
);

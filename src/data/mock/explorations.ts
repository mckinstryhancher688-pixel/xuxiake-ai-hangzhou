import type { ExplorationContent } from "@/lib/types";

/**
 * ⚠️ MOCK DATA — 「我到了」之后展示的探索内容。
 * 这些文案是人工预写的示例，用来占位百炼千问 Agent 的输出位置。
 * 真实接入后由 src/lib/adapters/bailian.ts 动态生成，本文件仅作 dev 兜底。
 */
export const MOCK_EXPLORATIONS: Record<string, ExplorationContent> = {
  "hubin-park": {
    poiId: "hubin-park",
    arrivedHeadline: "你已经在湖滨了——先别急着往里弄走",
    discoveries: [
      "集贤亭是西湖里少数完全建在水中的亭子，退到对岸才能把它和城市天际线一起框进画面。",
      "脚下这段湖岸在清末是旗人营地，「湖滨」这个地名比西湖景区本身年轻得多。",
      "傍晚 17:20 前后（演示估算，未核实）湖面会有明显的金色反光带，位置随季节偏移。",
    ],
    photoTip: "低角度贴水面拍，把游船的尾迹当前景引导线。",
    askNext: ["附近有没有能坐下喝水的地方", "这段湖岸人少的时间点", "往南走会经过什么"],
    source: "mock",
  },
  "hubian-cun": {
    poiId: "hubian-cun",
    arrivedHeadline: "走进弄堂之后，声音会突然变小",
    discoveries: [
      "这是仍然有居民生活的里弄，不是复原的景区布景——拍照请避开住户门窗与晾晒衣物。",
      "石库门的门楣砖雕每一户都不一样，值得抬头看第二眼。",
      "弄堂很短，20 分钟走完；真正耐看的是砖墙在斜射光下的冷暖分界。",
    ],
    photoTip: "用手机长焦压缩弄堂纵深，人物只作剪影入画，避免拍到住户正脸。",
    askNext: ["这一带还有什么老建筑", "附近有没有安静咖啡馆", "继续往南的路况"],
    source: "mock",
  },
  yongjinmen: {
    poiId: "yongjinmen",
    arrivedHeadline: "地面遗存很少，但站的位置很特别",
    discoveries: [
      "涌金池是古代的水门港池——船只当年可以直接从城门驶进城里，这在现存古城里非常少见。",
      "「金牛出水」的传说就出自这里，是杭州城最早的一批地方叙事之一。",
      "从这一带往南，湖岸的人流密度明显下降，是整条路线上最安静的湖边段。",
    ],
    photoTip: "把城门遗址的石构件放在前景，远处的雷峰塔作背景，形成时间对比。",
    askNext: ["下一段还要走多久", "附近有卫生间吗", "这里日落时分会怎样"],
    source: "mock",
  },
  liulang: {
    poiId: "liulang",
    arrivedHeadline: "这一景的设计意图是让你闭眼",
    discoveries: [
      "「闻莺」是听觉景观而不是视觉景观——柳树成荫是为了留住鸟，不是为了好看。",
      "下午鸟鸣比清晨少，但风穿过柳条的声音一直在，坐在长椅上十分钟就能听到差别。",
      "这里是全程唯一适合停留超过半小时的地方，收尾坐下比继续赶下一个点更值。",
    ],
    photoTip: "逆光拍柳条边缘的透光，避开正午顶光；长椅高度刚好是低机位。",
    askNext: ["附近地铁站怎么走", "还有时间再加一个点吗", "这里晚上会关门吗"],
    source: "mock",
  },
};

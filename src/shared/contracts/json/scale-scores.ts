// 对应文档：《技术方案》scale_scores_json

export type ScaleItemId =
  | "S01"
  | "S02"
  | "S03"
  | "S04"
  | "S05"
  | "S06"
  | "S07"
  | "S08"
  | "S09"
  | "S10";

export type ScaleValue = 1 | 2 | 3 | 4 | 5;

export interface ScaleScore {
  item_id: ScaleItemId;
  value: ScaleValue;
}

/** 题干和选项文案使用客户端固定配置，此协议只保存量表版本与评价结果。 */
export interface ScaleScores {
  schema_version: 1;
  scale_version: string;
  // 允许保存未填写或部分填写结果；完成课堂前须校验十个题目各出现一次。
  scores: ScaleScore[];
}

// 冻结表定义的初始占位 JSON 为 {"schema_version":1,"scores":[]}，不含 scale_version。
// 仓储读取时应识别为尚未填写；进入量表填写时按实际采用的客户端量表配置补齐版本。
// 不要把缺少版本的占位 JSON 直接断言为 ScaleScores。

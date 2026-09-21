// 对应文档：《技术方案》resume_state_json

/** 只记录课堂恢复位置；活动结果、录音、转写和评分仍存放在各自业务字段。 */
export interface ResumeState {
  schema_version: 1;
  current_activity_id: string | null;
  current_item_id: string | null;
  completed_activity_ids: string[];
}

// 冻结表定义使用 {} 表示没有恢复记录；仓储读取时应将它转换为业务值 null。
// 业务对象中的恢复字段可使用 ResumeState | null，写回无记录状态时保存 {}。
// 全部活动完成时两个 current_* 字段都为 null，并保留 completed_activity_ids；
// 此状态与“没有恢复记录”不同。
// 活动 / 题目 ID 是否存在、所属关系及完成列表是否重复，在运行时校验。

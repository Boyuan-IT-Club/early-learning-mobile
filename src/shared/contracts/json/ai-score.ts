// AIScore 对应故事叙述的 ai_score_json；QuestionAIScore 对应单次问答评分。

export interface AIScoreEvidence {
  source: "TRANSCRIPT";
  text: string;
  start_offset: number;
  end_offset: number;
}

/** 未评分模板允许 null，不能作为成功评分或完成业务的依据。 */
export interface AIScoreItem {
  score: QuestionScoreValue | null;
  max_score: 2;
  reason: string | null;
  evidence: AIScoreEvidence[];
}

export interface AIScoreDimension extends AIScoreItem {
  item_code: string;
  item_name: string;
}

export interface AIScoreContentItem extends AIScoreItem {
  content_item_id: string;
  rubric_item_code: string;
}

export interface AIScoreProductivity extends AIScoreItem {
  item_code: "NARRATIVE_PRODUCTIVITY";
  /** 词数 / C 单元数，无有效统计时为 null。 */
  mean_c_unit_length: number | null;
  adjective_count: number | null;
  adverb_count: number | null;
  conjunction_count: number | null;
}

/** 对应《技术方案》v2，包括未评分模板；成功评分须额外校验全部必需条目。 */
export interface AIScore {
  schema_version: 2;
  rubric_version: string;
  summary: string | null;
  macrostructure: {
    dimensions: AIScoreDimension[];
    content_items: AIScoreContentItem[];
  };
  microstructure: {
    dimensions: AIScoreDimension[];
    productivity: AIScoreProductivity;
  };
  model_meta: {
    model: string;
    prompt_version: string;
  };
}

export type QuestionScoreValue = 0 | 1 | 2;

/** 一次回答的 AI 评分，嵌入 ActivityResult 的 before_hint / after_hint。 */
export interface QuestionAIScore {
  rubric_version: string;
  score: QuestionScoreValue;
  max_score: 2;
  reason: string;
  // 证据偏移对应所属 AnswerAttempt 的 transcript_text，不是故事转写。
  evidence: AIScoreEvidence[];
}

// 必需条目、版本、图片分组映射和证据在运行时按评分标准及原文校验。
// 外部 JSON 先按 unknown 接收并校验，不使用类型断言代替校验。

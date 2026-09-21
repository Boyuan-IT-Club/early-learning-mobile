import type { FileCode } from "../codes";
import type { QuestionAIScore } from "./ai-score";

/** 提示前或提示后的一次回答 */
export interface AnswerAttempt {
  audio_file_code: FileCode | null
  transcript_text: string | null
  ai_score: QuestionAIScore | null
}

/** 单道问题的回答结果 */
export type QuestionAnswer = { question_id: string } & (
  | {
      status: 'ANSWERED'
      hint_used: false
      before_hint: AnswerAttempt
      after_hint: null
    }
  | {
      status: 'ANSWERED'
      hint_used: true
      before_hint: AnswerAttempt
      after_hint: AnswerAttempt
    }
  | {
      status: 'SKIPPED'
      hint_used: false
      before_hint: null
      after_hint: null
    }
)

/** 图片排序结果 */
export interface ImageSortingActivityResult {
  activity_id: string
  type: 'IMAGE_SORTING'
  result: {
    child_order: string[]
    is_correct: boolean
  }
}

/** 问答结果 */
export interface QuestionAnsweringActivityResult {
  activity_id: string
  type: 'QUESTION_ANSWERING'
  result: {
    answers: QuestionAnswer[]
  }
}

/** 故事叙述结果 */
export interface StoryNarrationActivityResult {
  activity_id: string
  type: 'STORY_NARRATION'
  result: {
    completed: boolean
  }
}

/** 根据 type 区分活动及其对应结果 */
export type ActivityResult =
  | ImageSortingActivityResult
  | QuestionAnsweringActivityResult
  | StoryNarrationActivityResult

/** activity_results_json 的完整结构 */
export interface ActivityResultsJson {
  schema_version: 2
  rubric_version: string | null
  activity_results: ActivityResult[]
}

// 完成时：ANSWERED 的 before_hint 必须有确认文本和有效评分；
// hint_used=true 时 after_hint 也必须有确认文本和有效评分，否则不得完成。
// 最终分 = hint_used ? after_hint.ai_score.score : before_hint.ai_score.score。
// 不取两次评分的最大值，不重复保存可推导的最终分。
// 修改回答文本或评分依据后须使相应旧评分失效，并拒收过期请求结果。

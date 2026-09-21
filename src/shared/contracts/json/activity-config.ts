import type { FileCode, GrammarCode } from "../codes";

export type ContentItem = {
  content_item_id: string;
  image_file_codes: FileCode[];
  rubric_item_code: string;
};

export interface Question {
  question_id: string;
  text: string;
  hint: string;
  grammar: GrammarCode[];
}

export interface StoryNarrationActivity {
  activity_id: string;
  type: "STORY_NARRATION";
  config: {audio_file_code: FileCode, content_items: ContentItem[]};
}

export interface ImageSortingActivity {
  activity_id: string;
  type: "IMAGE_SORTING";
  config: {
    items: { item_id: string; file_code: FileCode }[];
    correct_order: string[];
  };
}

export interface QuestionAnsweringActivity {
  activity_id: string;
  type: "QUESTION_ANSWERING";
  config: { questions: Question[] };
}

export type Activity =
  | StoryNarrationActivity
  | ImageSortingActivity
  | QuestionAnsweringActivity;

/** 对应《技术方案》v2；统一评分规则由服务端维护，不在问题中重复保存。 */
export interface ActivityConfig {
  schema_version: 2;
  story_context: string;
  activities: Activity[];
}

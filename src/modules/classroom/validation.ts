import {
  AppError, assertAIScoreComplete, parseActivityResults, parseScaleScores,
  type ActivityConfig, type ActivityResultsJson, type AIScore, type QuestionAnswer,
} from '../../shared/contracts/index.ts';

function fail(code: string, message: string): never {
  throw new AppError(code, message);
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && expected.every(item => actual.includes(item));
}

export function assertClassroomCourse(config: ActivityConfig): void {
  if (!config.activities.some(activity => activity.type === 'STORY_NARRATION')) {
    fail('COURSE_MISSING_NARRATION', '课程缺少故事叙述活动，不能开始课堂。');
  }
}

export function assertResultsMatchConfig(config: ActivityConfig, value: ActivityResultsJson, complete: boolean): void {
  const results = parseActivityResults(value);
  for (const result of results.activity_results) {
    const activity = config.activities.find(item => item.activity_id === result.activity_id);
    if (!activity || activity.type !== result.type) fail('ACTIVITY_RESULT_MISMATCH', '课堂活动结果与课程配置不匹配。');
    if (result.type === 'IMAGE_SORTING' && activity.type === 'IMAGE_SORTING') {
      const expected = activity.config.items.map(item => item.item_id);
      if (!sameMembers(result.result.child_order, expected)) fail('INVALID_IMAGE_ORDER', '图片排序结果必须包含配置中的全部图片且不能重复。');
      const correct = result.result.child_order.every((item, index) => item === activity.config.correct_order[index]);
      if (result.result.is_correct !== correct) fail('INVALID_IMAGE_ORDER', '图片排序正确性与儿童实际顺序不一致。');
    }
    if (result.type === 'QUESTION_ANSWERING' && activity.type === 'QUESTION_ANSWERING') {
      const expected = activity.config.questions.map(question => question.question_id);
      const actual = result.result.answers.map(answer => answer.question_id);
      if (actual.some(id => !expected.includes(id)) || (complete && !sameMembers(actual, expected))) {
        fail('QUESTION_RESULT_MISMATCH', '问答结果与课程题目不匹配。');
      }
      if (complete) for (const answer of result.result.answers) assertAnswerComplete(answer);
    }
  }
  if (complete) {
    const expected = config.activities.map(activity => activity.activity_id);
    const actual = results.activity_results.map(result => result.activity_id);
    if (!sameMembers(actual, expected)) fail('ACTIVITY_RESULTS_INCOMPLETE', '课堂活动尚未全部完成。');
    const narration = results.activity_results.find(result => result.type === 'STORY_NARRATION');
    if (!narration || !narration.result.completed) fail('NARRATION_INCOMPLETE', '故事叙述活动尚未完成。');
  }
}

function assertAnswerComplete(answer: QuestionAnswer): void {
  if (answer.status === 'SKIPPED') return;
  if (answer.before_hint.transcript_text === null) fail('ANSWER_NOT_CONFIRMED', '提示前回答文本尚未确认。');
  if (answer.before_hint.ai_score === null) fail('ANSWER_SCORE_MISSING', '提示前回答尚未完成评分。');
  if (answer.hint_used) {
    if (answer.after_hint.transcript_text === null) fail('ANSWER_NOT_CONFIRMED', '提示后回答文本尚未确认。');
    if (answer.after_hint.ai_score === null) fail('ANSWER_SCORE_MISSING', '提示后回答尚未完成评分。');
  }
}

export function assertCollectionComplete(config: ActivityConfig, value: ActivityResultsJson): void {
  const results = parseActivityResults(value);
  assertResultsMatchConfig(config, results, false);
  const expectedActivities = config.activities.map(activity => activity.activity_id);
  const actualActivities = results.activity_results.map(result => result.activity_id);
  if (!sameMembers(actualActivities, expectedActivities)) fail('ACTIVITY_RESULTS_INCOMPLETE', '课堂活动尚未全部完成。');
  for (const result of results.activity_results) {
    if (result.type === 'STORY_NARRATION' && !result.result.completed) fail('NARRATION_INCOMPLETE', '故事叙述活动尚未完成。');
    if (result.type === 'QUESTION_ANSWERING') {
      const configured = config.activities.find(activity => activity.activity_id === result.activity_id);
      const expectedQuestions = configured?.type === 'QUESTION_ANSWERING' ? configured.config.questions.map(question => question.question_id) : [];
      if (!sameMembers(result.result.answers.map(answer => answer.question_id), expectedQuestions)) fail('QUESTION_RESULT_MISMATCH', '问答结果与课程题目不匹配。');
      for (const answer of result.result.answers) {
        if (answer.status === 'ANSWERED' && answer.before_hint.transcript_text === null) fail('ANSWER_NOT_CONFIRMED', '提示前回答文本尚未确认。');
        if (answer.status === 'ANSWERED' && answer.hint_used && answer.after_hint.transcript_text === null) fail('ANSWER_NOT_CONFIRMED', '提示后回答文本尚未确认。');
      }
    }
  }
}

export function assertClassroomComplete(
  config: ActivityConfig,
  results: ActivityResultsJson,
  audioFileId: number | null,
  transcriptText: string | null,
  aiScore: AIScore | null,
  scaleScores: unknown,
): void {
  assertResultsMatchConfig(config, results, true);
  if (audioFileId === null || transcriptText === null) fail('NARRATION_NOT_CONFIRMED', '故事录音和教师确认文本必须完整。');
  if (results.rubric_version === null || aiScore === null) fail('NARRATION_SCORE_MISSING', '故事 AI 评分尚未完成。');
  assertAIScoreComplete(aiScore, config, transcriptText, results.rubric_version);
  const scale = parseScaleScores(scaleScores);
  if (!scale || scale.scores.length !== 10) fail('SCALE_SCORES_INCOMPLETE', '十题评价必须完整填写。');
  const expected = Array.from({ length: 10 }, (_, index) => `S${String(index + 1).padStart(2, '0')}`);
  if (!sameMembers(scale.scores.map(item => item.item_id), expected)) fail('SCALE_SCORES_INCOMPLETE', '十题评价必须恰好包含 S01 至 S10。');
}

/** 采集文本改变时保留采集内容，但使旧评分失效；评分只能由专用保存入口写入。 */
export function mergeCollectedResults(previous: ActivityResultsJson, incoming: ActivityResultsJson): ActivityResultsJson {
  const next = structuredClone(parseActivityResults(incoming));
  next.rubric_version = previous.rubric_version;
  for (const result of next.activity_results) {
    if (result.type !== 'QUESTION_ANSWERING') continue;
    const oldResult = previous.activity_results.find(item => item.type === 'QUESTION_ANSWERING' && item.activity_id === result.activity_id);
    for (const answer of result.result.answers) {
      if (answer.status !== 'ANSWERED') continue;
      const oldAnswer = oldResult?.type === 'QUESTION_ANSWERING'
        ? oldResult.result.answers.find(item => item.question_id === answer.question_id)
        : undefined;
      if (oldAnswer?.status !== 'ANSWERED') {
        answer.before_hint.ai_score = null;
        if (answer.hint_used) answer.after_hint.ai_score = null;
        continue;
      }
      answer.before_hint.ai_score = oldAnswer.before_hint.transcript_text === answer.before_hint.transcript_text
        ? oldAnswer.before_hint.ai_score : null;
      if (answer.hint_used) {
        answer.after_hint.ai_score = oldAnswer.hint_used && oldAnswer.after_hint.transcript_text === answer.after_hint.transcript_text
          ? oldAnswer.after_hint.ai_score : null;
      }
    }
  }
  return next;
}

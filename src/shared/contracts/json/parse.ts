import { AppError } from '../errors.ts';
import type { Activity, ActivityConfig } from './activity-config';
import type { ActivityResult, ActivityResultsJson, AnswerAttempt, QuestionAnswer } from './activity-result';
import type { AIScore, AIScoreEvidence, AIScoreItem, QuestionAIScore, QuestionScoreValue } from './ai-score';
import type { ResumeState } from './resume-state';
import type { ScaleItemId, ScaleScores, ScaleValue } from './scale-scores';

/** 只报告字段路径，不将儿童文本或完整 JSON 放入错误消息。 */
export class ContractError extends AppError<'INVALID_JSON_CONTRACT'> {
  constructor(path: string) {
    super('INVALID_JSON_CONTRACT', `Invalid JSON contract: ${path}`);
    this.name = 'ContractError';
  }
}

function check(condition: boolean, path: string): asserts condition {
  if (!condition) throw new ContractError(path);
}

function object(value: unknown, path: string): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value), path);
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  check(Array.isArray(value), path);
  return value;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  check(typeof value === 'string' && (allowEmpty || value.trim().length > 0), path);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path, true);
}

function bool(value: unknown, path: string): boolean {
  check(typeof value === 'boolean', path);
  return value;
}

function strings(value: unknown, path: string): string[] {
  const result = list(value, path).map((v, i) => string(v, `${path}[${i}]`));
  unique(result, path);
  return result;
}

function unique(values: string[], path: string): void {
  check(new Set(values).size === values.length, path);
}

function number(value: unknown, path: string, integer = true): number {
  check(typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value)), path);
  return value;
}

function score(value: unknown, path: string): QuestionScoreValue {
  check(value === 0 || value === 1 || value === 2, path);
  return value;
}

function evidence(value: unknown, path: string): AIScoreEvidence[] {
  return list(value, path).map((entry, i) => {
    const p = `${path}[${i}]`;
    const v = object(entry, p);
    check(v.source === 'TRANSCRIPT', `${p}.source`);
    const start = number(v.start_offset, `${p}.start_offset`);
    const end = number(v.end_offset, `${p}.end_offset`);
    check(end > start, `${p}.end_offset`);
    return { source: 'TRANSCRIPT', text: string(v.text, `${p}.text`, true), start_offset: start, end_offset: end };
  });
}

function checkEvidence(items: AIScoreEvidence[], transcript: string, path: string): void {
  for (const e of items) {
    check(e.end_offset <= transcript.length && transcript.slice(e.start_offset, e.end_offset) === e.text, path);
  }
}

/** 输入为 JSON.parse 后的 unknown；不在此处检查本地资源是否存在或是否允许发布。 */
export function parseActivityConfig(value: unknown): ActivityConfig {
  const v = object(value, 'activity_configs_json');
  check(v.schema_version === 2, 'schema_version');
  const activities: Activity[] = list(v.activities, 'activities').map((entry, i) => {
    const p = `activities[${i}]`;
    const a = object(entry, p);
    const activity_id = string(a.activity_id, `${p}.activity_id`);
    const c = object(a.config, `${p}.config`);
    switch (a.type) {
      case 'IMAGE_SORTING': {
        const items = list(c.items, `${p}.items`).map((entry, j) => {
          const item = object(entry, `${p}.items[${j}]`);
          return { item_id: string(item.item_id, `${p}.item_id`), file_code: string(item.file_code, `${p}.file_code`) };
        });
        const correct_order = strings(c.correct_order, `${p}.correct_order`);
        unique(items.map(item => item.item_id), `${p}.items`);
        check(items.length === correct_order.length && items.every(item => correct_order.includes(item.item_id)), `${p}.correct_order`);
        return { activity_id, type: a.type, config: { items, correct_order } };
      }
      case 'QUESTION_ANSWERING': {
        const questions = list(c.questions, `${p}.questions`).map((entry, j) => {
          const q = object(entry, `${p}.questions[${j}]`);
          check(!('scoring_rubric' in q), `${p}.scoring_rubric`);
          return { question_id: string(q.question_id, `${p}.question_id`), text: string(q.text, `${p}.text`), hint: string(q.hint, `${p}.hint`, true), grammar: strings(q.grammar, `${p}.grammar`) };
        });
        unique(questions.map(q => q.question_id), `${p}.questions`);
        return { activity_id, type: a.type, config: { questions } };
      }
      case 'STORY_NARRATION': {
        const content_items = list(c.content_items, `${p}.content_items`).map((entry, j) => {
          const item = object(entry, `${p}.content_items[${j}]`);
          check(!('image_file_code' in item) && !('audio_file_code' in item), `${p}.content_items[${j}]`);
          return { content_item_id: string(item.content_item_id, `${p}.content_item_id`), image_file_codes: strings(item.image_file_codes, `${p}.image_file_codes`), rubric_item_code: string(item.rubric_item_code, `${p}.rubric_item_code`) };
        });
        unique(content_items.map(item => item.content_item_id), `${p}.content_items`);
        return { activity_id, type: a.type, config: { audio_file_code: string(c.audio_file_code, `${p}.audio_file_code`), content_items } };
      }
      default: throw new ContractError(`${p}.type`);
    }
  });
  unique(activities.map(a => a.activity_id), 'activities.activity_id');
  unique(activities.map(a => a.type), 'activities.type');
  return { schema_version: 2, story_context: string(v.story_context, 'story_context'), activities };
}

function parseQuestionScore(value: unknown, path: string, transcript: string | null, rubric: string | null): QuestionAIScore {
  const v = object(value, path);
  const rubric_version = string(v.rubric_version, `${path}.rubric_version`);
  check(rubric_version === rubric && transcript !== null, path);
  check(v.max_score === 2, `${path}.max_score`);
  const items = evidence(v.evidence, `${path}.evidence`);
  checkEvidence(items, transcript, `${path}.evidence`);
  return { rubric_version, score: score(v.score, `${path}.score`), max_score: 2, reason: string(v.reason, `${path}.reason`), evidence: items };
}

function attempt(value: unknown, path: string, rubric: string | null): AnswerAttempt {
  const v = object(value, path);
  const transcript_text = nullableString(v.transcript_text, `${path}.transcript_text`);
  return {
    audio_file_code: v.audio_file_code === null ? null : string(v.audio_file_code, `${path}.audio_file_code`),
    transcript_text,
    ai_score: v.ai_score === null ? null : parseQuestionScore(v.ai_score, `${path}.ai_score`, transcript_text, rubric),
  };
}

/** 允许未采集、未确认和待评分结果；通过解析不代表允许确认完成。 */
export function parseActivityResults(value: unknown): ActivityResultsJson {
  const v = object(value, 'activity_results_json');
  check(v.schema_version === 2, 'schema_version');
  const rubric_version = v.rubric_version === null ? null : string(v.rubric_version, 'rubric_version');
  const activity_results: ActivityResult[] = list(v.activity_results, 'activity_results').map((entry, i) => {
    const p = `activity_results[${i}]`;
    const a = object(entry, p);
    const activity_id = string(a.activity_id, `${p}.activity_id`);
    const r = object(a.result, `${p}.result`);
    switch (a.type) {
      case 'IMAGE_SORTING': return { activity_id, type: a.type, result: { child_order: strings(r.child_order, `${p}.child_order`), is_correct: bool(r.is_correct, `${p}.is_correct`) } };
      case 'STORY_NARRATION': return { activity_id, type: a.type, result: { completed: bool(r.completed, `${p}.completed`) } };
      case 'QUESTION_ANSWERING': {
        const answers: QuestionAnswer[] = list(r.answers, `${p}.answers`).map((entry, j) => {
          const p2 = `${p}.answers[${j}]`;
          const q = object(entry, p2);
          const question_id = string(q.question_id, `${p2}.question_id`);
          if (q.status === 'SKIPPED') {
            check(q.hint_used === false && q.before_hint === null && q.after_hint === null, p2);
            return { question_id, status: 'SKIPPED', hint_used: false, before_hint: null, after_hint: null };
          }
          check(q.status === 'ANSWERED', `${p2}.status`);
          const before_hint = attempt(q.before_hint, `${p2}.before_hint`, rubric_version);
          if (bool(q.hint_used, `${p2}.hint_used`)) {
            return { question_id, status: 'ANSWERED', hint_used: true, before_hint, after_hint: attempt(q.after_hint, `${p2}.after_hint`, rubric_version) };
          }
          check(q.after_hint === null, `${p2}.after_hint`);
          return { question_id, status: 'ANSWERED', hint_used: false, before_hint, after_hint: null };
        });
        unique(answers.map(q => q.question_id), `${p}.answers`);
        return { activity_id, type: a.type, result: { answers } };
      }
      default: throw new ContractError(`${p}.type`);
    }
  });
  unique(activity_results.map(a => a.activity_id), 'activity_results.activity_id');
  unique(activity_results.map(a => a.type), 'activity_results.type');
  return { schema_version: 2, rubric_version, activity_results };
}

function scoreItem(v: Record<string, unknown>, path: string): AIScoreItem {
  check(v.max_score === 2, `${path}.max_score`);
  return { score: v.score === null ? null : score(v.score, `${path}.score`), max_score: 2, reason: v.reason === null ? null : string(v.reason, `${path}.reason`), evidence: evidence(v.evidence, `${path}.evidence`) };
}

/** 解析存储模板或评分结果；成功响应另调用 assertAIScoreComplete 检查上下文。 */
export function parseAIScore(value: unknown): AIScore {
  const v = object(value, 'ai_score_json');
  check(v.schema_version === 2 && !('overall_score' in v), 'schema_version/overall_score');
  const macro = object(v.macrostructure, 'macrostructure');
  const micro = object(v.microstructure, 'microstructure');
  const meta = object(v.model_meta, 'model_meta');
  function dimensions(value: unknown, path: string) {
    const items = list(value, path).map((entry, i) => {
      const p = `${path}[${i}]`;
      const item = object(entry, p);
      return { ...scoreItem(item, p), item_code: string(item.item_code, `${p}.item_code`), item_name: string(item.item_name, `${p}.item_name`) };
    });
    unique(items.map(item => item.item_code), path);
    return items;
  }
  const content_items = list(macro.content_items, 'macrostructure.content_items').map((entry, i) => {
    const p = `macrostructure.content_items[${i}]`;
    const item = object(entry, p);
    return { ...scoreItem(item, p), content_item_id: string(item.content_item_id, `${p}.content_item_id`), rubric_item_code: string(item.rubric_item_code, `${p}.rubric_item_code`) };
  });
  unique(content_items.map(item => item.content_item_id), 'macrostructure.content_items');
  const productivity = object(micro.productivity, 'microstructure.productivity');
  check(productivity.item_code === 'NARRATIVE_PRODUCTIVITY', 'productivity.item_code');
  function metric(key: string, integer = true) {
    return productivity[key] === null ? null : number(productivity[key], `productivity.${key}`, integer);
  }
  return {
    schema_version: 2, rubric_version: string(v.rubric_version, 'rubric_version'), summary: nullableString(v.summary, 'summary'),
    macrostructure: { dimensions: dimensions(macro.dimensions, 'macrostructure.dimensions'), content_items },
    microstructure: {
      dimensions: dimensions(micro.dimensions, 'microstructure.dimensions'),
      productivity: { ...scoreItem(productivity, 'productivity'), item_code: 'NARRATIVE_PRODUCTIVITY', mean_c_unit_length: metric('mean_c_unit_length', false), adjective_count: metric('adjective_count'), adverb_count: metric('adverb_count'), conjunction_count: metric('conjunction_count') },
    },
    model_meta: { model: string(meta.model, 'model_meta.model'), prompt_version: string(meta.prompt_version, 'model_meta.prompt_version') },
  };
}

/** 仅检查叙述评分是否完整，不替代业务层的录音、活动、权限及教师确认校验。 */
export function assertAIScoreComplete(value: AIScore, config: ActivityConfig, transcript: string, rubricVersion: string): void {
  const v = parseAIScore(value);
  check(v.rubric_version === rubricVersion, 'rubric_version');
  const requiredMacro = ['EVENT_SEQUENCE', 'PLOT_STRUCTURE', 'THEME', 'COHERENCE', 'CAUSAL_LOGIC', 'DETAIL_EXPANSION'];
  const requiredMicro = ['VOCABULARY_DIVERSITY', 'MENTAL_STATE_WORDS', 'SYNTACTIC_COMPLEXITY', 'REFERENTIAL_COHESION', 'CONJUNCTION_COHESION'];
  for (const [items, required] of [[v.macrostructure.dimensions, requiredMacro], [v.microstructure.dimensions, requiredMicro]] as const) {
    check(items.length === required.length && required.every(code => items.some(item => item.item_code === code)), 'dimensions');
  }
  const narration = config.activities.find(a => a.type === 'STORY_NARRATION');
  check(narration !== undefined, 'STORY_NARRATION');
  const expected = narration.config.content_items;
  check(v.macrostructure.content_items.length === expected.length && expected.every(item => v.macrostructure.content_items.some(actual => actual.content_item_id === item.content_item_id && actual.rubric_item_code === item.rubric_item_code)), 'content_items');
  for (const item of [...v.macrostructure.dimensions, ...v.macrostructure.content_items, ...v.microstructure.dimensions, v.microstructure.productivity]) {
    check(item.score !== null && item.reason !== null, 'score/reason');
    checkEvidence(item.evidence, transcript, 'evidence');
  }
}

/** 无版本的空占位返回 null；部分填写仍保留，不自动补版本或分数。 */
export function parseScaleScores(value: unknown): ScaleScores | null {
  const v = object(value, 'scale_scores_json');
  check(v.schema_version === 1, 'schema_version');
  const entries = list(v.scores, 'scores');
  if (!('scale_version' in v) && entries.length === 0) return null;
  const scores = entries.map((entry, i) => {
    const p = `scores[${i}]`;
    const item = object(entry, p);
    const id = string(item.item_id, `${p}.item_id`);
    check(/^S(0[1-9]|10)$/.test(id), `${p}.item_id`);
    const value = number(item.value, `${p}.value`);
    check(value >= 1 && value <= 5, `${p}.value`);
    return { item_id: id as ScaleItemId, value: value as ScaleValue };
  });
  unique(scores.map(item => item.item_id), 'scores');
  return { schema_version: 1, scale_version: string(v.scale_version, 'scale_version'), scores };
}

/** 无恢复位置的 {} 返回 null，保留已完成活动但无当前位置的有效状态。 */
export function parseResumeState(value: unknown): ResumeState | null {
  const v = object(value, 'resume_state_json');
  if (Object.keys(v).length === 0) return null;
  check(v.schema_version === 1, 'schema_version');
  const current_activity_id = v.current_activity_id === null ? null : string(v.current_activity_id, 'current_activity_id');
  const current_item_id = v.current_item_id === null ? null : string(v.current_item_id, 'current_item_id');
  check(current_activity_id !== null || current_item_id === null, 'current_item_id');
  return { schema_version: 1, current_activity_id, current_item_id, completed_activity_ids: strings(v.completed_activity_ids, 'completed_activity_ids') };
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  ContractError, parseActivityConfig, parseActivityResults, parseAIScore,
  assertAIScoreComplete, parseScaleScores, parseResumeState,
} from '../src/shared/contracts/json/parse.ts';

// 直接使用正式技术方案中的五份 JSON，不另造一套可能漂移的协议样例。
const document = readFileSync(new URL('../docs/技术方案.md', import.meta.url), 'utf8');
const examples = [...document.matchAll(/```JSON\s*\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
const config = examples.find(value => 'activities' in value);
const results = examples.find(value => 'activity_results' in value);
const narrative = examples.find(value => 'macrostructure' in value && 'model_meta' in value);
const scale = examples.find(value => 'scores' in value);
const resume = examples.find(value => 'current_activity_id' in value);

test('五份文档样例可解析且字段不丢失', () => {
  for (const [parse, example] of [[parseActivityConfig, config], [parseActivityResults, results], [parseAIScore, narrative], [parseScaleScores, scale], [parseResumeState, resume]]) {
    assert.deepEqual(parse(example), example);
  }
  assert.equal(config.activities.find(a => a.type === 'STORY_NARRATION').config.content_items.length, 5);
});

test('空结果、量表占位和无恢复位置按各自协议解析', () => {
  const empty = { schema_version: 2, rubric_version: null, activity_results: [] };
  assert.deepEqual(parseActivityResults(empty), empty);
  assert.equal(parseScaleScores({ schema_version: 1, scores: [] }), null);
  assert.equal(parseResumeState({}), null);
  assert.deepEqual(parseResumeState({ ...resume, current_activity_id: null, current_item_id: null }), { ...resume, current_activity_id: null, current_item_id: null });
  assert.throws(() => parseScaleScores({ schema_version: 1, scores: [scale.scores[0]] }), ContractError);
});

function withAnswer(answer) {
  return { schema_version: 2, rubric_version: 'test-only', activity_results: [{ activity_id: 'test-qa', type: 'QUESTION_ANSWERING', result: { answers: [answer] } }] };
}

const skipped = { question_id: 'test-q', status: 'SKIPPED', hint_used: false, before_hint: null, after_hint: null };
const unconfirmed = { audio_file_code: null, transcript_text: null, ai_score: null };
const scored = value => ({ audio_file_code: null, transcript_text: '', ai_score: { rubric_version: 'test-only', score: value, max_score: 2, reason: '仅为合成测试结果。', evidence: [] } });

test('跳过、未确认、确认无回应、评分缺失各自保留', () => {
  for (const answer of [skipped, { question_id: 'test-q', status: 'ANSWERED', hint_used: false, before_hint: unconfirmed, after_hint: null }, { question_id: 'test-q', status: 'ANSWERED', hint_used: false, before_hint: scored(0), after_hint: null }]) {
    assert.deepEqual(parseActivityResults(withAnswer(answer)), withAnswer(answer));
  }
  assert.throws(() => parseActivityResults(withAnswer({ ...skipped, hint_used: true })), ContractError);
  assert.throws(() => parseActivityResults(withAnswer({ ...skipped, before_hint: unconfirmed })), ContractError);
});

test('提示后低分和待评分均保留，不用首次分兜底', () => {
  for (const after of [scored(0), unconfirmed]) {
    const value = withAnswer({ question_id: 'test-q', status: 'ANSWERED', hint_used: true, before_hint: scored(2), after_hint: after });
    assert.deepEqual(parseActivityResults(value), value);
  }
  assert.throws(() => parseActivityResults(withAnswer({ question_id: 'test-q', status: 'ANSWERED', hint_used: true, before_hint: scored(2), after_hint: null })), ContractError);
});

test('问答评分拒绝非法分数、未确认文本和不匹配版本', () => {
  for (const invalid of [scored(3), scored(0.5), { ...scored(0), transcript_text: null }, { ...scored(1), ai_score: { ...scored(1).ai_score, rubric_version: 'other' } }]) {
    assert.throws(() => parseActivityResults(withAnswer({ question_id: 'test-q', status: 'ANSWERED', hint_used: false, before_hint: invalid, after_hint: null })), ContractError);
  }
});

test('证据使用本次文本的 UTF-16 偏移，拒绝伪造引文', () => {
  const answer = scored(1);
  answer.transcript_text = '甲😀乙';
  answer.ai_score.evidence = [{ source: 'TRANSCRIPT', text: '😀', start_offset: 1, end_offset: 3 }];
  const value = withAnswer({ question_id: 'test-q', status: 'ANSWERED', hint_used: false, before_hint: answer, after_hint: null });
  assert.deepEqual(parseActivityResults(value), value);
  answer.ai_score.evidence[0].end_offset = 2;
  assert.throws(() => parseActivityResults(value), ContractError);
});

test('拒绝重复活动、重复语法、错误排序及旧评分 Schema', () => {
  const duplicate = structuredClone(config);
  duplicate.activities.push(duplicate.activities[0]);
  assert.throws(() => parseActivityConfig(duplicate), ContractError);
  const grammar = structuredClone(config);
  grammar.activities.find(a => a.type === 'QUESTION_ANSWERING').config.questions[0].grammar = ['same', 'same'];
  assert.throws(() => parseActivityConfig(grammar), ContractError);
  const sorting = structuredClone(config);
  sorting.activities.find(a => a.type === 'IMAGE_SORTING').config.correct_order[0] = 'external-item';
  assert.throws(() => parseActivityConfig(sorting), ContractError);
  assert.throws(() => parseAIScore({ ...narrative, schema_version: 1 }), ContractError);
  assert.throws(() => parseAIScore({ ...narrative, overall_score: 34 }), ContractError);
  assert.throws(() => parseScaleScores({ ...scale, scores: [scale.scores[0], scale.scores[0]] }), ContractError);
});

test('未评分叙述模板不能通过成功校验；全部条目、版本及分组必须匹配', () => {
  assert.throws(() => assertAIScoreComplete(narrative, config, '合成测试文本', narrative.rubric_version), ContractError);
  const complete = structuredClone(narrative);
  for (const item of [...complete.macrostructure.dimensions, ...complete.macrostructure.content_items, ...complete.microstructure.dimensions, complete.microstructure.productivity]) {
    item.score = 1;
    item.reason = '仅为合成测试结果。';
  }
  assert.doesNotThrow(() => assertAIScoreComplete(complete, config, '合成测试文本', complete.rubric_version));
  assert.throws(() => assertAIScoreComplete(complete, config, '合成测试文本', 'different'), ContractError);
  complete.macrostructure.content_items[1].rubric_item_code = 'NARRATIVE_CONTENT_01';
  assert.throws(() => assertAIScoreComplete(complete, config, '合成测试文本', complete.rubric_version), ContractError);
});

test('初始化 SQL 可重跑，字段和 JSON 默认值与文档一致', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sql = readFileSync(new URL('../src/infrastructure/database/migrations/001_initial_sqlite.sql', import.meta.url), 'utf8');
    db.exec(sql);
    db.exec(sql);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n, 18);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA table_info(storage_local_file)').all().some(c => c.name === 'DELETED'), false);
    for (const table of ['assessment', 'course_instance']) {
      const column = db.prepare(`PRAGMA table_info(${table})`).all().find(c => c.name === 'activity_results_json');
      assert.deepEqual(parseActivityResults(JSON.parse(column.dflt_value.slice(1, -1))), { schema_version: 2, rubric_version: null, activity_results: [] });
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM question_bank').get().n, 3);
    assert.doesNotMatch(db.prepare("SELECT config_hint FROM question_bank WHERE type_code='QUESTION_ANSWERING'").get().config_hint, /每个分值/);
  } finally {
    db.close();
  }
});

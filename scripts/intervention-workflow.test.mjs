import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Database } from '../src/infrastructure/database/database.ts';
import { initialMigration } from '../src/infrastructure/database/migrate.ts';
import { parseLocalId } from '../src/shared/contracts/index.ts';
import { PlanRepository, PlanService } from '../src/modules/plans/index.ts';
import { CourseProgressRepository, CourseProgressService } from '../src/modules/course-progress/index.ts';
import { ClassroomRepository, ClassroomService } from '../src/modules/classroom/index.ts';

const initial = initialMigration(readFileSync(new URL('../src/infrastructure/database/migrations/001_initial_sqlite.sql', import.meta.url), 'utf8'));
const fixedTime = new Date('2026-09-23T12:00:00.000Z');

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'early-learning-intervention-test-'));
  const path = join(folder, 'test.sqlite');
  let native;
  const driver = {
    async open() { native ??= new DatabaseSync(path); },
    async close() { native?.close(); native = undefined; },
    async execute(sql) { native.exec(sql); },
    async query(sql, values = []) { return native.prepare(sql).all(...values).map(row => ({ ...row })); },
    async run(sql, values = []) {
      const result = native.prepare(sql).run(...values);
      return { changes: Number(result.changes), lastInsertId: Number(result.lastInsertRowid) };
    },
    async begin() { native.exec('BEGIN IMMEDIATE;'); },
    async commit() { native.exec('COMMIT;'); },
    async rollback() { if (native.isTransaction) native.exec('ROLLBACK;'); },
  };
  t.after(async () => {
    await driver.close();
    rmSync(path, { force: true });
    rmdirSync(folder);
  });
  return new Database(driver, [initial]);
}

const config = {
  schema_version: 2,
  story_context: '合成测试故事，不含真实儿童信息。',
  activities: [
    {
      activity_id: 'sort', type: 'IMAGE_SORTING',
      config: { items: [{ item_id: 'i1', file_code: 'FILE_I1' }, { item_id: 'i2', file_code: 'FILE_I2' }], correct_order: ['i1', 'i2'] },
    },
    {
      activity_id: 'qa', type: 'QUESTION_ANSWERING',
      config: { questions: [{ question_id: 'q1', text: '合成问题', hint: '合成提示', grammar: [] }] },
    },
    {
      activity_id: 'story', type: 'STORY_NARRATION',
      config: { audio_file_code: 'FILE_PROMPT', content_items: [{ content_item_id: 'c1', image_file_codes: ['FILE_I1'], rubric_item_code: 'CONTENT_1' }] },
    },
  ],
};

const collected = {
  schema_version: 2,
  rubric_version: null,
  activity_results: [
    { activity_id: 'sort', type: 'IMAGE_SORTING', result: { child_order: ['i1', 'i2'], is_correct: true } },
    {
      activity_id: 'qa', type: 'QUESTION_ANSWERING', result: { answers: [{
        question_id: 'q1', status: 'ANSWERED', hint_used: true,
        before_hint: { audio_file_code: null, transcript_text: '提示前合成回答', ai_score: null },
        after_hint: { audio_file_code: null, transcript_text: '提示后合成回答', ai_score: null },
      }] },
    },
    { activity_id: 'story', type: 'STORY_NARRATION', result: { completed: true } },
  ],
};

function storyScore(transcript) {
  const item = (item_code, item_name) => ({ item_code, item_name, score: 1, max_score: 2, reason: '合成理由', evidence: [] });
  return {
    schema_version: 2,
    rubric_version: 'rubric-v1',
    summary: '合成摘要',
    macrostructure: {
      dimensions: [
        item('EVENT_SEQUENCE', '事件顺序'), item('PLOT_STRUCTURE', '情节结构'), item('THEME', '主题体现'),
        item('COHERENCE', '故事连贯性'), item('CAUSAL_LOGIC', '因果逻辑'), item('DETAIL_EXPANSION', '细节拓展'),
      ],
      content_items: [{ content_item_id: 'c1', rubric_item_code: 'CONTENT_1', score: 1, max_score: 2, reason: '合成理由', evidence: [] }],
    },
    microstructure: {
      dimensions: [
        item('VOCABULARY_DIVERSITY', '词汇丰富度'), item('MENTAL_STATE_WORDS', '心理状态词'),
        item('SYNTACTIC_COMPLEXITY', '句法复杂度'), item('REFERENTIAL_COHESION', '指称衔接'),
        item('CONJUNCTION_COHESION', '连词衔接'),
      ],
      productivity: {
        item_code: 'NARRATIVE_PRODUCTIVITY', mean_c_unit_length: 1, adjective_count: 0, adverb_count: 0,
        conjunction_count: 0, score: 1, max_score: 2, reason: `合成理由:${transcript.length}`, evidence: [],
      },
    },
    model_meta: { model: 'synthetic-model', prompt_version: 'synthetic-prompt' },
  };
}

async function seed(db, { group = false, secondCourse = false } = {}) {
  return db.transaction(async tx => {
    const account = await tx.run('INSERT INTO user_local_account (username, password_hash) VALUES (?, ?)', ['teacher', 'synthetic-hash']);
    const child = await tx.run("INSERT INTO case_info (full_name, birth_date, sex, guardian_phone, guardian_name, child_code, teacher_id, status) VALUES (?, ?, 'UNKNOWN', ?, ?, ?, ?, 'PRETEST_DONE')", ['合成儿童', '2020-01-01', '000', '合成监护人', 'SYNTHETIC-1', account.lastInsertId]);
    const course = await tx.run("INSERT INTO course (source, official_course_code, content_version, name, activity_configs_json, status) VALUES ('PRIVATE', null, null, ?, ?, 'ACTIVE')", ['合成课程', JSON.stringify(config)]);
    let course2 = null;
    if (secondCourse) course2 = (await tx.run("INSERT INTO course (source, official_course_code, content_version, name, activity_configs_json, status) VALUES ('PRIVATE', null, null, ?, ?, 'ACTIVE')", ['合成课程二', JSON.stringify(config)])).lastInsertId;
    const file = await tx.run("INSERT INTO storage_local_file (file_code, file_name, relative_path, file_kind, mime_type, size_bytes) VALUES (?, ?, ?, 'AUDIO', ?, ?)", ['AUDIO_SYNTHETIC', 'synthetic.wav', 'audio/synthetic.wav', 'audio/wav', 1]);
    let groupId = null;
    if (group) {
      groupId = (await tx.run("INSERT INTO group_info (name, status) VALUES (?, 'ACTIVE')", ['合成小组'])).lastInsertId;
      await tx.run('INSERT INTO group_member (group_id, case_id) VALUES (?, ?)', [groupId, child.lastInsertId]);
    }
    return {
      caseId: parseLocalId(child.lastInsertId), courseId: parseLocalId(course.lastInsertId),
      secondCourseId: course2 === null ? null : parseLocalId(course2), fileId: parseLocalId(file.lastInsertId),
      groupId: groupId === null ? null : parseLocalId(groupId),
    };
  });
}

function services(db, statistics = { calls: 0 }) {
  const planRepository = new PlanRepository();
  const progressRepository = new CourseProgressRepository();
  const classroomRepository = new ClassroomRepository();
  let planService;
  let classroomService;
  const progressService = new CourseProgressService(
    db,
    progressRepository,
    { checkCompletion: (...args) => planService.checkCompletion(...args) },
    { assertValidForProgress: (...args) => classroomService.assertValidForProgress(...args) },
    () => fixedTime,
  );
  planService = new PlanService(
    db,
    planRepository,
    progressService,
    {
      async advanceToIntervention(tx, caseId) {
        await tx.run("UPDATE case_info SET status = 'INTERVENTION' WHERE id = ? AND status = 'PRETEST_DONE'", [caseId]);
      },
    },
    {
      async assertSelectable(reader, courseId) {
        const rows = await reader.query("SELECT id FROM course WHERE id = ? AND status = 'ACTIVE'", [courseId]);
        if (!rows[0]) throw new Error('course unavailable');
      },
    },
    () => fixedTime,
  );
  classroomService = new ClassroomService(
    db,
    classroomRepository,
    progressService,
    {
      async recordCompletedClassroom(tx, classroomId) {
        statistics.calls += 1;
        const rows = await tx.query('SELECT ccp.case_id FROM course_instance ci JOIN course_case_progress ccp ON ccp.id = ci.progress_id WHERE ci.id = ? AND ci.status = ?', [classroomId, 'COMPLETED']);
        assert.equal(rows.length, 1);
        if (statistics.fail) throw new Error('synthetic statistics failure');
      },
    },
    planService,
    {
      async assertReadyAudioFile(reader, fileId) {
        const rows = await reader.query("SELECT id FROM storage_local_file WHERE id = ? AND file_kind = 'AUDIO' AND status = 'READY'", [fileId]);
        if (!rows[0]) throw new Error('audio unavailable');
      },
      async assertReadyAudioCodes(reader, fileCodes) {
        for (const fileCode of fileCodes) {
          const rows = await reader.query("SELECT id FROM storage_local_file WHERE file_code = ? AND file_kind = 'AUDIO' AND status = 'READY'", [fileCode]);
          if (!rows[0]) throw new Error('audio unavailable');
        }
      },
    },
    () => fixedTime,
  );
  return { planService, progressService, classroomService };
}

async function makeClassroomReady(classroomService, classroomId, fileId) {
  await classroomService.saveActivityResults(classroomId, collected);
  await classroomService.saveNarration(classroomId, fileId, '合成故事回答');
  await assert.rejects(
    classroomService.saveQuestionScore(classroomId, 'qa', 'q1', 'before_hint', '已过期回答', { rubric_version: 'rubric-v1', score: 2, max_score: 2, reason: '合成理由', evidence: [] }),
    { code: 'STALE_AI_RESULT' },
  );
  await classroomService.saveQuestionScore(classroomId, 'qa', 'q1', 'before_hint', '提示前合成回答', { rubric_version: 'rubric-v1', score: 2, max_score: 2, reason: '合成理由', evidence: [] });
  await classroomService.saveQuestionScore(classroomId, 'qa', 'q1', 'after_hint', '提示后合成回答', { rubric_version: 'rubric-v1', score: 1, max_score: 2, reason: '合成理由', evidence: [] });
  await classroomService.saveStoryScore(classroomId, '合成故事回答', storyScore('合成故事回答'));
  await classroomService.saveScaleScores(classroomId, {
    schema_version: 1, scale_version: 'v1',
    scores: Array.from({ length: 10 }, (_, index) => ({ item_id: `S${String(index + 1).padStart(2, '0')}`, value: 3 })),
  });
  await classroomService.markPendingAi(classroomId);
}

test('个人计划仅在草稿期编排，激活原子生成进度并推进个案阶段', async t => {
  const db = fixture(t);
  const seeded = await seed(db, { secondCourse: true });
  const { planService } = services(db);
  const planId = await planService.create({ planType: 'INDIVIDUAL', caseId: seeded.caseId, name: ' 合成计划 ' });
  const first = await planService.addCourse(planId, seeded.courseId, 1);
  const second = await planService.addCourse(planId, seeded.secondCourseId, 2);
  await planService.reorderCourses(planId, [second, first]);
  await planService.activate(planId);
  await assert.rejects(planService.addCourse(planId, seeded.courseId, 3), { code: 'PLAN_NOT_EDITABLE' });
  const state = await db.read(async reader => ({
    plan: await reader.query('SELECT name, status FROM plan WHERE id = ?', [planId]),
    progress: await reader.query('SELECT status FROM course_case_progress WHERE case_id = ? ORDER BY id', [seeded.caseId]),
    child: await reader.query('SELECT status FROM case_info WHERE id = ?', [seeded.caseId]),
  }));
  assert.deepEqual(state.plan, [{ name: '合成计划', status: 'ACTIVE' }]);
  assert.deepEqual(state.progress, [{ status: 'PENDING' }, { status: 'PENDING' }]);
  assert.deepEqual(state.child, [{ status: 'INTERVENTION' }]);
  await planService.cancel(planId);
  assert.deepEqual(await db.read(r => r.query('SELECT status FROM course_case_progress WHERE case_id = ?', [seeded.caseId])), [{ status: 'STOPPED' }, { status: 'STOPPED' }]);
});

test('课堂完整校验后一次性完成课堂、进度、统计和计划，提示后低分被保留', async t => {
  const db = fixture(t);
  const seeded = await seed(db);
  const statistics = { calls: 0 };
  const { planService, classroomService } = services(db, statistics);
  const planId = await planService.create({ planType: 'INDIVIDUAL', caseId: seeded.caseId, name: '课堂计划' });
  await planService.addCourse(planId, seeded.courseId, 1);
  await planService.activate(planId);
  const progressId = parseLocalId((await db.read(r => r.query('SELECT id FROM course_case_progress WHERE case_id = ?', [seeded.caseId])))[0].id);
  const classroomId = await classroomService.createOrResume(progressId);
  assert.equal(await classroomService.createOrResume(progressId), classroomId);
  await makeClassroomReady(classroomService, classroomId, seeded.fileId);
  await classroomService.complete(classroomId);
  await classroomService.complete(classroomId);
  assert.equal(statistics.calls, 1);
  const result = await classroomService.get(classroomId);
  const qa = result.activityResults.activity_results.find(item => item.type === 'QUESTION_ANSWERING');
  assert.equal(qa.result.answers[0].before_hint.ai_score.score, 2);
  assert.equal(qa.result.answers[0].after_hint.ai_score.score, 1);
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(await db.read(r => r.query('SELECT status FROM course_case_progress WHERE id = ?', [progressId])), [{ status: 'COMPLETED' }]);
  assert.deepEqual(await db.read(r => r.query('SELECT status, completed_at FROM plan WHERE id = ?', [planId])), [{ status: 'COMPLETED', completed_at: fixedTime.toISOString() }]);
  await assert.rejects(classroomService.void(classroomId, '不应允许'), { code: 'CLASSROOM_COMPLETED' });
});

test('统计更新失败时课堂、进度和计划完成状态在同一事务回滚', async t => {
  const db = fixture(t);
  const seeded = await seed(db);
  const statistics = { calls: 0, fail: true };
  const { planService, classroomService } = services(db, statistics);
  const planId = await planService.create({ planType: 'INDIVIDUAL', caseId: seeded.caseId, name: '回滚计划' });
  await planService.addCourse(planId, seeded.courseId, 1);
  await planService.activate(planId);
  const progressId = parseLocalId((await db.read(r => r.query('SELECT id FROM course_case_progress WHERE case_id = ?', [seeded.caseId])))[0].id);
  const classroomId = await classroomService.createOrResume(progressId);
  await makeClassroomReady(classroomService, classroomId, seeded.fileId);
  await assert.rejects(classroomService.complete(classroomId), /synthetic statistics failure/);
  assert.deepEqual(await db.read(r => r.query('SELECT status, completed_at FROM course_instance WHERE id = ?', [classroomId])), [{ status: 'PENDING_AI', completed_at: null }]);
  assert.deepEqual(await db.read(r => r.query('SELECT status, completed_at FROM course_case_progress WHERE id = ?', [progressId])), [{ status: 'IN_PROGRESS', completed_at: null }]);
  assert.deepEqual(await db.read(r => r.query('SELECT status, completed_at FROM plan WHERE id = ?', [planId])), [{ status: 'ACTIVE', completed_at: null }]);
});

test('小组成员移出停止进度且保留课堂，重新加入活动计划后恢复原课堂', async t => {
  const db = fixture(t);
  const seeded = await seed(db, { group: true });
  const { planService, progressService, classroomService } = services(db);
  const planId = await planService.create({ planType: 'GROUP', groupId: seeded.groupId, name: '小组计划' });
  await planService.addCourse(planId, seeded.courseId, 1);
  await planService.activate(planId);
  const progressId = parseLocalId((await db.read(r => r.query('SELECT id FROM course_case_progress WHERE case_id = ?', [seeded.caseId])))[0].id);
  const classroomId = await classroomService.createOrResume(progressId);
  await db.transaction(async tx => {
    await tx.run('DELETE FROM group_member WHERE group_id = ? AND case_id = ?', [seeded.groupId, seeded.caseId]);
    await progressService.onGroupMemberRemoved(tx, seeded.groupId, seeded.caseId, fixedTime.toISOString());
  });
  assert.deepEqual(await db.read(r => r.query('SELECT status FROM plan WHERE id = ?', [planId])), [{ status: 'ACTIVE' }]);
  assert.deepEqual(await db.read(r => r.query('SELECT status FROM course_case_progress WHERE id = ?', [progressId])), [{ status: 'STOPPED' }]);
  await assert.rejects(classroomService.saveActivityResults(classroomId, collected), { code: 'CLASSROOM_PARTICIPATION_STOPPED' });
  const restored = await db.transaction(async tx => {
    await tx.run('INSERT INTO group_member (group_id, case_id) VALUES (?, ?)', [seeded.groupId, seeded.caseId]);
    return progressService.onGroupMemberAdded(tx, seeded.groupId, seeded.caseId, fixedTime.toISOString());
  });
  assert.deepEqual(restored, [{ progressId, unfinishedClassroomId: classroomId }]);
  assert.equal(await classroomService.createOrResume(progressId), classroomId);
});

test('作废未完成课堂按参与条件恢复进度并清空恢复位置', async t => {
  const db = fixture(t);
  const seeded = await seed(db);
  const { planService, progressService, classroomService } = services(db);
  const planId = await planService.create({ planType: 'INDIVIDUAL', caseId: seeded.caseId, name: '作废测试' });
  await planService.addCourse(planId, seeded.courseId, 1);
  await planService.activate(planId);
  const progressId = parseLocalId((await db.read(r => r.query('SELECT id FROM course_case_progress WHERE case_id = ?', [seeded.caseId])))[0].id);
  const classroomId = await classroomService.createOrResume(progressId);
  await progressService.saveResumeState(progressId, { schema_version: 1, current_activity_id: 'qa', current_item_id: 'q1', completed_activity_ids: ['sort'] });
  assert.equal(await classroomService.void(classroomId, '合成作废原因'), 'PENDING');
  assert.deepEqual(await db.read(r => r.query('SELECT status, resume_state_json FROM course_case_progress WHERE id = ?', [progressId])), [{ status: 'PENDING', resume_state_json: '{}' }]);
});

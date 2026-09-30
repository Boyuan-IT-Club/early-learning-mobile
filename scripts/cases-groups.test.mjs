import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Database } from '../src/infrastructure/database/database.ts';
import { initialMigration } from '../src/infrastructure/database/migrate.ts';
import { parseLocalId } from '../src/shared/contracts/index.ts';
import { PlanRepository, PlanService, PlanTransferService } from '../src/modules/plans/index.ts';
import { CourseProgressRepository, CourseProgressService } from '../src/modules/course-progress/index.ts';
import { ClassroomRepository, ClassroomService } from '../src/modules/classroom/index.ts';
import { CaseRepository, CaseService } from '../src/modules/cases/index.ts';
import { GroupRepository, GroupService } from '../src/modules/groups/index.ts';

const initial = initialMigration(readFileSync(new URL('../src/infrastructure/database/migrations/001_initial_sqlite.sql', import.meta.url), 'utf8'));
const fixedTime = new Date('2026-09-30T08:00:00.000Z');
const at = fixedTime.toISOString();

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'early-learning-cases-groups-test-'));
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
      activity_id: 'story', type: 'STORY_NARRATION',
      config: { audio_file_code: 'FILE_PROMPT', content_items: [{ content_item_id: 'c1', image_file_codes: ['FILE_I1'], rubric_item_code: 'CONTENT_1' }] },
    },
  ],
};

async function seed(db) {
  return db.transaction(async tx => {
    const account = await tx.run('INSERT INTO user_local_account (username, password_hash) VALUES (?, ?)', ['teacher', 'synthetic-hash']);
    const course = await tx.run("INSERT INTO course (source, official_course_code, content_version, name, activity_configs_json, status) VALUES ('PRIVATE', null, null, ?, ?, 'ACTIVE')", ['合成课程', JSON.stringify(config)]);
    const grammar = await tx.run('INSERT INTO grammar (grammar_code, name, version) VALUES (?, ?, 1)', ['G-1', '勇气']);
    const file = await tx.run("INSERT INTO storage_local_file (file_code, file_name, relative_path, file_kind, mime_type, size_bytes) VALUES (?, ?, ?, 'AUDIO', 'audio/wav', 1)", ['AUDIO_SYN', 'synthetic.wav', 'audio/synthetic.wav']);
    return {
      teacherId: parseLocalId(account.lastInsertId),
      courseId: parseLocalId(course.lastInsertId),
      grammarId: parseLocalId(grammar.lastInsertId),
      fileId: parseLocalId(file.lastInsertId),
    };
  });
}

function services(db) {
  const planRepository = new PlanRepository();
  const progressRepository = new CourseProgressRepository();
  const classroomRepository = new ClassroomRepository();
  const caseService = new CaseService(db, new CaseRepository(), () => fixedTime);
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
    { advanceToIntervention: (tx, caseId, at0) => caseService.advanceToIntervention(tx, caseId, at0) },
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
    { async recordCompletedClassroom() {} },
    planService,
    { async assertReadyAudioFile() {}, async assertReadyAudioCodes() {} },
    () => fixedTime,
  );
  const transferService = new PlanTransferService(planRepository, progressService, classroomService);
  const groupService = new GroupService(
    db,
    new GroupRepository(),
    {
      addMember: (tx, groupId, caseId, at0) => progressService.onGroupMemberAdded(tx, groupId, caseId, at0),
      removeMember: (tx, groupId, caseId, at0) => progressService.onGroupMemberRemoved(tx, groupId, caseId, at0),
    },
    transferService,
    () => fixedTime,
  );
  return { caseService, planService, progressService, classroomService, transferService, groupService };
}

async function createCase(caseService, teacherId, childCode) {
  return caseService.create({
    fullName: ' 合成儿童 ', birthDate: '2020-01-01', sex: 'UNKNOWN',
    guardianPhone: '000-0000', guardianName: ' 合成监护人 ', childCode, teacherId,
  });
}

test('个案建档拒绝重复编号，编辑只改资料，结案后只读且状态不回退', async t => {
  const db = fixture(t);
  const seeded = await seed(db);
  const { caseService, planService } = services(db);
  const caseId = await createCase(caseService, seeded.teacherId, 'C-001');
  await assert.rejects(createCase(caseService, seeded.teacherId, 'C-001'), { code: 'CASE_CHILD_CODE_EXISTS' });

  let info = await caseService.get(caseId);
  assert.equal(info.fullName, '合成儿童');
  assert.equal(info.guardianName, '合成监护人');
  assert.equal(info.status, 'INTAKE_DONE');

  await db.transaction(tx => caseService.advanceToPretestDone(tx, caseId, at));
  assert.equal((await caseService.get(caseId)).status, 'PRETEST_DONE');

  await caseService.update(caseId, { fullName: '改名儿童', birthDate: '2020-02-02', sex: 'FEMALE', guardianPhone: '111', guardianName: '新监护人' });
  assert.equal((await caseService.get(caseId)).fullName, '改名儿童');

  const planId = await planService.create({ planType: 'INDIVIDUAL', caseId, name: '干预计划' });
  await planService.addCourse(planId, seeded.courseId, 1);
  await planService.activate(planId);
  assert.equal((await caseService.get(caseId)).status, 'INTERVENTION');

  await db.transaction(tx => caseService.advanceToPretestDone(tx, caseId, at));
  assert.equal((await caseService.get(caseId)).status, 'INTERVENTION');

  const closed = await caseService.close(caseId);
  assert.equal(closed.status, 'CLOSED');
  await assert.rejects(caseService.update(caseId, { fullName: 'x', birthDate: '2020-01-01', sex: 'MALE', guardianPhone: '1', guardianName: 'y' }), { code: 'CASE_CLOSED' });
  await assert.rejects(caseService.close(caseId), { code: 'CASE_ALREADY_CLOSED' });
});

test('个案详情读取统计缓存、课程历史与个案计划，不自行计算', async t => {
  const db = fixture(t);
  const seeded = await seed(db);
  const { caseService, planService, classroomService } = services(db);
  const caseId = await createCase(caseService, seeded.teacherId, 'C-002');
  const planId = await planService.create({ planType: 'INDIVIDUAL', caseId, name: '个案计划' });
  await planService.addCourse(planId, seeded.courseId, 1);
  await planService.activate(planId);
  const progressId = parseLocalId((await db.read(r => r.query('SELECT id FROM course_case_progress WHERE case_id = ?', [caseId])))[0].id);
  await classroomService.createOrResume(progressId);
  await db.transaction(async tx => {
    await tx.run('INSERT INTO case_progress_stats (case_id, lesson_count, answer_num, before_hint_score_sum, final_score_sum) VALUES (?, 3, 4, 5, 6)', [caseId]);
    await tx.run('INSERT INTO case_grammar_stats (case_id, grammar_id, total_num, before_hint_score_sum, final_score_sum) VALUES (?, ?, 4, 5, 6)', [caseId, seeded.grammarId]);
  });

  const detail = await caseService.detail(caseId);
  assert.equal(detail.info.id, caseId);
  assert.deepEqual(detail.progressStats, { lessonCount: 3, answerNum: 4, beforeHintScoreSum: 5, finalScoreSum: 6 });
  assert.equal(detail.grammarStats.length, 1);
  assert.equal(detail.grammarStats[0].grammarName, '勇气');
  assert.equal(detail.courseHistory.length, 1);
  assert.equal(detail.courseHistory[0].progressStatus, 'IN_PROGRESS');
  assert.equal(detail.courseHistory[0].resumable, true);
  assert.equal(detail.casePlans.length, 1);
  assert.equal(detail.casePlans[0].planId, planId);
  assert.equal(detail.casePlans[0].status, 'ACTIVE');
  assert.equal(detail.casePlans[0].courseCount, 1);
});

test('移出成员复制小组计划为个案计划并停止小组进度，重新加入恢复原课堂', async t => {
  const db = fixture(t);
  const seeded = await seed(db);
  const { caseService, planService, classroomService, groupService } = services(db);
  const caseId = await createCase(caseService, seeded.teacherId, 'C-003');
  const groupId = await groupService.create({ name: ' 合成小组 ', remark: '  备注 ' });
  assert.deepEqual(await groupService.listMembers(groupId), []);

  await groupService.addMember(groupId, caseId);
  await assert.rejects(groupService.addMember(groupId, caseId), { code: 'GROUP_MEMBER_EXISTS' });
  assert.equal((await groupService.listMembers(groupId))[0].childCode, 'C-003');

  const planId = await planService.create({ planType: 'GROUP', groupId, name: '小组计划' });
  await planService.addCourse(planId, seeded.courseId, 1);
  await planService.activate(planId);
  const progressId = parseLocalId((await db.read(r => r.query('SELECT id FROM course_case_progress WHERE case_id = ?', [caseId])))[0].id);
  const classroomId = await classroomService.createOrResume(progressId);

  const copiedPlanIds = await groupService.removeMember(groupId, caseId);
  assert.equal(copiedPlanIds.length, 1);
  await assert.rejects(groupService.removeMember(groupId, caseId), { code: 'GROUP_MEMBER_NOT_FOUND' });
  assert.deepEqual(await groupService.listMembers(groupId), []);

  assert.deepEqual(await db.read(r => r.query('SELECT status FROM course_case_progress WHERE id = ?', [progressId])), [{ status: 'STOPPED' }]);
  assert.deepEqual(await db.read(r => r.query('SELECT status FROM plan WHERE id = ?', [copiedPlanIds[0]])), [{ status: 'DRAFT' }]);
  const copied = await db.read(r => r.query('SELECT ccp.status, ci.status AS classroom_status FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id LEFT JOIN course_instance ci ON ci.progress_id = ccp.id WHERE pc.plan_id = ? AND ccp.case_id = ?', [copiedPlanIds[0], caseId]));
  assert.deepEqual(copied, [{ status: 'IN_PROGRESS', classroom_status: 'DRAFT' }]);

  const restored = await groupService.rejoinMember(groupId, caseId);
  assert.deepEqual(restored, [{ progressId, unfinishedClassroomId: classroomId }]);
  assert.deepEqual(await db.read(r => r.query('SELECT status FROM course_case_progress WHERE id = ?', [progressId])), [{ status: 'IN_PROGRESS' }]);
  const copiedAfter = await db.read(r => r.query('SELECT ccp.status FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id WHERE pc.plan_id = ? AND ccp.case_id = ?', [copiedPlanIds[0], caseId]));
  assert.deepEqual(copiedAfter, [{ status: 'IN_PROGRESS' }]);
});

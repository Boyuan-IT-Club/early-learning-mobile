import type { DatabaseReader, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import {
  AppError, parseDateOnly, parseLocalId,
  type CaseStatus, type ClassroomStatus, type CourseProgressStatus, type PlanStatus, type PlanType, type Sex,
} from '../../../shared/contracts/index.ts';
import type {
  CaseCourseHistoryItem, CaseGrammarStats, CaseId, CaseInfo, CasePlanSummary, CaseProgressStats,
  CreateCaseInput, UpdateCaseInput,
} from '../types.ts';

const CASE_STATUSES = new Set(['INTAKE_DONE', 'PRETEST_DONE', 'INTERVENTION', 'CLOSED']);
const SEXES = new Set(['MALE', 'FEMALE', 'UNKNOWN']);
const PLAN_TYPES = new Set(['INDIVIDUAL', 'GROUP']);
const PLAN_STATUSES = new Set(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']);
const PROGRESS_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'STOPPED']);
const CLASSROOM_STATUSES = new Set(['DRAFT', 'IN_PROGRESS', 'PENDING_AI', 'COMPLETED', 'VOID']);

const CASE_COLUMNS = 'id, full_name, birth_date, sex, guardian_phone, guardian_name, child_code, teacher_id, status, created_at, updated_at';

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_DATABASE_RESULT', `个案数据字段 ${field} 无效。`);
  return value;
}

function count(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new AppError('INVALID_DATABASE_RESULT', `个案数据字段 ${field} 无效。`);
  return parsed;
}

function nullableText(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : text(value, field);
}

function parseCase(row: Record<string, unknown>): CaseInfo {
  const status = text(row.status, 'status');
  const sex = text(row.sex, 'sex');
  if (!CASE_STATUSES.has(status) || !SEXES.has(sex)) throw new AppError('INVALID_DATABASE_RESULT', '个案状态数据无效。');
  return {
    id: parseLocalId<'case_info'>(row.id),
    fullName: text(row.full_name, 'full_name'),
    birthDate: parseDateOnly(row.birth_date),
    sex: sex as Sex,
    guardianPhone: text(row.guardian_phone, 'guardian_phone'),
    guardianName: text(row.guardian_name, 'guardian_name'),
    childCode: text(row.child_code, 'child_code'),
    teacherId: parseLocalId<'user_local_account'>(row.teacher_id),
    status: status as CaseStatus,
    createdAt: text(row.created_at, 'created_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
  };
}

function parseHistory(row: Record<string, unknown>): CaseCourseHistoryItem {
  const planType = text(row.plan_type, 'plan_type');
  const progressStatus = text(row.progress_status, 'progress_status');
  if (!PLAN_TYPES.has(planType) || !PROGRESS_STATUSES.has(progressStatus)) {
    throw new AppError('INVALID_DATABASE_RESULT', '课程历史状态数据无效。');
  }
  const classroomStatus = nullableText(row.classroom_status, 'classroom_status');
  if (classroomStatus !== null && !CLASSROOM_STATUSES.has(classroomStatus)) {
    throw new AppError('INVALID_DATABASE_RESULT', '课程历史课堂状态无效。');
  }
  return {
    planId: parseLocalId<'plan'>(row.plan_id),
    planType: planType as PlanType,
    planName: text(row.plan_name, 'plan_name'),
    planCourseId: parseLocalId<'plan_course'>(row.plan_course_id),
    courseId: parseLocalId<'course'>(row.course_id),
    courseName: text(row.course_name, 'course_name'),
    sequenceNo: count(row.sequence_no, 'sequence_no'),
    progressId: parseLocalId<'course_case_progress'>(row.progress_id),
    progressStatus: progressStatus as CourseProgressStatus,
    classroomId: row.classroom_id === null || row.classroom_id === undefined ? null : parseLocalId<'course_instance'>(row.classroom_id),
    classroomStatus: classroomStatus as ClassroomStatus | null,
    classroomCompletedAt: nullableText(row.classroom_completed_at, 'classroom_completed_at'),
    resumable: classroomStatus !== null && classroomStatus !== 'COMPLETED',
  };
}

export class CaseRepository {
  async findById(reader: DatabaseReader, caseId: CaseId): Promise<CaseInfo | null> {
    const rows = await reader.query(`SELECT ${CASE_COLUMNS} FROM case_info WHERE id = ?`, [caseId]);
    return rows[0] ? parseCase(rows[0]) : null;
  }

  async findByChildCode(reader: DatabaseReader, childCode: string): Promise<CaseInfo | null> {
    const rows = await reader.query(`SELECT ${CASE_COLUMNS} FROM case_info WHERE child_code = ?`, [childCode]);
    return rows[0] ? parseCase(rows[0]) : null;
  }

  /** 列表按建档时间倒序，结案周期作为历史记录一并返回，由展示层区分。 */
  async list(reader: DatabaseReader): Promise<CaseInfo[]> {
    const rows = await reader.query(`SELECT ${CASE_COLUMNS} FROM case_info ORDER BY created_at DESC, id DESC`);
    return rows.map(parseCase);
  }

  /** 初始状态固定为 INTAKE_DONE，不接受客户端传入其他状态。 */
  async create(tx: DatabaseTransaction, input: CreateCaseInput, at: string): Promise<CaseId> {
    const result = await tx.run(
      "INSERT INTO case_info (full_name, birth_date, sex, guardian_phone, guardian_name, child_code, teacher_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'INTAKE_DONE', ?, ?)",
      [input.fullName, input.birthDate, input.sex, input.guardianPhone, input.guardianName, input.childCode, input.teacherId, at, at],
    );
    return parseLocalId<'case_info'>(result.lastInsertId);
  }

  async update(tx: DatabaseTransaction, caseId: CaseId, input: UpdateCaseInput, at: string): Promise<boolean> {
    const result = await tx.run(
      "UPDATE case_info SET full_name = ?, birth_date = ?, sex = ?, guardian_phone = ?, guardian_name = ?, updated_at = ? WHERE id = ? AND status <> 'CLOSED'",
      [input.fullName, input.birthDate, input.sex, input.guardianPhone, input.guardianName, at, caseId],
    );
    return result.changes === 1;
  }

  /** 只在给定的前置状态内推进，保证状态机不回退、不接受客户端直接赋值。 */
  async updateStatusIf(tx: DatabaseTransaction, caseId: CaseId, from: readonly CaseStatus[], to: CaseStatus, at: string): Promise<boolean> {
    const placeholders = from.map(() => '?').join(', ');
    const result = await tx.run(
      `UPDATE case_info SET status = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})`,
      [to, at, caseId, ...from],
    );
    return result.changes === 1;
  }

  async progressStats(reader: DatabaseReader, caseId: CaseId): Promise<CaseProgressStats | null> {
    const rows = await reader.query(
      'SELECT lesson_count, answer_num, before_hint_score_sum, final_score_sum FROM case_progress_stats WHERE case_id = ?',
      [caseId],
    );
    if (!rows[0]) return null;
    return {
      lessonCount: count(rows[0].lesson_count, 'lesson_count'),
      answerNum: count(rows[0].answer_num, 'answer_num'),
      beforeHintScoreSum: count(rows[0].before_hint_score_sum, 'before_hint_score_sum'),
      finalScoreSum: count(rows[0].final_score_sum, 'final_score_sum'),
    };
  }

  async grammarStats(reader: DatabaseReader, caseId: CaseId): Promise<CaseGrammarStats[]> {
    const rows = await reader.query(
      'SELECT s.grammar_id, g.grammar_code, g.name AS grammar_name, s.total_num, s.before_hint_score_sum, s.final_score_sum, s.updated_at FROM case_grammar_stats s JOIN grammar g ON g.id = s.grammar_id WHERE s.case_id = ? ORDER BY g.grammar_code',
      [caseId],
    );
    return rows.map(row => ({
      grammarId: parseLocalId<'grammar'>(row.grammar_id),
      grammarCode: text(row.grammar_code, 'grammar_code'),
      grammarName: text(row.grammar_name, 'grammar_name'),
      totalNum: count(row.total_num, 'total_num'),
      beforeHintScoreSum: count(row.before_hint_score_sum, 'before_hint_score_sum'),
      finalScoreSum: count(row.final_score_sum, 'final_score_sum'),
      updatedAt: text(row.updated_at, 'updated_at'),
    }));
  }

  async courseHistory(reader: DatabaseReader, caseId: CaseId): Promise<CaseCourseHistoryItem[]> {
    const rows = await reader.query(
      "SELECT p.id AS plan_id, p.plan_type, p.name AS plan_name, pc.id AS plan_course_id, pc.sequence_no, c.id AS course_id, c.name AS course_name, ccp.id AS progress_id, ccp.status AS progress_status, ci.id AS classroom_id, ci.status AS classroom_status, ci.completed_at AS classroom_completed_at FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id JOIN plan p ON p.id = pc.plan_id JOIN course c ON c.id = pc.course_id LEFT JOIN course_instance ci ON ci.progress_id = ccp.id AND ci.status <> 'VOID' WHERE ccp.case_id = ? ORDER BY p.id, pc.sequence_no, ccp.id",
      [caseId],
    );
    return rows.map(parseHistory);
  }

  /** 个案计划列表来自 plan（INDIVIDUAL），包含手动创建与移除成员时复制生成的计划。 */
  async listCasePlans(reader: DatabaseReader, caseId: CaseId): Promise<CasePlanSummary[]> {
    const rows = await reader.query(
      "SELECT p.id, p.name, p.status, p.created_at, (SELECT COUNT(*) FROM plan_course pc WHERE pc.plan_id = p.id) AS course_count, (SELECT COUNT(*) FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id WHERE pc.plan_id = p.id AND ccp.case_id = p.case_id AND ccp.status = 'COMPLETED') AS completed_count FROM plan p WHERE p.case_id = ? AND p.plan_type = 'INDIVIDUAL' ORDER BY p.id",
      [caseId],
    );
    return rows.map(row => {
      const status = text(row.status, 'status');
      if (!PLAN_STATUSES.has(status)) throw new AppError('INVALID_DATABASE_RESULT', '个案计划状态无效。');
      return {
        planId: parseLocalId<'plan'>(row.id),
        name: text(row.name, 'name'),
        status: status as PlanStatus,
        createdAt: text(row.created_at, 'created_at'),
        courseCount: count(row.course_count, 'course_count'),
        completedCount: count(row.completed_count, 'completed_count'),
      };
    });
  }
}

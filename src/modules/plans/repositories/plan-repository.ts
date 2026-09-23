import type { DatabaseReader, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, parseLocalId } from '../../../shared/contracts/index.ts';
import type { CaseId, CourseId, CreatePlanInput, GroupId, Plan, PlanCourse, PlanCourseId, PlanId } from '../types.ts';

const PLAN_STATUSES = new Set(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']);
const PLAN_TYPES = new Set(['INDIVIDUAL', 'GROUP']);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_DATABASE_RESULT', `计划数据字段 ${field} 无效。`);
  return value;
}

function nullableId<Kind extends string>(value: unknown, field: string) {
  if (value === null) return null;
  try { return parseLocalId<Kind>(value); } catch { throw new AppError('INVALID_DATABASE_RESULT', `计划数据字段 ${field} 无效。`); }
}

function parsePlan(row: Record<string, unknown>): Plan {
  const planType = text(row.plan_type, 'plan_type');
  const status = text(row.status, 'status');
  if (!PLAN_TYPES.has(planType) || !PLAN_STATUSES.has(status)) {
    throw new AppError('INVALID_DATABASE_RESULT', '计划状态数据无效。');
  }
  return {
    id: parseLocalId<'plan'>(row.id),
    planType: planType as Plan['planType'],
    caseId: nullableId<'case_info'>(row.case_id, 'case_id'),
    groupId: nullableId<'group_info'>(row.group_id, 'group_id'),
    name: text(row.name, 'name'),
    status: status as Plan['status'],
    completedAt: row.completed_at === null ? null : text(row.completed_at, 'completed_at'),
    createdAt: text(row.created_at, 'created_at'),
  };
}

export class PlanRepository {
  async create(tx: DatabaseTransaction, input: CreatePlanInput): Promise<PlanId> {
    const result = await tx.run(
      'INSERT INTO plan (plan_type, case_id, group_id, name) VALUES (?, ?, ?, ?)',
      [input.planType, input.planType === 'INDIVIDUAL' ? input.caseId : null, input.planType === 'GROUP' ? input.groupId : null, input.name],
    );
    return parseLocalId<'plan'>(result.lastInsertId);
  }

  async findById(reader: DatabaseReader, planId: PlanId): Promise<Plan | null> {
    const rows = await reader.query('SELECT id, plan_type, case_id, group_id, name, status, completed_at, created_at FROM plan WHERE id = ?', [planId]);
    return rows[0] ? parsePlan(rows[0]) : null;
  }

  async listCourses(reader: DatabaseReader, planId: PlanId): Promise<PlanCourse[]> {
    const rows = await reader.query('SELECT id, plan_id, course_id, sequence_no FROM plan_course WHERE plan_id = ? ORDER BY sequence_no', [planId]);
    return rows.map(row => ({
      id: parseLocalId<'plan_course'>(row.id),
      planId: parseLocalId<'plan'>(row.plan_id),
      courseId: parseLocalId<'course'>(row.course_id),
      sequenceNo: typeof row.sequence_no === 'number' && Number.isSafeInteger(row.sequence_no) ? row.sequence_no : (() => { throw new AppError('INVALID_DATABASE_RESULT', '计划课程顺序无效。'); })(),
    }));
  }

  async listCurrentGroupMembers(reader: DatabaseReader, groupId: GroupId): Promise<CaseId[]> {
    const rows = await reader.query('SELECT case_id FROM group_member WHERE group_id = ? ORDER BY case_id', [groupId]);
    return rows.map(row => parseLocalId<'case_info'>(row.case_id));
  }

  async addCourse(tx: DatabaseTransaction, planId: PlanId, courseId: CourseId, sequenceNo: number): Promise<PlanCourseId> {
    const result = await tx.run('INSERT INTO plan_course (plan_id, course_id, sequence_no) VALUES (?, ?, ?)', [planId, courseId, sequenceNo]);
    return parseLocalId<'plan_course'>(result.lastInsertId);
  }

  async removeCourse(tx: DatabaseTransaction, planId: PlanId, planCourseId: PlanCourseId): Promise<boolean> {
    return (await tx.run('DELETE FROM plan_course WHERE id = ? AND plan_id = ?', [planCourseId, planId])).changes === 1;
  }

  async updateSequence(tx: DatabaseTransaction, planCourseId: PlanCourseId, sequenceNo: number): Promise<void> {
    if ((await tx.run('UPDATE plan_course SET sequence_no = ? WHERE id = ?', [sequenceNo, planCourseId])).changes !== 1) {
      throw new AppError('PLAN_COURSE_NOT_FOUND', '计划课程不存在。');
    }
  }

  async updateStatus(tx: DatabaseTransaction, planId: PlanId, from: readonly string[], to: Plan['status'], completedAt: string | null): Promise<boolean> {
    const placeholders = from.map(() => '?').join(', ');
    const result = await tx.run(`UPDATE plan SET status = ?, completed_at = ? WHERE id = ? AND status IN (${placeholders})`, [to, completedAt, planId, ...from]);
    return result.changes === 1;
  }

  async completionCounts(reader: DatabaseReader, plan: Plan): Promise<{ participants: number; expected: number; completed: number }> {
    if (plan.planType === 'INDIVIDUAL') {
      const rows = await reader.query(
        'SELECT COUNT(pc.id) AS expected, SUM(CASE WHEN ccp.status = ? THEN 1 ELSE 0 END) AS completed FROM plan_course pc LEFT JOIN course_case_progress ccp ON ccp.plan_course_id = pc.id AND ccp.case_id = ? WHERE pc.plan_id = ?',
        ['COMPLETED', plan.caseId, plan.id],
      );
      return { participants: 1, expected: Number(rows[0]?.expected ?? 0), completed: Number(rows[0]?.completed ?? 0) };
    }
    const rows = await reader.query(
      'SELECT (SELECT COUNT(*) FROM group_member gm WHERE gm.group_id = ?) AS participants, COUNT(pc.id) AS expected, SUM(CASE WHEN ccp.status = ? THEN 1 ELSE 0 END) AS completed FROM group_member gm CROSS JOIN plan_course pc LEFT JOIN course_case_progress ccp ON ccp.case_id = gm.case_id AND ccp.plan_course_id = pc.id WHERE gm.group_id = ? AND pc.plan_id = ?',
      [plan.groupId, 'COMPLETED', plan.groupId, plan.id],
    );
    return {
      participants: Number(rows[0]?.participants ?? 0),
      expected: Number(rows[0]?.expected ?? 0),
      completed: Number(rows[0]?.completed ?? 0),
    };
  }
}

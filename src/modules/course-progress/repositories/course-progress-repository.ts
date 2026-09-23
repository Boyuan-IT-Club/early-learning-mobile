import type { DatabaseReader, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, parseLocalId, parseResumeState } from '../../../shared/contracts/index.ts';
import type { CaseId, CourseProgress, GroupId, PlanId, ProgressId, RestoredProgress } from '../types.ts';

const STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'STOPPED']);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_DATABASE_RESULT', `课程进度字段 ${field} 无效。`);
  return value;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') throw new AppError('INVALID_DATABASE_RESULT', `课程进度字段 ${field} 无效。`);
  try { return JSON.parse(value) as unknown; } catch { throw new AppError('INVALID_DATABASE_RESULT', `课程进度字段 ${field} 不是有效 JSON。`); }
}

function parseProgress(row: Record<string, unknown>): CourseProgress {
  const status = text(row.status, 'status');
  if (!STATUSES.has(status)) throw new AppError('INVALID_DATABASE_RESULT', '课程进度状态无效。');
  return {
    id: parseLocalId<'course_case_progress'>(row.id),
    caseId: parseLocalId<'case_info'>(row.case_id),
    planCourseId: parseLocalId<'plan_course'>(row.plan_course_id),
    planId: parseLocalId<'plan'>(row.plan_id),
    status: status as CourseProgress['status'],
    resumeState: parseResumeState(parseJson(row.resume_state_json, 'resume_state_json')),
    completedAt: row.completed_at === null ? null : text(row.completed_at, 'completed_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
  };
}

export class CourseProgressRepository {
  async findById(reader: DatabaseReader, progressId: ProgressId): Promise<CourseProgress | null> {
    const rows = await reader.query(
      'SELECT ccp.id, ccp.case_id, ccp.plan_course_id, pc.plan_id, ccp.status, ccp.resume_state_json, ccp.completed_at, ccp.updated_at FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id WHERE ccp.id = ?',
      [progressId],
    );
    return rows[0] ? parseProgress(rows[0]) : null;
  }

  async createForPlan(tx: DatabaseTransaction, planId: PlanId, caseId: CaseId, at: string): Promise<void> {
    await tx.run(
      "INSERT OR IGNORE INTO course_case_progress (case_id, plan_course_id, status, resume_state_json, updated_at) SELECT ?, id, 'PENDING', '{}', ? FROM plan_course WHERE plan_id = ?",
      [caseId, at, planId],
    );
  }

  async stopForPlan(tx: DatabaseTransaction, planId: PlanId, at: string): Promise<void> {
    await tx.run(
      "UPDATE course_case_progress SET status = 'STOPPED', updated_at = ? WHERE plan_course_id IN (SELECT id FROM plan_course WHERE plan_id = ?) AND status IN ('PENDING', 'IN_PROGRESS')",
      [at, planId],
    );
  }

  async listActiveGroupPlans(reader: DatabaseReader, groupId: GroupId): Promise<PlanId[]> {
    const rows = await reader.query("SELECT id FROM plan WHERE plan_type = 'GROUP' AND group_id = ? AND status = 'ACTIVE' ORDER BY id", [groupId]);
    return rows.map(row => parseLocalId<'plan'>(row.id));
  }

  async restoreForPlan(tx: DatabaseTransaction, planId: PlanId, caseId: CaseId, at: string): Promise<RestoredProgress[]> {
    await tx.run(
      "UPDATE course_case_progress SET status = CASE WHEN EXISTS (SELECT 1 FROM course_instance ci WHERE ci.progress_id = course_case_progress.id AND ci.status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI')) THEN 'IN_PROGRESS' ELSE 'PENDING' END, updated_at = ? WHERE case_id = ? AND plan_course_id IN (SELECT id FROM plan_course WHERE plan_id = ?) AND status = 'STOPPED'",
      [at, caseId, planId],
    );
    const rows = await tx.query(
      "SELECT ccp.id, ci.id AS classroom_id FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id LEFT JOIN course_instance ci ON ci.progress_id = ccp.id AND ci.status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI') WHERE pc.plan_id = ? AND ccp.case_id = ? AND ccp.status <> 'COMPLETED' ORDER BY pc.sequence_no",
      [planId, caseId],
    );
    return rows.map(row => ({
      progressId: parseLocalId<'course_case_progress'>(row.id),
      unfinishedClassroomId: row.classroom_id === null ? null : parseLocalId<'course_instance'>(row.classroom_id),
    }));
  }

  async stopGroupMember(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId, at: string): Promise<PlanId[]> {
    const plans = await this.listActiveGroupPlans(tx, groupId);
    await tx.run(
      "UPDATE course_case_progress SET status = 'STOPPED', updated_at = ? WHERE case_id = ? AND status IN ('PENDING', 'IN_PROGRESS') AND plan_course_id IN (SELECT pc.id FROM plan_course pc JOIN plan p ON p.id = pc.plan_id WHERE p.plan_type = 'GROUP' AND p.group_id = ? AND p.status = 'ACTIVE')",
      [at, caseId, groupId],
    );
    return plans;
  }

  async setStarted(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<boolean> {
    const result = await tx.run("UPDATE course_case_progress SET status = 'IN_PROGRESS', updated_at = ? WHERE id = ? AND status = 'PENDING'", [at, progressId]);
    return result.changes === 1;
  }

  async setCompleted(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<boolean> {
    const result = await tx.run("UPDATE course_case_progress SET status = 'COMPLETED', completed_at = ?, resume_state_json = '{}', updated_at = ? WHERE id = ? AND status = 'IN_PROGRESS'", [at, at, progressId]);
    return result.changes === 1;
  }

  async restoreAfterVoid(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<'PENDING' | 'STOPPED'> {
    const rows = await tx.query(
      "SELECT p.status AS plan_status, p.plan_type, CASE WHEN p.plan_type = 'INDIVIDUAL' OR EXISTS (SELECT 1 FROM group_member gm WHERE gm.group_id = p.group_id AND gm.case_id = ccp.case_id) THEN 1 ELSE 0 END AS eligible FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id JOIN plan p ON p.id = pc.plan_id WHERE ccp.id = ?",
      [progressId],
    );
    if (!rows[0]) throw new AppError('PROGRESS_NOT_FOUND', '课程进度不存在。');
    const status = rows[0].plan_status === 'ACTIVE' && rows[0].eligible === 1 ? 'PENDING' : 'STOPPED';
    await tx.run("UPDATE course_case_progress SET status = ?, resume_state_json = '{}', completed_at = null, updated_at = ? WHERE id = ? AND status <> 'COMPLETED'", [status, at, progressId]);
    return status;
  }

  async saveResumeState(tx: DatabaseTransaction, progressId: ProgressId, serialized: string, at: string): Promise<boolean> {
    const result = await tx.run("UPDATE course_case_progress SET resume_state_json = ?, updated_at = ? WHERE id = ? AND status = 'IN_PROGRESS'", [serialized, at, progressId]);
    return result.changes === 1;
  }
}

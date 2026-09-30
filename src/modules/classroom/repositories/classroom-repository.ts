import type { DatabaseReader, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import {
  AppError, parseActivityConfig, parseActivityResults, parseAIScore, parseLocalId, parseScaleScores,
} from '../../../shared/contracts/index.ts';
import type { Classroom, ClassroomContext, ClassroomCopyMapping, ClassroomId, LocalFileId, ProgressId } from '../types.ts';

const CLASSROOM_STATUSES = new Set(['DRAFT', 'IN_PROGRESS', 'PENDING_AI', 'COMPLETED', 'VOID']);
const PROGRESS_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'STOPPED']);
const PLAN_STATUSES = new Set(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED']);

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_DATABASE_RESULT', `课堂数据字段 ${field} 无效。`);
  return value;
}

function json(value: unknown, field: string): unknown {
  if (typeof value !== 'string') throw new AppError('INVALID_DATABASE_RESULT', `课堂数据字段 ${field} 无效。`);
  try { return JSON.parse(value) as unknown; } catch { throw new AppError('INVALID_DATABASE_RESULT', `课堂数据字段 ${field} 不是有效 JSON。`); }
}

function parseClassroom(row: Record<string, unknown>): Classroom {
  const status = text(row.status, 'status');
  if (!CLASSROOM_STATUSES.has(status)) throw new AppError('INVALID_DATABASE_RESULT', '课堂状态无效。');
  return {
    id: parseLocalId<'course_instance'>(row.id),
    progressId: parseLocalId<'course_case_progress'>(row.progress_id),
    status: status as Classroom['status'],
    activityResults: parseActivityResults(json(row.activity_results_json, 'activity_results_json')),
    audioFileId: row.audio_file_id === null ? null : parseLocalId<'storage_local_file'>(row.audio_file_id),
    transcriptText: row.transcript_text === null ? null : text(row.transcript_text, 'transcript_text'),
    aiScore: row.ai_score_json === null ? null : parseAIScore(json(row.ai_score_json, 'ai_score_json')),
    scaleScores: parseScaleScores(json(row.scale_scores_json, 'scale_scores_json')),
    startedAt: row.started_at === null ? null : text(row.started_at, 'started_at'),
    completedAt: row.completed_at === null ? null : text(row.completed_at, 'completed_at'),
    voidReason: row.void_reason === null ? null : text(row.void_reason, 'void_reason'),
  };
}

const CLASSROOM_COLUMNS = 'id, progress_id, status, activity_results_json, audio_file_id, transcript_text, ai_score_json, scale_scores_json, started_at, completed_at, void_reason';

export class ClassroomRepository {
  async findById(reader: DatabaseReader, classroomId: ClassroomId): Promise<Classroom | null> {
    const rows = await reader.query(`SELECT ${CLASSROOM_COLUMNS} FROM course_instance WHERE id = ?`, [classroomId]);
    return rows[0] ? parseClassroom(rows[0]) : null;
  }

  async findActiveByProgress(reader: DatabaseReader, progressId: ProgressId): Promise<Classroom | null> {
    const rows = await reader.query(`SELECT ${CLASSROOM_COLUMNS} FROM course_instance WHERE progress_id = ? AND status <> 'VOID'`, [progressId]);
    return rows[0] ? parseClassroom(rows[0]) : null;
  }

  async getContext(reader: DatabaseReader, progressId: ProgressId): Promise<ClassroomContext | null> {
    const rows = await reader.query(
      "SELECT ccp.id AS progress_id, ccp.case_id, ccp.status AS progress_status, p.id AS plan_id, p.status AS plan_status, p.plan_type, CASE WHEN p.plan_type = 'INDIVIDUAL' OR EXISTS (SELECT 1 FROM group_member gm WHERE gm.group_id = p.group_id AND gm.case_id = ccp.case_id) THEN 1 ELSE 0 END AS eligible, c.activity_configs_json FROM course_case_progress ccp JOIN plan_course pc ON pc.id = ccp.plan_course_id JOIN plan p ON p.id = pc.plan_id JOIN course c ON c.id = pc.course_id WHERE ccp.id = ?",
      [progressId],
    );
    const row = rows[0];
    if (!row) return null;
    const progressStatus = text(row.progress_status, 'progress_status');
    const planStatus = text(row.plan_status, 'plan_status');
    if (!PROGRESS_STATUSES.has(progressStatus) || !PLAN_STATUSES.has(planStatus)) throw new AppError('INVALID_DATABASE_RESULT', '课堂关联状态无效。');
    return {
      progressId: parseLocalId<'course_case_progress'>(row.progress_id),
      caseId: parseLocalId<'case_info'>(row.case_id),
      planId: parseLocalId<'plan'>(row.plan_id),
      progressStatus: progressStatus as ClassroomContext['progressStatus'],
      planStatus: planStatus as ClassroomContext['planStatus'],
      participantEligible: row.eligible === 1,
      config: parseActivityConfig(json(row.activity_configs_json, 'activity_configs_json')),
    };
  }

  async create(tx: DatabaseTransaction, progressId: ProgressId): Promise<ClassroomId> {
    const result = await tx.run('INSERT INTO course_instance (progress_id) VALUES (?)', [progressId]);
    return parseLocalId<'course_instance'>(result.lastInsertId);
  }

  async saveActivityResults(tx: DatabaseTransaction, classroomId: ClassroomId, serialized: string): Promise<void> {
    const result = await tx.run("UPDATE course_instance SET activity_results_json = ?, status = 'IN_PROGRESS' WHERE id = ? AND status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI')", [serialized, classroomId]);
    if (result.changes !== 1) throw new AppError('CLASSROOM_NOT_EDITABLE', '当前课堂不能继续保存活动结果。');
  }

  async saveScoredActivityResults(tx: DatabaseTransaction, classroomId: ClassroomId, serialized: string): Promise<void> {
    const result = await tx.run("UPDATE course_instance SET activity_results_json = ? WHERE id = ? AND status IN ('IN_PROGRESS', 'PENDING_AI')", [serialized, classroomId]);
    if (result.changes !== 1) throw new AppError('CLASSROOM_NOT_EDITABLE', '当前课堂不能保存问答评分。');
  }

  async saveNarration(tx: DatabaseTransaction, classroomId: ClassroomId, fileId: LocalFileId, transcript: string, clearScore: boolean): Promise<void> {
    const sql = clearScore
      ? "UPDATE course_instance SET audio_file_id = ?, transcript_text = ?, ai_score_json = null, status = 'IN_PROGRESS' WHERE id = ? AND status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI')"
      : "UPDATE course_instance SET audio_file_id = ?, transcript_text = ?, status = 'IN_PROGRESS' WHERE id = ? AND status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI')";
    if ((await tx.run(sql, [fileId, transcript, classroomId])).changes !== 1) throw new AppError('CLASSROOM_NOT_EDITABLE', '当前课堂不能保存故事叙述。');
  }

  async saveStoryScore(tx: DatabaseTransaction, classroomId: ClassroomId, serialized: string): Promise<void> {
    if ((await tx.run("UPDATE course_instance SET ai_score_json = ? WHERE id = ? AND status IN ('IN_PROGRESS', 'PENDING_AI')", [serialized, classroomId])).changes !== 1) {
      throw new AppError('CLASSROOM_NOT_EDITABLE', '当前课堂不能保存故事评分。');
    }
  }

  async saveScaleScores(tx: DatabaseTransaction, classroomId: ClassroomId, serialized: string): Promise<void> {
    if ((await tx.run("UPDATE course_instance SET scale_scores_json = ? WHERE id = ? AND status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI')", [serialized, classroomId])).changes !== 1) {
      throw new AppError('CLASSROOM_NOT_EDITABLE', '当前课堂不能保存十题评价。');
    }
  }

  async markPendingAi(tx: DatabaseTransaction, classroomId: ClassroomId, startedAt: string): Promise<void> {
    if ((await tx.run("UPDATE course_instance SET status = 'PENDING_AI', started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ('DRAFT', 'IN_PROGRESS')", [startedAt, classroomId])).changes !== 1) {
      throw new AppError('CLASSROOM_STATE_CONFLICT', '课堂状态已变化，请刷新后重试。');
    }
  }

  async markCompleted(tx: DatabaseTransaction, classroomId: ClassroomId, at: string): Promise<boolean> {
    return (await tx.run("UPDATE course_instance SET status = 'COMPLETED', completed_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'PENDING_AI'", [at, at, classroomId])).changes === 1;
  }

  async markVoid(tx: DatabaseTransaction, classroomId: ClassroomId, reason: string): Promise<boolean> {
    return (await tx.run("UPDATE course_instance SET status = 'VOID', void_reason = ? WHERE id = ? AND status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI')", [reason, classroomId])).changes === 1;
  }

  /** 复制课堂实例，保留课堂结果、录音、转写与评分；恢复位置保存在进度上，由进度模块复制。 */
  async copyForProgresses(tx: DatabaseTransaction, mappings: readonly ClassroomCopyMapping[]): Promise<void> {
    for (const mapping of mappings) {
      await tx.run(
        "INSERT INTO course_instance (progress_id, status, activity_results_json, audio_file_id, transcript_text, ai_score_json, scale_scores_json, started_at, completed_at, void_reason) SELECT ?, status, activity_results_json, audio_file_id, transcript_text, ai_score_json, scale_scores_json, started_at, completed_at, void_reason FROM course_instance WHERE progress_id = ? AND status <> 'VOID'",
        [mapping.targetProgressId, mapping.sourceProgressId],
      );
    }
  }
}

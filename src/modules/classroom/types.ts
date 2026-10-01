import type {
  ActivityConfig, ActivityResultsJson, AIScore, ClassroomStatus, LocalId, ScaleScores,
} from '../../shared/contracts/index.ts';

export type ClassroomId = LocalId<'course_instance'>;
export type ProgressId = LocalId<'course_case_progress'>;
export type PlanId = LocalId<'plan'>;
export type CaseId = LocalId<'case_info'>;
export type LocalFileId = LocalId<'storage_local_file'>;

export interface Classroom {
  id: ClassroomId;
  progressId: ProgressId;
  status: ClassroomStatus;
  activityResults: ActivityResultsJson;
  audioFileId: LocalFileId | null;
  transcriptText: string | null;
  aiScore: AIScore | null;
  scaleScores: ScaleScores | null;
  startedAt: string | null;
  completedAt: string | null;
  voidReason: string | null;
}

export interface ClassroomContext {
  progressId: ProgressId;
  caseId: CaseId;
  planId: PlanId;
  progressStatus: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'STOPPED';
  planStatus: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  participantEligible: boolean;
  config: ActivityConfig;
}

export type AnswerStage = 'before_hint' | 'after_hint';

/** 复制课堂实例时新旧课程进度的对应关系，由课程进度模块提供。 */
export interface ClassroomCopyMapping {
  sourceProgressId: ProgressId;
  targetProgressId: ProgressId;
}

import type { CourseProgressStatus, LocalId, ResumeState } from '../../shared/contracts/index.ts';

export type ProgressId = LocalId<'course_case_progress'>;
export type CaseId = LocalId<'case_info'>;
export type PlanId = LocalId<'plan'>;
export type PlanCourseId = LocalId<'plan_course'>;
export type ClassroomId = LocalId<'course_instance'>;
export type GroupId = LocalId<'group_info'>;

export interface CourseProgress {
  id: ProgressId;
  caseId: CaseId;
  planCourseId: PlanCourseId;
  planId: PlanId;
  status: CourseProgressStatus;
  resumeState: ResumeState | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface RestoredProgress {
  progressId: ProgressId;
  unfinishedClassroomId: ClassroomId | null;
}

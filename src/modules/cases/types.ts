import type {
  CaseStatus, ClassroomStatus, CourseProgressStatus, DateOnly, LocalId, PlanStatus, PlanType, Sex,
} from '../../shared/contracts/index.ts';

export type CaseId = LocalId<'case_info'>;
export type TeacherId = LocalId<'user_local_account'>;
export type PlanId = LocalId<'plan'>;
export type PlanCourseId = LocalId<'plan_course'>;
export type CourseId = LocalId<'course'>;
export type ProgressId = LocalId<'course_case_progress'>;
export type ClassroomId = LocalId<'course_instance'>;
export type GrammarId = LocalId<'grammar'>;

/** 个案基础资料；状态由业务流程推进，不由客户端传入或编辑。 */
export interface CaseInfo {
  id: CaseId;
  fullName: string;
  birthDate: DateOnly;
  sex: Sex;
  guardianPhone: string;
  guardianName: string;
  childCode: string;
  teacherId: TeacherId;
  status: CaseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCaseInput {
  fullName: string;
  birthDate: DateOnly;
  sex: Sex;
  guardianPhone: string;
  guardianName: string;
  childCode: string;
  teacherId: TeacherId;
}

/** 编辑只允许修改基础资料，不包含状态、评估、进度或统计。 */
export type UpdateCaseInput = Pick<
  CreateCaseInput,
  'fullName' | 'birthDate' | 'sex' | 'guardianPhone' | 'guardianName'
>;

/** 康复统计缓存，与统计模块口径一致；分母为 0 时由展示层显示“暂无数据”。 */
export interface CaseProgressStats {
  lessonCount: number;
  answerNum: number;
  beforeHintScoreSum: number;
  finalScoreSum: number;
}

export interface CaseGrammarStats {
  grammarId: GrammarId;
  grammarCode: string;
  grammarName: string;
  totalNum: number;
  beforeHintScoreSum: number;
  finalScoreSum: number;
  updatedAt: string;
}

/** 课程历史按个案课程进度展开，保留完整历史，不因成员移除或结案而删除。 */
export interface CaseCourseHistoryItem {
  planId: PlanId;
  planType: PlanType;
  planName: string;
  planCourseId: PlanCourseId;
  courseId: CourseId;
  courseName: string;
  sequenceNo: number;
  progressId: ProgressId;
  progressStatus: CourseProgressStatus;
  classroomId: ClassroomId | null;
  classroomStatus: ClassroomStatus | null;
  classroomCompletedAt: string | null;
  resumable: boolean;
}

export interface CasePlanSummary {
  planId: PlanId;
  name: string;
  status: PlanStatus;
  createdAt: string;
  courseCount: number;
  completedCount: number;
}

export interface CaseDetail {
  info: CaseInfo;
  progressStats: CaseProgressStats | null;
  grammarStats: readonly CaseGrammarStats[];
  courseHistory: readonly CaseCourseHistoryItem[];
  casePlans: readonly CasePlanSummary[];
}

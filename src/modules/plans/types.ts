import type { LocalId, PlanStatus, PlanType } from '../../shared/contracts/index.ts';

export type PlanId = LocalId<'plan'>;
export type PlanCourseId = LocalId<'plan_course'>;
export type CaseId = LocalId<'case_info'>;
export type GroupId = LocalId<'group_info'>;
export type CourseId = LocalId<'course'>;

export interface Plan {
  id: PlanId;
  planType: PlanType;
  caseId: CaseId | null;
  groupId: GroupId | null;
  name: string;
  status: PlanStatus;
  completedAt: string | null;
  createdAt: string;
}

export interface PlanCourse {
  id: PlanCourseId;
  planId: PlanId;
  courseId: CourseId;
  sequenceNo: number;
}

export type CreatePlanInput =
  | { planType: 'INDIVIDUAL'; caseId: CaseId; name: string }
  | { planType: 'GROUP'; groupId: GroupId; name: string };

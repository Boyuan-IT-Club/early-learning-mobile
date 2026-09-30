import type { CaseStatus, GroupStatus, LocalId } from '../../shared/contracts/index.ts';

export type GroupId = LocalId<'group_info'>;
export type CaseId = LocalId<'case_info'>;
export type PlanId = LocalId<'plan'>;
export type ProgressId = LocalId<'course_case_progress'>;
export type ClassroomId = LocalId<'course_instance'>;

export interface GroupInfo {
  id: GroupId;
  name: string;
  remark: string | null;
  status: GroupStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateGroupInput {
  name: string;
  remark: string | null;
}

export type UpdateGroupInput = CreateGroupInput;

/** 当前成员展示数据来自 group_member 与 case_info，不复制个案资料。 */
export interface GroupMember {
  caseId: CaseId;
  childCode: string;
  fullName: string;
  status: CaseStatus;
}

/** 添加或重新加入成员后可继续执行的原课堂。 */
export interface RestoredProgress {
  progressId: ProgressId;
  unfinishedClassroomId: ClassroomId | null;
}

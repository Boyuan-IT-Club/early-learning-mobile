import type { Database, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, toIsoDateTime } from '../../../shared/contracts/index.ts';
import type { CaseId, CourseId, CreatePlanInput, Plan, PlanCourseId, PlanId } from '../types.ts';
import { PlanRepository } from '../repositories/plan-repository.ts';

export interface PlanProgressCoordinator {
  createForPlan(tx: DatabaseTransaction, planId: PlanId, caseIds: readonly CaseId[], at: string): Promise<void>;
  stopForPlan(tx: DatabaseTransaction, planId: PlanId, at: string): Promise<void>;
}

export interface PlanCaseCoordinator {
  advanceToIntervention(tx: DatabaseTransaction, caseId: CaseId, at: string): Promise<void>;
}

export interface PlanCourseCoordinator {
  assertSelectable(reader: DatabaseTransaction, courseId: CourseId): Promise<void>;
}

function name(value: string): string {
  const result = value.trim();
  if (!result) throw new AppError('INVALID_PLAN_NAME', '计划名称不能为空。');
  return result;
}

function sequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError('INVALID_PLAN_SEQUENCE', '课程顺序须为正整数。');
  return value;
}

export class PlanService {
  readonly #database: Database;
  readonly #repository: PlanRepository;
  readonly #progress: PlanProgressCoordinator;
  readonly #cases: PlanCaseCoordinator;
  readonly #courses: PlanCourseCoordinator;
  readonly #now: () => Date;

  constructor(
    database: Database,
    repository: PlanRepository,
    progress: PlanProgressCoordinator,
    cases: PlanCaseCoordinator,
    courses: PlanCourseCoordinator,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#repository = repository;
    this.#progress = progress;
    this.#cases = cases;
    this.#courses = courses;
    this.#now = now;
  }

  create(input: CreatePlanInput): Promise<PlanId> {
    return this.#database.transaction(tx => this.#repository.create(tx, { ...input, name: name(input.name) }));
  }

  get(planId: PlanId): Promise<Plan | null> {
    return this.#database.read(reader => this.#repository.findById(reader, planId));
  }

  addCourse(planId: PlanId, courseId: CourseId, sequenceNo: number): Promise<PlanCourseId> {
    return this.#database.transaction(async tx => {
      await this.requireDraft(tx, planId);
      await this.#courses.assertSelectable(tx, courseId);
      return this.#repository.addCourse(tx, planId, courseId, sequence(sequenceNo));
    });
  }

  removeCourse(planId: PlanId, planCourseId: PlanCourseId): Promise<void> {
    return this.#database.transaction(async tx => {
      await this.requireDraft(tx, planId);
      if (!await this.#repository.removeCourse(tx, planId, planCourseId)) throw new AppError('PLAN_COURSE_NOT_FOUND', '计划课程不存在。');
    });
  }

  reorderCourses(planId: PlanId, orderedIds: readonly PlanCourseId[]): Promise<void> {
    return this.#database.transaction(async tx => {
      await this.requireDraft(tx, planId);
      const existing = await this.#repository.listCourses(tx, planId);
      if (orderedIds.length !== existing.length || new Set(orderedIds).size !== orderedIds.length || existing.some(item => !orderedIds.includes(item.id))) {
        throw new AppError('INVALID_PLAN_COURSE_ORDER', '课程顺序必须完整且不能重复。');
      }
      // 先移到不会与正式顺序冲突的临时区，避免 UNIQUE(plan_id, sequence_no) 中途冲突。
      for (let index = 0; index < orderedIds.length; index += 1) await this.#repository.updateSequence(tx, orderedIds[index], -(index + 1));
      for (let index = 0; index < orderedIds.length; index += 1) await this.#repository.updateSequence(tx, orderedIds[index], index + 1);
    });
  }

  activate(planId: PlanId): Promise<void> {
    return this.#database.transaction(async tx => {
      const plan = await this.requireDraft(tx, planId);
      const at = toIsoDateTime(this.#now());
      const caseIds = plan.planType === 'INDIVIDUAL'
        ? [plan.caseId as CaseId]
        : await this.#repository.listCurrentGroupMembers(tx, plan.groupId!);
      if (!await this.#repository.updateStatus(tx, planId, ['DRAFT'], 'ACTIVE', null)) throw new AppError('PLAN_STATE_CONFLICT', '计划状态已变化，请刷新后重试。');
      await this.#progress.createForPlan(tx, planId, caseIds, at);
      for (const caseId of caseIds) await this.#cases.advanceToIntervention(tx, caseId, at);
    });
  }

  cancel(planId: PlanId): Promise<void> {
    return this.#database.transaction(async tx => {
      const plan = await this.requirePlan(tx, planId);
      if (plan.status !== 'DRAFT' && plan.status !== 'ACTIVE') throw new AppError('PLAN_NOT_CANCELLABLE', '只有草稿或进行中的计划可以取消。');
      const at = toIsoDateTime(this.#now());
      if (!await this.#repository.updateStatus(tx, planId, [plan.status], 'CANCELLED', null)) throw new AppError('PLAN_STATE_CONFLICT', '计划状态已变化，请刷新后重试。');
      await this.#progress.stopForPlan(tx, planId, at);
    });
  }

  async checkCompletion(tx: DatabaseTransaction, planId: PlanId, at: string): Promise<boolean> {
    const plan = await this.#repository.findById(tx, planId);
    if (!plan || plan.status !== 'ACTIVE') return false;
    const counts = await this.#repository.completionCounts(tx, plan);
    if (plan.planType === 'GROUP' && counts.participants === 0) return false;
    if (counts.expected === 0 || counts.completed !== counts.expected) return false;
    return this.#repository.updateStatus(tx, planId, ['ACTIVE'], 'COMPLETED', at);
  }

  private async requirePlan(tx: DatabaseTransaction, planId: PlanId): Promise<Plan> {
    const plan = await this.#repository.findById(tx, planId);
    if (!plan) throw new AppError('PLAN_NOT_FOUND', '计划不存在。');
    return plan;
  }

  private async requireDraft(tx: DatabaseTransaction, planId: PlanId): Promise<Plan> {
    const plan = await this.requirePlan(tx, planId);
    if (plan.status !== 'DRAFT') throw new AppError('PLAN_NOT_EDITABLE', '计划激活后不能修改课程安排。');
    return plan;
  }
}

import type { DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import type { LocalId } from '../../../shared/contracts/index.ts';
import { PlanRepository } from '../repositories/plan-repository.ts';
import type { CaseId, GroupId, PlanId } from '../types.ts';

/** 新旧课程进度对应关系；由课程进度模块发出，课堂模块据此复制课堂实例。 */
export interface ProgressCopyMapping {
  sourceProgressId: LocalId<'course_case_progress'>;
  targetProgressId: LocalId<'course_case_progress'>;
}

export interface PlanTransferProgressCoordinator {
  copyForPlan(tx: DatabaseTransaction, sourcePlanId: PlanId, targetPlanId: PlanId, caseId: CaseId, at: string): Promise<readonly ProgressCopyMapping[]>;
}

export interface PlanTransferClassroomCoordinator {
  copyForProgresses(tx: DatabaseTransaction, mappings: readonly ProgressCopyMapping[]): Promise<void>;
}

/**
 * 成员被移出小组时，把进行中的小组计划复制为该儿童的个案计划：
 * 计划默认 DRAFT（不激活），课程进度保持原状态，课堂结果、恢复位置、录音、转写与评分一并复制。
 * 该用例在调用方（小组模块）的事务内执行，不自行开启事务。
 */
export class PlanTransferService {
  readonly #plans: PlanRepository;
  readonly #progress: PlanTransferProgressCoordinator;
  readonly #classrooms: PlanTransferClassroomCoordinator;

  constructor(
    plans: PlanRepository,
    progress: PlanTransferProgressCoordinator,
    classrooms: PlanTransferClassroomCoordinator,
  ) {
    this.#plans = plans;
    this.#progress = progress;
    this.#classrooms = classrooms;
  }

  async copyGroupPlansToCase(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId, at: string): Promise<PlanId[]> {
    const sourcePlanIds = await this.#plans.listActiveGroupPlans(tx, groupId);
    const created: PlanId[] = [];
    for (const sourcePlanId of sourcePlanIds) {
      const source = await this.#plans.findById(tx, sourcePlanId);
      if (!source) continue;
      const targetPlanId = await this.#plans.create(tx, { planType: 'INDIVIDUAL', caseId, name: source.name });
      await this.#plans.cloneCourses(tx, sourcePlanId, targetPlanId);
      const mappings = await this.#progress.copyForPlan(tx, sourcePlanId, targetPlanId, caseId, at);
      await this.#classrooms.copyForProgresses(tx, mappings);
      created.push(targetPlanId);
    }
    return created;
  }
}

import type { Database, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, parseResumeState, toIsoDateTime, type ResumeState } from '../../../shared/contracts/index.ts';
import { CourseProgressRepository } from '../repositories/course-progress-repository.ts';
import type { CaseId, CourseProgress, GroupId, PlanId, ProgressId, RestoredProgress } from '../types.ts';

export interface ProgressPlanCoordinator {
  checkCompletion(tx: DatabaseTransaction, planId: PlanId, at: string): Promise<boolean>;
}

export interface ResumeStateCoordinator {
  assertValidForProgress(reader: DatabaseTransaction, progressId: ProgressId, state: ResumeState): Promise<void>;
}

export class CourseProgressService {
  readonly #database: Database;
  readonly #repository: CourseProgressRepository;
  readonly #plans: ProgressPlanCoordinator;
  readonly #resumeStates: ResumeStateCoordinator;
  readonly #now: () => Date;

  constructor(
    database: Database,
    repository: CourseProgressRepository,
    plans: ProgressPlanCoordinator,
    resumeStates: ResumeStateCoordinator,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#repository = repository;
    this.#plans = plans;
    this.#resumeStates = resumeStates;
    this.#now = now;
  }

  get(progressId: ProgressId): Promise<CourseProgress | null> {
    return this.#database.read(reader => this.#repository.findById(reader, progressId));
  }

  async createForPlan(tx: DatabaseTransaction, planId: PlanId, caseIds: readonly CaseId[], at: string): Promise<void> {
    for (const caseId of new Set(caseIds)) await this.#repository.createForPlan(tx, planId, caseId, at);
  }

  stopForPlan(tx: DatabaseTransaction, planId: PlanId, at: string): Promise<void> {
    return this.#repository.stopForPlan(tx, planId, at);
  }

  async onGroupMemberAdded(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId, at: string): Promise<RestoredProgress[]> {
    const plans = await this.#repository.listActiveGroupPlans(tx, groupId);
    const restored: RestoredProgress[] = [];
    for (const planId of plans) {
      await this.#repository.createForPlan(tx, planId, caseId, at);
      restored.push(...await this.#repository.restoreForPlan(tx, planId, caseId, at));
      await this.#plans.checkCompletion(tx, planId, at);
    }
    return restored;
  }

  async onGroupMemberRemoved(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId, at: string): Promise<void> {
    const plans = await this.#repository.stopGroupMember(tx, groupId, caseId, at);
    for (const planId of plans) await this.#plans.checkCompletion(tx, planId, at);
  }

  async start(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<void> {
    const progress = await this.require(tx, progressId);
    if (progress.status === 'IN_PROGRESS') return;
    if (progress.status === 'COMPLETED') throw new AppError('PROGRESS_COMPLETED', '已完成的课程进度不能再次开始。');
    if (progress.status === 'STOPPED') throw new AppError('PROGRESS_STOPPED', '已停止的课程进度须先恢复参与条件。');
    if (!await this.#repository.setStarted(tx, progressId, at)) throw new AppError('PROGRESS_STATE_CONFLICT', '课程进度状态已变化，请刷新后重试。');
  }

  async complete(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<PlanId> {
    const progress = await this.require(tx, progressId);
    if (progress.status === 'COMPLETED') return progress.planId;
    if (progress.status === 'STOPPED') throw new AppError('PROGRESS_STOPPED', '已停止的课程进度不能完成。');
    if (!await this.#repository.setCompleted(tx, progressId, at)) throw new AppError('PROGRESS_STATE_CONFLICT', '课程进度状态已变化，请刷新后重试。');
    return progress.planId;
  }

  restoreAfterVoid(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<'PENDING' | 'STOPPED'> {
    return this.#repository.restoreAfterVoid(tx, progressId, at);
  }

  saveResumeState(progressId: ProgressId, value: ResumeState): Promise<void> {
    return this.#database.transaction(async tx => {
      const state = parseResumeState(value);
      if (!state) throw new AppError('INVALID_RESUME_STATE', '恢复位置不能为空。');
      await this.#resumeStates.assertValidForProgress(tx, progressId, state);
      if (!await this.#repository.saveResumeState(tx, progressId, JSON.stringify(state), toIsoDateTime(this.#now()))) {
        throw new AppError('PROGRESS_NOT_RESUMABLE', '只有进行中的课程可以保存恢复位置。');
      }
    });
  }

  private async require(reader: DatabaseTransaction, progressId: ProgressId): Promise<CourseProgress> {
    const progress = await this.#repository.findById(reader, progressId);
    if (!progress) throw new AppError('PROGRESS_NOT_FOUND', '课程进度不存在。');
    return progress;
  }
}

import type { Database, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, toIsoDateTime } from '../../../shared/contracts/index.ts';
import { GroupRepository } from '../repositories/group-repository.ts';
import type {
  CaseId, CreateGroupInput, GroupId, GroupInfo, GroupMember, PlanId, RestoredProgress, UpdateGroupInput,
} from '../types.ts';

/** 由课程进度模块实现：补齐缺失进度、按规则恢复已停止进度。 */
export interface GroupProgressCoordinator {
  addMember(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId, at: string): Promise<readonly RestoredProgress[]>;
  removeMember(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId, at: string): Promise<void>;
}

/** 由干预计划模块实现：移除成员时把进行中的小组计划复制为个案计划（默认不激活）。 */
export interface GroupPlanCoordinator {
  copyGroupPlansToCase(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId, at: string): Promise<readonly PlanId[]>;
}

function name(value: string): string {
  const result = value.trim();
  if (!result) throw new AppError('INVALID_GROUP_NAME', '小组名称不能为空。');
  return result;
}

function remark(value: string | null): string | null {
  if (value === null) return null;
  const result = value.trim();
  return result ? result : null;
}

export class GroupService {
  readonly #database: Database;
  readonly #repository: GroupRepository;
  readonly #progress: GroupProgressCoordinator;
  readonly #plans: GroupPlanCoordinator;
  readonly #now: () => Date;

  constructor(
    database: Database,
    repository: GroupRepository,
    progress: GroupProgressCoordinator,
    plans: GroupPlanCoordinator,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#repository = repository;
    this.#progress = progress;
    this.#plans = plans;
    this.#now = now;
  }

  /** 创建小组只写基础信息，不自动创建干预计划或课程进度。 */
  create(input: CreateGroupInput): Promise<GroupId> {
    return this.#database.transaction(tx => this.#repository.create(
      tx,
      { name: name(input.name), remark: remark(input.remark) },
      toIsoDateTime(this.#now()),
    ));
  }

  get(groupId: GroupId): Promise<GroupInfo | null> {
    return this.#database.read(reader => this.#repository.findById(reader, groupId));
  }

  list(): Promise<GroupInfo[]> {
    return this.#database.read(reader => this.#repository.list(reader));
  }

  /** 编辑只改基础信息，不涉及成员、计划、进度或课堂。 */
  update(groupId: GroupId, input: UpdateGroupInput): Promise<void> {
    return this.#database.transaction(async tx => {
      await this.#require(tx, groupId);
      if (!await this.#repository.update(tx, groupId, { name: name(input.name), remark: remark(input.remark) }, toIsoDateTime(this.#now()))) {
        throw new AppError('GROUP_STATE_CONFLICT', '小组状态已变化，请刷新后重试。');
      }
    });
  }

  /** 归档保留成员、计划、进度和课堂历史，不物理删除数据。 */
  archive(groupId: GroupId): Promise<void> {
    return this.#database.transaction(async tx => {
      const group = await this.#require(tx, groupId);
      if (group.status === 'ARCHIVED') return;
      if (!await this.#repository.archive(tx, groupId, toIsoDateTime(this.#now()))) {
        throw new AppError('GROUP_STATE_CONFLICT', '小组状态已变化，请刷新后重试。');
      }
    });
  }

  listMembers(groupId: GroupId): Promise<GroupMember[]> {
    return this.#database.read(reader => this.#repository.listMembers(reader, groupId));
  }

  /** 添加成员：写入关系行后补齐缺失进度并恢复符合条件的已停止进度。 */
  addMember(groupId: GroupId, caseId: CaseId): Promise<readonly RestoredProgress[]> {
    return this.#database.transaction(async tx => {
      await this.#require(tx, groupId);
      if (await this.#repository.hasMember(tx, groupId, caseId)) {
        throw new AppError('GROUP_MEMBER_EXISTS', '该儿童已是当前小组成员。');
      }
      await this.#repository.addMember(tx, groupId, caseId);
      return this.#progress.addMember(tx, groupId, caseId, toIsoDateTime(this.#now()));
    });
  }

  /** 重新加入：创建新的成员关系并按有效未完成课堂恢复已停止进度。 */
  rejoinMember(groupId: GroupId, caseId: CaseId): Promise<readonly RestoredProgress[]> {
    return this.#database.transaction(async tx => {
      await this.#require(tx, groupId);
      if (await this.#repository.hasMember(tx, groupId, caseId)) {
        throw new AppError('GROUP_MEMBER_EXISTS', '该儿童已是当前小组成员。');
      }
      await this.#repository.addMember(tx, groupId, caseId);
      return this.#progress.addMember(tx, groupId, caseId, toIsoDateTime(this.#now()));
    });
  }

  /**
   * 移除成员：删除关系行后，先把进行中的小组计划复制为个案计划（默认不激活），
   * 再把原小组计划中未完成的进度置为 STOPPED；已完成进度、课堂历史与统计保留。
   */
  removeMember(groupId: GroupId, caseId: CaseId): Promise<readonly PlanId[]> {
    return this.#database.transaction(async tx => {
      await this.#require(tx, groupId);
      const at = toIsoDateTime(this.#now());
      if (!await this.#repository.removeMember(tx, groupId, caseId)) {
        throw new AppError('GROUP_MEMBER_NOT_FOUND', '该儿童不是当前小组成员。');
      }
      const planIds = await this.#plans.copyGroupPlansToCase(tx, groupId, caseId, at);
      await this.#progress.removeMember(tx, groupId, caseId, at);
      return planIds;
    });
  }

  async #require(reader: DatabaseTransaction, groupId: GroupId): Promise<GroupInfo> {
    const group = await this.#repository.findById(reader, groupId);
    if (!group) throw new AppError('GROUP_NOT_FOUND', '小组不存在。');
    if (group.status === 'DELETED') throw new AppError('GROUP_DELETED', '小组已删除，不能继续操作。');
    return group;
  }
}

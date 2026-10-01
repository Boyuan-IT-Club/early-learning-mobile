import type { Database, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, parseDateOnly, toIsoDateTime } from '../../../shared/contracts/index.ts';
import { CaseRepository } from '../repositories/case-repository.ts';
import type {
  CaseDetail, CaseId, CaseInfo, CreateCaseInput, TeacherId, UpdateCaseInput,
} from '../types.ts';

function required(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new AppError('INVALID_CASE_FIELD', `${field}不能为空。`);
  return result;
}

function numberOf(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AppError('INVALID_CASE_FIELD', `${field}无效。`);
  return value;
}

/** 供评估模块调用：未关联前测归档、初筛确认完成推进到 PRETEST_DONE。 */
export interface CaseStatusCoordinator {
  advanceToPretestDone(tx: DatabaseTransaction, caseId: CaseId, at: string): Promise<void>;
  advanceToIntervention(tx: DatabaseTransaction, caseId: CaseId, at: string): Promise<void>;
}

export class CaseService {
  readonly #database: Database;
  readonly #repository: CaseRepository;
  readonly #now: () => Date;

  constructor(database: Database, repository: CaseRepository, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#repository = repository;
    this.#now = now;
  }

  /** 建档：校验 child_code 未占用后写入，初始状态固定为 INTAKE_DONE。 */
  create(input: CreateCaseInput): Promise<CaseId> {
    const childCode = required(input.childCode, '儿童编号');
    const teacherId = numberOf(input.teacherId, '教师编号') as TeacherId;
    const normalized: CreateCaseInput = {
      fullName: required(input.fullName, '姓名'),
      birthDate: parseDateOnly(input.birthDate),
      sex: input.sex,
      guardianPhone: required(input.guardianPhone, '监护人电话'),
      guardianName: required(input.guardianName, '监护人姓名'),
      childCode,
      teacherId,
    };
    return this.#database.transaction(async tx => {
      if (await this.#repository.findByChildCode(tx, childCode)) {
        throw new AppError('CASE_CHILD_CODE_EXISTS', '该儿童编号已存在，不能重复建档。');
      }
      return this.#repository.create(tx, normalized, toIsoDateTime(this.#now()));
    });
  }

  update(caseId: CaseId, input: UpdateCaseInput): Promise<void> {
    const normalized: UpdateCaseInput = {
      fullName: required(input.fullName, '姓名'),
      birthDate: parseDateOnly(input.birthDate),
      sex: input.sex,
      guardianPhone: required(input.guardianPhone, '监护人电话'),
      guardianName: required(input.guardianName, '监护人姓名'),
    };
    return this.#database.transaction(async tx => {
      const current = await this.#require(tx, caseId);
      if (current.status === 'CLOSED') throw new AppError('CASE_CLOSED', '已结案的服务周期为历史记录，不能编辑。');
      if (!await this.#repository.update(tx, caseId, normalized, toIsoDateTime(this.#now()))) {
        throw new AppError('CASE_STATE_CONFLICT', '个案状态已变化，请刷新后重试。');
      }
    });
  }

  /** 结案只结束当前服务周期，不删除评估、报告、进度、课堂、录音、统计或计划数据。 */
  close(caseId: CaseId): Promise<CaseInfo> {
    return this.#database.transaction(async tx => {
      const current = await this.#require(tx, caseId);
      if (current.status === 'CLOSED') throw new AppError('CASE_ALREADY_CLOSED', '该服务周期已经结案。');
      const at = toIsoDateTime(this.#now());
      if (!await this.#repository.updateStatusIf(tx, caseId, ['INTAKE_DONE', 'PRETEST_DONE', 'INTERVENTION'], 'CLOSED', at)) {
        throw new AppError('CASE_STATE_CONFLICT', '个案状态已变化，请刷新后重试。');
      }
      return this.#require(tx, caseId);
    });
  }

  get(caseId: CaseId): Promise<CaseInfo | null> {
    return this.#database.read(reader => this.#repository.findById(reader, caseId));
  }

  list(): Promise<CaseInfo[]> {
    return this.#database.read(reader => this.#repository.list(reader));
  }

  /** 详情读取基础信息、康复统计、语法统计、课程历史和个案计划；统计只读不算。 */
  detail(caseId: CaseId): Promise<CaseDetail | null> {
    return this.#database.read(async reader => {
      const info = await this.#repository.findById(reader, caseId);
      if (!info) return null;
      const progressStats = await this.#repository.progressStats(reader, caseId);
      const grammarStats = await this.#repository.grammarStats(reader, caseId);
      const courseHistory = await this.#repository.courseHistory(reader, caseId);
      const casePlans = await this.#repository.listCasePlans(reader, caseId);
      return { info, progressStats, grammarStats, courseHistory, casePlans };
    });
  }

  /** INTAKE_DONE -> PRETEST_DONE；已在后续阶段或已结案时保持不变。 */
  advanceToPretestDone(tx: DatabaseTransaction, caseId: CaseId, at: string): Promise<void> {
    return this.#repository.updateStatusIf(tx, caseId, ['INTAKE_DONE'], 'PRETEST_DONE', at).then(() => undefined);
  }

  /** PRETEST_DONE -> INTERVENTION；不允许回退，已结案周期不接收推进。 */
  advanceToIntervention(tx: DatabaseTransaction, caseId: CaseId, at: string): Promise<void> {
    return this.#repository.updateStatusIf(tx, caseId, ['PRETEST_DONE'], 'INTERVENTION', at).then(() => undefined);
  }

  async #require(reader: DatabaseTransaction, caseId: CaseId): Promise<CaseInfo> {
    const info = await this.#repository.findById(reader, caseId);
    if (!info) throw new AppError('CASE_NOT_FOUND', '个案不存在。');
    return info;
  }
}

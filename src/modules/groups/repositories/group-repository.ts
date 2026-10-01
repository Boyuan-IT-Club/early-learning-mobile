import type { DatabaseReader, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import { AppError, parseLocalId, type CaseStatus, type GroupStatus } from '../../../shared/contracts/index.ts';
import type { CaseId, CreateGroupInput, GroupId, GroupInfo, GroupMember, UpdateGroupInput } from '../types.ts';

const GROUP_STATUSES = new Set(['ACTIVE', 'ARCHIVED', 'DELETED']);
const CASE_STATUSES = new Set(['INTAKE_DONE', 'PRETEST_DONE', 'INTERVENTION', 'CLOSED']);

const GROUP_COLUMNS = 'id, name, remark, status, created_at, updated_at';

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AppError('INVALID_DATABASE_RESULT', `小组数据字段 ${field} 无效。`);
  return value;
}

function parseGroup(row: Record<string, unknown>): GroupInfo {
  const status = text(row.status, 'status');
  if (!GROUP_STATUSES.has(status)) throw new AppError('INVALID_DATABASE_RESULT', '小组状态无效。');
  return {
    id: parseLocalId<'group_info'>(row.id),
    name: text(row.name, 'name'),
    remark: row.remark === null ? null : text(row.remark, 'remark'),
    status: status as GroupStatus,
    createdAt: text(row.created_at, 'created_at'),
    updatedAt: text(row.updated_at, 'updated_at'),
  };
}

export class GroupRepository {
  async create(tx: DatabaseTransaction, input: CreateGroupInput, at: string): Promise<GroupId> {
    const result = await tx.run(
      "INSERT INTO group_info (name, remark, status, created_at, updated_at) VALUES (?, ?, 'ACTIVE', ?, ?)",
      [input.name, input.remark, at, at],
    );
    return parseLocalId<'group_info'>(result.lastInsertId);
  }

  async findById(reader: DatabaseReader, groupId: GroupId): Promise<GroupInfo | null> {
    const rows = await reader.query(`SELECT ${GROUP_COLUMNS} FROM group_info WHERE id = ?`, [groupId]);
    return rows[0] ? parseGroup(rows[0]) : null;
  }

  /** 已删除小组不展示；归档小组作为历史保留。 */
  async list(reader: DatabaseReader): Promise<GroupInfo[]> {
    const rows = await reader.query(`SELECT ${GROUP_COLUMNS} FROM group_info WHERE status <> 'DELETED' ORDER BY created_at DESC, id DESC`);
    return rows.map(parseGroup);
  }

  async update(tx: DatabaseTransaction, groupId: GroupId, input: UpdateGroupInput, at: string): Promise<boolean> {
    const result = await tx.run('UPDATE group_info SET name = ?, remark = ?, updated_at = ? WHERE id = ? AND status <> ?', [input.name, input.remark, at, groupId, 'DELETED']);
    return result.changes === 1;
  }

  async archive(tx: DatabaseTransaction, groupId: GroupId, at: string): Promise<boolean> {
    const result = await tx.run("UPDATE group_info SET status = 'ARCHIVED', updated_at = ? WHERE id = ? AND status = 'ACTIVE'", [at, groupId]);
    return result.changes === 1;
  }

  async listMembers(reader: DatabaseReader, groupId: GroupId): Promise<GroupMember[]> {
    const rows = await reader.query(
      'SELECT gm.case_id, c.child_code, c.full_name, c.status FROM group_member gm JOIN case_info c ON c.id = gm.case_id WHERE gm.group_id = ? ORDER BY c.child_code',
      [groupId],
    );
    return rows.map(row => {
      const status = text(row.status, 'status');
      if (!CASE_STATUSES.has(status)) throw new AppError('INVALID_DATABASE_RESULT', '成员个案状态无效。');
      return {
        caseId: parseLocalId<'case_info'>(row.case_id),
        childCode: text(row.child_code, 'child_code'),
        fullName: text(row.full_name, 'full_name'),
        status: status as CaseStatus,
      };
    });
  }

  async hasMember(reader: DatabaseReader, groupId: GroupId, caseId: CaseId): Promise<boolean> {
    const rows = await reader.query('SELECT case_id FROM group_member WHERE group_id = ? AND case_id = ?', [groupId, caseId]);
    return rows.length > 0;
  }

  async addMember(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId): Promise<void> {
    await tx.run('INSERT INTO group_member (group_id, case_id) VALUES (?, ?)', [groupId, caseId]);
  }

  /** 移除成员直接删除当前关系行；课程进度、课堂历史与统计不随之删除。 */
  async removeMember(tx: DatabaseTransaction, groupId: GroupId, caseId: CaseId): Promise<boolean> {
    const result = await tx.run('DELETE FROM group_member WHERE group_id = ? AND case_id = ?', [groupId, caseId]);
    return result.changes === 1;
  }
}

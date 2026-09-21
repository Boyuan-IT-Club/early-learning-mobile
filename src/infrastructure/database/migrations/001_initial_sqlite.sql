-- 移动端 SQLite 初始化：18 张业务表。
-- 依据：冻结《技术方案》及第三部分模块细化文档；不包含云端 MySQL 表。
-- 用于首次建库；IF NOT EXISTS 允许在相同结构上重跑，但不会修正已有表结构。
-- 后续结构变更请新增迁移，不要修改已执行的初始化迁移。
--
-- 每次打开连接都须在事务外启用 foreign_keys。
-- 本脚本自带事务；接入迁移工具时勿再嵌套事务，失败时由调用方执行 ROLLBACK。
-- 迁移版本由调用方管理，本脚本不改写 PRAGMA user_version。
-- 时间默认使用 UTC ISO 8601；updated_at 仅在插入时默认赋值，更新时由业务层赋值。
-- JSON 按冻结方案保存为 TEXT，完整 Schema 与业务规则由 TypeScript 层校验。
-- 跨表状态推进、统计更新、JSON 内资源引用检查由业务层在相应事务中完成。
-- 稳定 Code 同步使用 UPDATE / UPSERT 保留本地 id，不使用 INSERT OR REPLACE。
-- 问答改为 AI 0/1/2 分；两种均分共用分母，最终分不强制高于首次分。
-- ActivityConfig / ActivityResult / AIScore 的 schema_version 为 2；量表和恢复位置为 1。
-- 旧库不能靠重跑本脚本升级；旧布尔判断也不能直接换算为 AI 得分。

PRAGMA foreign_keys = ON;

BEGIN IMMEDIATE;

-- 1. 用户本地账户
CREATE TABLE IF NOT EXISTS user_local_account (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    access_token  TEXT,
    refresh_token TEXT
);

-- 2. 本地业务文件
-- 删除标记使用 status=DELETED，与《技术方案》的文件表一致。
CREATE TABLE IF NOT EXISTS storage_local_file (
    id            INTEGER PRIMARY KEY,
    file_code     TEXT NOT NULL UNIQUE,
    file_name     TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    file_kind     TEXT NOT NULL
                  CHECK (file_kind IN ('AUDIO', 'PDF', 'EXPORT', 'BACKUP', 'IMAGE')),
    mime_type     TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL CHECK (size_bytes >= 0),
    duration_ms   INTEGER CHECK (duration_ms >= 0),
    status        TEXT NOT NULL DEFAULT 'READY'
                  CHECK (status IN ('READY', 'INVALID', 'DELETED')),
    sha256        TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 3. 固定题型库：不保存具体题目
CREATE TABLE IF NOT EXISTS question_bank (
    id          INTEGER PRIMARY KEY,
    type_code   TEXT NOT NULL UNIQUE
                CHECK (type_code IN ('IMAGE_SORTING', 'QUESTION_ANSWERING', 'STORY_NARRATION')),
    name        TEXT NOT NULL,
    description TEXT,
    config_hint TEXT,
    status      TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'DISABLED'))
);

-- 4. 语法要素
CREATE TABLE IF NOT EXISTS grammar (
    id           INTEGER PRIMARY KEY,
    grammar_code TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    version      INTEGER NOT NULL,
    icon_file_id INTEGER REFERENCES storage_local_file(id),
    status       TEXT NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE', 'DISABLED')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 5. 个案信息
CREATE TABLE IF NOT EXISTS case_info (
    id             INTEGER PRIMARY KEY,
    full_name      TEXT NOT NULL,
    birth_date     TEXT NOT NULL,
    sex            TEXT NOT NULL CHECK (sex IN ('MALE', 'FEMALE', 'UNKNOWN')),
    guardian_phone TEXT NOT NULL,
    guardian_name  TEXT NOT NULL,
    child_code     TEXT NOT NULL UNIQUE,
    teacher_id     INTEGER NOT NULL REFERENCES user_local_account(id),
    status         TEXT NOT NULL DEFAULT 'INTAKE_DONE'
                   CHECK (status IN ('INTAKE_DONE', 'PRETEST_DONE', 'INTERVENTION', 'CLOSED')),
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 6. 个案康复统计缓存
CREATE TABLE IF NOT EXISTS case_progress_stats (
    case_id             INTEGER PRIMARY KEY REFERENCES case_info(id),
    lesson_count        INTEGER NOT NULL DEFAULT 0 CHECK (lesson_count >= 0),
    answer_num          INTEGER NOT NULL DEFAULT 0 CHECK (answer_num >= 0),
    before_hint_score_sum INTEGER NOT NULL DEFAULT 0 CHECK (before_hint_score_sum >= 0),
    final_score_sum       INTEGER NOT NULL DEFAULT 0 CHECK (final_score_sum >= 0),
    CHECK (before_hint_score_sum <= 2 * answer_num),
    CHECK (final_score_sum <= 2 * answer_num)
);

-- 7. 个案语法统计缓存
CREATE TABLE IF NOT EXISTS case_grammar_stats (
    case_id                 INTEGER NOT NULL REFERENCES case_info(id),
    grammar_id              INTEGER NOT NULL REFERENCES grammar(id),
    total_num               INTEGER NOT NULL DEFAULT 0 CHECK (total_num >= 0),
    before_hint_score_sum    INTEGER NOT NULL DEFAULT 0 CHECK (before_hint_score_sum >= 0),
    final_score_sum          INTEGER NOT NULL DEFAULT 0 CHECK (final_score_sum >= 0),
    updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (case_id, grammar_id),
    CHECK (before_hint_score_sum <= 2 * total_num),
    CHECK (final_score_sum <= 2 * total_num)
);

-- 8. 教学小组
CREATE TABLE IF NOT EXISTS group_info (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    remark     TEXT,
    status     TEXT NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DELETED')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 9. 当前小组成员：移出成员不删除其进度和历史课堂
CREATE TABLE IF NOT EXISTS group_member (
    group_id INTEGER NOT NULL REFERENCES group_info(id),
    case_id  INTEGER NOT NULL REFERENCES case_info(id),
    PRIMARY KEY (group_id, case_id)
);

-- 10. 前测 / 复评材料
CREATE TABLE IF NOT EXISTS assessment_material (
    id                     INTEGER PRIMARY KEY,
    official_material_code TEXT NOT NULL,
    content_version        TEXT NOT NULL,
    name                   TEXT NOT NULL,
    activity_configs_json  TEXT NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'ACTIVE'
                           CHECK (status IN ('ACTIVE', 'DISABLED')),
    created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (official_material_code, content_version)
);

-- 11. 前测 / 初筛 / 复评记录
-- PRETEST 可暂不关联个案；归档时仍保留 PRETEST 类型。
CREATE TABLE IF NOT EXISTS assessment (
    id                    INTEGER PRIMARY KEY,
    case_id               INTEGER REFERENCES case_info(id),
    material_id           INTEGER NOT NULL REFERENCES assessment_material(id),
    assessment_type       TEXT NOT NULL
                          CHECK (assessment_type IN ('PRETEST', 'INITIAL_SCREENING', 'REASSESSMENT')),
    assessment_date       TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'RECORDING', 'PROCESSING', 'PENDING_CONFIRM', 'CONFIRMED', 'VOID')),
    narrative_file_id     INTEGER REFERENCES storage_local_file(id),
    narrative_text        TEXT,
    activity_results_json TEXT NOT NULL DEFAULT '{"schema_version":2,"rubric_version":null,"activity_results":[]}',
    ai_score_json         TEXT,
    processing_status     TEXT NOT NULL DEFAULT 'NOT_STARTED'
                          CHECK (processing_status IN ('NOT_STARTED', 'TRANSCRIBING', 'WAITING_CONFIRM', 'SCORING', 'DONE', 'FAILED')),
    teacher_conclusion    TEXT,
    report_file_id        INTEGER REFERENCES storage_local_file(id),
    report_status         TEXT NOT NULL DEFAULT 'NONE'
                          CHECK (report_status IN ('NONE', 'GENERATING', 'READY', 'FAILED')),
    void_reason           TEXT,
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (assessment_type = 'PRETEST' OR case_id IS NOT NULL)
);

-- 12. 课程：官方课程各版本保留独立行，私人课程不带官方 Code
CREATE TABLE IF NOT EXISTS course (
    id                    INTEGER PRIMARY KEY,
    source                TEXT NOT NULL CHECK (source IN ('OFFICIAL', 'PRIVATE')),
    official_course_code  TEXT,
    content_version       TEXT,
    name                  TEXT NOT NULL,
    activity_configs_json TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETED')),
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (official_course_code, content_version),
    CHECK (
        (source = 'OFFICIAL' AND official_course_code IS NOT NULL AND content_version IS NOT NULL)
        OR (source = 'PRIVATE' AND official_course_code IS NULL)
    )
);

-- 13. 干预计划：个人与小组归属二选一
CREATE TABLE IF NOT EXISTS plan (
    id           INTEGER PRIMARY KEY,
    plan_type    TEXT NOT NULL CHECK (plan_type IN ('INDIVIDUAL', 'GROUP')),
    case_id      INTEGER REFERENCES case_info(id),
    group_id     INTEGER REFERENCES group_info(id),
    name         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED')),
    completed_at TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
        (plan_type = 'INDIVIDUAL' AND case_id IS NOT NULL AND group_id IS NULL)
        OR (plan_type = 'GROUP' AND group_id IS NOT NULL AND case_id IS NULL)
    )
);

-- 14. 计划课程安排
CREATE TABLE IF NOT EXISTS plan_course (
    id          INTEGER PRIMARY KEY,
    plan_id     INTEGER NOT NULL REFERENCES plan(id),
    course_id   INTEGER NOT NULL REFERENCES course(id),
    sequence_no INTEGER NOT NULL,
    UNIQUE (plan_id, sequence_no)
);

-- 15. 个案课程进度
CREATE TABLE IF NOT EXISTS course_case_progress (
    id                INTEGER PRIMARY KEY,
    case_id           INTEGER NOT NULL REFERENCES case_info(id),
    plan_course_id    INTEGER NOT NULL REFERENCES plan_course(id),
    status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'STOPPED')),
    resume_state_json TEXT NOT NULL DEFAULT '{}',
    completed_at      TEXT,
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (case_id, plan_course_id)
);

-- 16. 个案课堂实例：逐题两次回答及其 AI 评分保存在 activity_results_json
CREATE TABLE IF NOT EXISTS course_instance (
    id                    INTEGER PRIMARY KEY,
    progress_id           INTEGER NOT NULL REFERENCES course_case_progress(id),
    status                TEXT NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'PENDING_AI', 'COMPLETED', 'VOID')),
    activity_results_json TEXT NOT NULL DEFAULT '{"schema_version":2,"rubric_version":null,"activity_results":[]}',
    audio_file_id         INTEGER REFERENCES storage_local_file(id),
    transcript_text       TEXT,
    ai_score_json         TEXT,
    scale_scores_json     TEXT NOT NULL DEFAULT '{"schema_version":1,"scores":[]}',
    started_at            TEXT,
    completed_at          TEXT,
    void_reason           TEXT
);

-- 一个进度最多一个非 VOID 课堂，COMPLETED 也占用此唯一位置。
-- 未完成课堂作废后可新建课堂；COMPLETED 不可作废的状态转换由业务层校验。
CREATE UNIQUE INDEX IF NOT EXISTS uq_course_instance_non_void_progress
    ON course_instance(progress_id)
    WHERE status <> 'VOID';

-- 17. 字典条目：无版本字段，按 entry_code 更新并保留本地 id
CREATE TABLE IF NOT EXISTS dict_entry (
    id         INTEGER PRIMARY KEY,
    entry_code TEXT NOT NULL UNIQUE,
    term       TEXT NOT NULL,
    pinyin     TEXT,
    definition TEXT NOT NULL
);

-- 18. 词语位置：引用具体课程版本对应的本地 course.id
CREATE TABLE IF NOT EXISTS dict_gloss (
    id           INTEGER PRIMARY KEY,
    course_id    INTEGER NOT NULL REFERENCES course(id),
    entry_id     INTEGER NOT NULL REFERENCES dict_entry(id),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset   INTEGER NOT NULL CHECK (end_offset >= start_offset)
);

-- 外键查询与主要列表索引；主键和 UNIQUE 已自动建立相应索引。
CREATE INDEX IF NOT EXISTS idx_grammar_icon_file
    ON grammar(icon_file_id);
CREATE INDEX IF NOT EXISTS idx_case_info_teacher_status
    ON case_info(teacher_id, status);
CREATE INDEX IF NOT EXISTS idx_case_grammar_stats_grammar
    ON case_grammar_stats(grammar_id);
CREATE INDEX IF NOT EXISTS idx_group_member_case
    ON group_member(case_id);
CREATE INDEX IF NOT EXISTS idx_assessment_case_date
    ON assessment(case_id, assessment_date DESC);
CREATE INDEX IF NOT EXISTS idx_assessment_material
    ON assessment(material_id);
CREATE INDEX IF NOT EXISTS idx_assessment_narrative_file
    ON assessment(narrative_file_id);
CREATE INDEX IF NOT EXISTS idx_assessment_report_file
    ON assessment(report_file_id);
CREATE INDEX IF NOT EXISTS idx_plan_case_status
    ON plan(case_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_group_status
    ON plan(group_id, status);
CREATE INDEX IF NOT EXISTS idx_plan_course_course
    ON plan_course(course_id);
CREATE INDEX IF NOT EXISTS idx_course_case_progress_plan_course_status
    ON course_case_progress(plan_course_id, status);
CREATE INDEX IF NOT EXISTS idx_course_instance_progress
    ON course_instance(progress_id);
CREATE INDEX IF NOT EXISTS idx_course_instance_audio_file
    ON course_instance(audio_file_id);
CREATE INDEX IF NOT EXISTS idx_dict_gloss_course
    ON dict_gloss(course_id);
CREATE INDEX IF NOT EXISTS idx_dict_gloss_entry
    ON dict_gloss(entry_id);

-- 固定题型初始数据：重跑时不覆盖现有记录，也不固定其本地 id。
INSERT INTO question_bank (type_code, name, description, config_hint, status)
VALUES
    ('IMAGE_SORTING', '图片排序', '儿童按照故事内容排列图片。',
     '上传课程图片，并填写图片的正确排序顺序。', 'ACTIVE'),
    ('QUESTION_ANSWERING', '问题问答', '分别记录提示前后回答，由 AI 按 0、1、2 分评分。',
     '填写问题、提示及语法要素；统一评分规则由服务端维护。', 'ACTIVE'),
    ('STORY_NARRATION', '故事叙述', '儿童叙述故事，录音用于转写与 AI 评分。',
     '上传或录制标准故事音频，并填写故事文本。', 'ACTIVE')
ON CONFLICT(type_code) DO NOTHING;

COMMIT;

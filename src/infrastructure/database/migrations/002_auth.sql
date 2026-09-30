-- 002 账号与鉴权（01_账号与鉴权 v0.2 第 4.5 节）
-- 只给 user_local_account 加列，不加表、不改 001。
-- 一台设备只绑定一个教师账号：本表最多一行。
-- 不带事务控制与 PRAGMA：由迁移器统一包进事务并写 user_version。

-- 云端身份与设备
ALTER TABLE user_local_account ADD COLUMN cloud_user_id INTEGER;
ALTER TABLE user_local_account ADD COLUMN device_id TEXT;

-- 最近一次从云端同步到的状态：停用断网、重启后仍然有效（PRD 2.2-6、12.2）
ALTER TABLE user_local_account ADD COLUMN account_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (account_status IN ('ACTIVE', 'DISABLED', 'REVOKED', 'UNBOUND'));
-- LOST = refresh_token 已失效，需要管理员签发恢复码；本地业务不受影响
ALTER TABLE user_local_account ADD COLUMN cloud_session TEXT NOT NULL DEFAULT 'OK'
    CHECK (cloud_session IN ('OK', 'LOST'));
ALTER TABLE user_local_account ADD COLUMN status_synced_at TEXT;

-- 本地登录失败锁定：落库，重启不清零
ALTER TABLE user_local_account ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_local_account ADD COLUMN locked_until TEXT;

-- 教师资料（PRD 2.3），只存本地，不上传云端
ALTER TABLE user_local_account ADD COLUMN real_name TEXT;
ALTER TABLE user_local_account ADD COLUMN professional_background TEXT;
ALTER TABLE user_local_account ADD COLUMN job_title TEXT;
ALTER TABLE user_local_account ADD COLUMN organization TEXT;
ALTER TABLE user_local_account ADD COLUMN years_of_experience INTEGER;
ALTER TABLE user_local_account ADD COLUMN work_experience TEXT;
ALTER TABLE user_local_account ADD COLUMN teaching_expertise TEXT;

ALTER TABLE user_local_account ADD COLUMN created_at TEXT;
ALTER TABLE user_local_account ADD COLUMN updated_at TEXT;

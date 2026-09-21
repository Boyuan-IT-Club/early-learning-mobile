/** 仅定义冻结值，不在公共层定义哪些业务事件允许转换状态。 */
export type Sex = 'MALE' | 'FEMALE' | 'UNKNOWN';
export type CaseStatus = 'INTAKE_DONE' | 'PRETEST_DONE' | 'INTERVENTION' | 'CLOSED';
export type GroupStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';
export type AssessmentType = 'PRETEST' | 'INITIAL_SCREENING' | 'REASSESSMENT';
export type AssessmentStatus = 'DRAFT' | 'RECORDING' | 'PROCESSING' | 'PENDING_CONFIRM' | 'CONFIRMED' | 'VOID';
export type AssessmentProcessingStatus = 'NOT_STARTED' | 'TRANSCRIBING' | 'WAITING_CONFIRM' | 'SCORING' | 'DONE' | 'FAILED';
export type ReportStatus = 'NONE' | 'GENERATING' | 'READY' | 'FAILED';
export type PlanType = 'INDIVIDUAL' | 'GROUP';
export type PlanStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type CourseSource = 'OFFICIAL' | 'PRIVATE';
export type CourseStatus = 'ACTIVE' | 'DISABLED' | 'DELETED';
export type ContentStatus = 'ACTIVE' | 'DISABLED';
export type CourseProgressStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'STOPPED';
export type ClassroomStatus = 'DRAFT' | 'IN_PROGRESS' | 'PENDING_AI' | 'COMPLETED' | 'VOID';
export type LocalFileStatus = 'READY' | 'INVALID' | 'DELETED';
export type FileKind = 'AUDIO' | 'PDF' | 'EXPORT' | 'BACKUP' | 'IMAGE';

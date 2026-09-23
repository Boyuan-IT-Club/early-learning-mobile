import type { Database, DatabaseTransaction } from '../../../infrastructure/database/index.ts';
import {
  AppError, assertAIScoreComplete, parseActivityResults, parseAIScore, parseScaleScores, toIsoDateTime,
  type ActivityResultsJson, type AIScore, type QuestionAIScore, type ResumeState, type ScaleScores,
} from '../../../shared/contracts/index.ts';
import { ClassroomRepository } from '../repositories/classroom-repository.ts';
import type { AnswerStage, Classroom, ClassroomId, LocalFileId, PlanId, ProgressId } from '../types.ts';
import {
  assertClassroomComplete, assertClassroomCourse, assertCollectionComplete, assertResultsMatchConfig, mergeCollectedResults,
} from '../validation.ts';

export interface ClassroomProgressCoordinator {
  start(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<void>;
  complete(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<PlanId>;
  restoreAfterVoid(tx: DatabaseTransaction, progressId: ProgressId, at: string): Promise<'PENDING' | 'STOPPED'>;
}

export interface ClassroomStatisticsCoordinator {
  recordCompletedClassroom(tx: DatabaseTransaction, classroomId: ClassroomId): Promise<void>;
}

export interface ClassroomPlanCoordinator {
  checkCompletion(tx: DatabaseTransaction, planId: PlanId, at: string): Promise<boolean>;
}

export interface ClassroomFileCoordinator {
  assertReadyAudioFile(reader: DatabaseTransaction, fileId: LocalFileId): Promise<void>;
  assertReadyAudioCodes(reader: DatabaseTransaction, fileCodes: readonly string[]): Promise<void>;
}

export class ClassroomService {
  readonly #database: Database;
  readonly #repository: ClassroomRepository;
  readonly #progress: ClassroomProgressCoordinator;
  readonly #statistics: ClassroomStatisticsCoordinator;
  readonly #plans: ClassroomPlanCoordinator;
  readonly #files: ClassroomFileCoordinator;
  readonly #now: () => Date;

  constructor(
    database: Database,
    repository: ClassroomRepository,
    progress: ClassroomProgressCoordinator,
    statistics: ClassroomStatisticsCoordinator,
    plans: ClassroomPlanCoordinator,
    files: ClassroomFileCoordinator,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#repository = repository;
    this.#progress = progress;
    this.#statistics = statistics;
    this.#plans = plans;
    this.#files = files;
    this.#now = now;
  }

  get(classroomId: ClassroomId): Promise<Classroom | null> {
    return this.#database.read(reader => this.#repository.findById(reader, classroomId));
  }

  createOrResume(progressId: ProgressId): Promise<ClassroomId> {
    return this.#database.transaction(async tx => {
      const context = await this.requireUsableContext(tx, progressId);
      assertClassroomCourse(context.config);
      const existing = await this.#repository.findActiveByProgress(tx, progressId);
      if (existing) {
        if (existing.status === 'COMPLETED') throw new AppError('CLASSROOM_COMPLETED', '该课程进度已有已完成课堂。');
        return existing.id;
      }
      const at = toIsoDateTime(this.#now());
      await this.#progress.start(tx, progressId, at);
      return this.#repository.create(tx, progressId);
    });
  }

  saveActivityResults(classroomId: ClassroomId, value: ActivityResultsJson): Promise<void> {
    return this.#database.transaction(async tx => {
      const classroom = await this.requireEditable(tx, classroomId);
      const context = await this.requireUsableContext(tx, classroom.progressId);
      const incoming = parseActivityResults(value);
      assertResultsMatchConfig(context.config, incoming, false);
      const audioCodes = incoming.activity_results.flatMap(result => result.type === 'QUESTION_ANSWERING'
        ? result.result.answers.flatMap(answer => answer.status === 'ANSWERED'
          ? [answer.before_hint.audio_file_code, answer.hint_used ? answer.after_hint.audio_file_code : null]
          : []).filter(code => code !== null)
        : []);
      await this.#files.assertReadyAudioCodes(tx, audioCodes);
      const merged = mergeCollectedResults(classroom.activityResults, incoming);
      await this.#repository.saveActivityResults(tx, classroomId, JSON.stringify(merged));
    });
  }

  saveNarration(classroomId: ClassroomId, audioFileId: LocalFileId, confirmedTranscript: string): Promise<void> {
    return this.#database.transaction(async tx => {
      const classroom = await this.requireEditable(tx, classroomId);
      await this.requireUsableContext(tx, classroom.progressId);
      await this.#files.assertReadyAudioFile(tx, audioFileId);
      const changed = classroom.audioFileId !== audioFileId || classroom.transcriptText !== confirmedTranscript;
      await this.#repository.saveNarration(tx, classroomId, audioFileId, confirmedTranscript, changed);
    });
  }

  saveQuestionScore(
    classroomId: ClassroomId,
    activityId: string,
    questionId: string,
    stage: AnswerStage,
    expectedTranscript: string,
    value: QuestionAIScore,
  ): Promise<void> {
    return this.#database.transaction(async tx => {
      const classroom = await this.requireEditable(tx, classroomId);
      await this.requireUsableContext(tx, classroom.progressId);
      const results = structuredClone(classroom.activityResults);
      const activity = results.activity_results.find(item => item.type === 'QUESTION_ANSWERING' && item.activity_id === activityId);
      const answer = activity?.type === 'QUESTION_ANSWERING' ? activity.result.answers.find(item => item.question_id === questionId) : undefined;
      if (!answer || answer.status !== 'ANSWERED') throw new AppError('ANSWER_NOT_FOUND', '未找到对应的已回答题目。');
      if (stage === 'after_hint' && !answer.hint_used) throw new AppError('ANSWER_STAGE_MISMATCH', '该题未使用提示，不能保存提示后评分。');
      const attempt = stage === 'before_hint' ? answer.before_hint : answer.hint_used ? answer.after_hint : null;
      if (!attempt || attempt.transcript_text !== expectedTranscript) throw new AppError('STALE_AI_RESULT', '回答内容已变化，旧评分未保存。');
      const rubric = results.rubric_version ?? value.rubric_version;
      if (value.rubric_version !== rubric) throw new AppError('RUBRIC_VERSION_MISMATCH', '评分版本与本次课堂不一致。');
      results.rubric_version = rubric;
      attempt.ai_score = value;
      // 复用正式解析器校验证据偏移、分值、理由和版本。
      const validated = parseActivityResults(results);
      await this.#repository.saveScoredActivityResults(tx, classroomId, JSON.stringify(validated));
    });
  }

  saveStoryScore(classroomId: ClassroomId, expectedTranscript: string, value: AIScore): Promise<void> {
    return this.#database.transaction(async tx => {
      const classroom = await this.requireEditable(tx, classroomId);
      const context = await this.requireUsableContext(tx, classroom.progressId);
      if (classroom.transcriptText !== expectedTranscript) throw new AppError('STALE_AI_RESULT', '故事文本已变化，旧评分未保存。');
      const score = parseAIScore(value);
      const rubric = classroom.activityResults.rubric_version ?? score.rubric_version;
      if (score.rubric_version !== rubric) throw new AppError('RUBRIC_VERSION_MISMATCH', '评分版本与本次课堂不一致。');
      assertAIScoreComplete(score, context.config, expectedTranscript, rubric);
      if (classroom.activityResults.rubric_version === null) {
        const results = { ...classroom.activityResults, rubric_version: rubric };
        await this.#repository.saveActivityResults(tx, classroomId, JSON.stringify(results));
      }
      await this.#repository.saveStoryScore(tx, classroomId, JSON.stringify(score));
    });
  }

  saveScaleScores(classroomId: ClassroomId, value: ScaleScores): Promise<void> {
    return this.#database.transaction(async tx => {
      const classroom = await this.requireEditable(tx, classroomId);
      await this.requireUsableContext(tx, classroom.progressId);
      const scale = parseScaleScores(value);
      if (!scale) throw new AppError('INVALID_SCALE_SCORES', '十题评价格式无效。');
      await this.#repository.saveScaleScores(tx, classroomId, JSON.stringify(scale));
    });
  }

  markPendingAi(classroomId: ClassroomId): Promise<void> {
    return this.#database.transaction(async tx => {
      const classroom = await this.requireEditable(tx, classroomId);
      const context = await this.requireUsableContext(tx, classroom.progressId);
      assertCollectionComplete(context.config, classroom.activityResults);
      if (classroom.audioFileId === null || classroom.transcriptText === null) throw new AppError('NARRATION_NOT_CONFIRMED', '故事录音和教师确认文本必须完整。');
      await this.#repository.markPendingAi(tx, classroomId, toIsoDateTime(this.#now()));
    });
  }

  complete(classroomId: ClassroomId): Promise<void> {
    return this.#database.transaction(async tx => {
      const classroom = await this.require(tx, classroomId);
      if (classroom.status === 'COMPLETED') return;
      if (classroom.status !== 'PENDING_AI') throw new AppError('CLASSROOM_NOT_READY', '课堂尚未进入待完成状态。');
      const context = await this.requireUsableContext(tx, classroom.progressId);
      assertClassroomComplete(context.config, classroom.activityResults, classroom.audioFileId, classroom.transcriptText, classroom.aiScore, classroom.scaleScores);
      const at = toIsoDateTime(this.#now());
      if (!await this.#repository.markCompleted(tx, classroomId, at)) throw new AppError('CLASSROOM_STATE_CONFLICT', '课堂状态已变化，请刷新后重试。');
      const planId = await this.#progress.complete(tx, classroom.progressId, at);
      await this.#statistics.recordCompletedClassroom(tx, classroomId);
      await this.#plans.checkCompletion(tx, planId, at);
    });
  }

  void(classroomId: ClassroomId, reason: string): Promise<'PENDING' | 'STOPPED'> {
    return this.#database.transaction(async tx => {
      const classroom = await this.require(tx, classroomId);
      if (classroom.status === 'COMPLETED') throw new AppError('CLASSROOM_COMPLETED', '已完成课堂不能作废。');
      if (classroom.status === 'VOID') throw new AppError('CLASSROOM_ALREADY_VOID', '课堂已作废。');
      const cleanReason = reason.trim();
      if (!cleanReason) throw new AppError('VOID_REASON_REQUIRED', '作废原因不能为空。');
      if (!await this.#repository.markVoid(tx, classroomId, cleanReason)) throw new AppError('CLASSROOM_STATE_CONFLICT', '课堂状态已变化，请刷新后重试。');
      return this.#progress.restoreAfterVoid(tx, classroom.progressId, toIsoDateTime(this.#now()));
    });
  }

  async assertValidForProgress(reader: DatabaseTransaction, progressId: ProgressId, state: ResumeState): Promise<void> {
    const context = await this.#repository.getContext(reader, progressId);
    if (!context) throw new AppError('PROGRESS_NOT_FOUND', '课程进度不存在。');
    const activities = context.config.activities;
    const ids = activities.map(activity => activity.activity_id);
    if (state.current_activity_id !== null && !ids.includes(state.current_activity_id)) throw new AppError('INVALID_RESUME_STATE', '恢复位置中的活动不存在。');
    if (state.completed_activity_ids.some(id => !ids.includes(id)) || new Set(state.completed_activity_ids).size !== state.completed_activity_ids.length) {
      throw new AppError('INVALID_RESUME_STATE', '已完成活动列表无效。');
    }
    if (state.current_item_id !== null) {
      const activity = activities.find(item => item.activity_id === state.current_activity_id);
      const itemIds = activity?.type === 'QUESTION_ANSWERING' ? activity.config.questions.map(item => item.question_id)
        : activity?.type === 'IMAGE_SORTING' ? activity.config.items.map(item => item.item_id)
          : activity?.type === 'STORY_NARRATION' ? activity.config.content_items.map(item => item.content_item_id) : [];
      if (!itemIds.includes(state.current_item_id)) throw new AppError('INVALID_RESUME_STATE', '恢复位置中的活动项目不存在。');
    }
  }

  private async require(reader: DatabaseTransaction, classroomId: ClassroomId): Promise<Classroom> {
    const classroom = await this.#repository.findById(reader, classroomId);
    if (!classroom) throw new AppError('CLASSROOM_NOT_FOUND', '课堂不存在。');
    return classroom;
  }

  private async requireEditable(reader: DatabaseTransaction, classroomId: ClassroomId): Promise<Classroom> {
    const classroom = await this.require(reader, classroomId);
    if (classroom.status === 'COMPLETED' || classroom.status === 'VOID') throw new AppError('CLASSROOM_NOT_EDITABLE', '当前课堂不能继续编辑。');
    return classroom;
  }

  private async requireUsableContext(reader: DatabaseTransaction, progressId: ProgressId) {
    const context = await this.#repository.getContext(reader, progressId);
    if (!context) throw new AppError('PROGRESS_NOT_FOUND', '课程进度不存在。');
    if (context.planStatus !== 'ACTIVE' || !context.participantEligible || context.progressStatus === 'STOPPED') {
      throw new AppError('CLASSROOM_PARTICIPATION_STOPPED', '计划或成员状态不允许继续课堂。');
    }
    if (context.progressStatus === 'COMPLETED') throw new AppError('PROGRESS_COMPLETED', '已完成的课程进度不能再次执行。');
    return context;
  }
}

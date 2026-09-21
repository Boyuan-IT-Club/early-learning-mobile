/** code 用于程序判断；message 必须为安全文案，不附带 SQL、Token 或儿童原文。 */
export class AppError<Code extends string = string> extends Error {
  readonly code: Code;

  constructor(code: Code, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

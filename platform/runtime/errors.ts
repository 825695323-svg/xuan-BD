export class ConfigError extends Error {
  constructor(message = '模型尚未配置。请核对运行工作根的模型连接配置与凭据引用。') {
    super(message);
    this.name = 'ConfigError';
  }
}

export class BackendAbortedError extends Error {
  constructor() {
    super('当前生成已停止。');
    this.name = 'BackendAbortedError';
  }
}

export class SessionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionInvalidError';
  }
}

export class CoreError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = 'CoreError';
  }
}


/** 本地资料停用/解绑的明确控制错误；沿用现有本机错误出口，未决与不可用由 code 区分。 */
export class LocalDataLifecycleError extends CoreError {
  constructor(code: string, message: string, status = 409) {
    super(code, message, status);
    this.name = 'LocalDataLifecycleError';
  }
}

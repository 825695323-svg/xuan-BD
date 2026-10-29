export class DataServiceError extends Error {
  declare code: string;
  declare mayHaveBeenAccepted: boolean;

  constructor(code: string, message: string, { mayHaveBeenAccepted = false }: { mayHaveBeenAccepted?: boolean } = {}) {
    super(message);
    this.name = 'DataServiceError';
    this.code = code;
    this.mayHaveBeenAccepted = mayHaveBeenAccepted;
  }
}

// Errors safe to show the client. `status` is used by REST, `code` by GraphQL (extensions.code).
export class AppError extends Error {
  constructor(message: string, public status: number, public code: string) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(`${what} not found`, 404, 'NOT_FOUND');

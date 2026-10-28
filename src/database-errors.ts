export class CommitUncertainError extends Error {
  constructor(cause: unknown) { super('Could not confirm relay transaction commit', { cause }); }
}

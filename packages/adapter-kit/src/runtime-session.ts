/** Safe to requeue: acquisition failed before any invocation or tool dispatch. */
export class RuntimeSessionBusyError extends Error {
  constructor() {
    super("The conversation runtime session is busy");
  }
}

import { type Event, type JsonObject, type QueryOperation, type QueryResult, type RunInput, type RunResult, type Workspace } from "./protocol.js";
export * from "./protocol.js";
export declare class TransportError extends Error {
}
export declare class InteractionRequired extends Error {
}
export interface ClientOptions {
    command?: readonly string[];
    cwd?: string;
    env?: {
        [key: string]: string | undefined;
    };
    shutdownGraceMs?: number;
    maxRecordBytes?: number;
}
export interface RunOptions {
    onEvent?: (event: Event) => void | Promise<void>;
    onInteraction?: (event: Event) => JsonObject[] | Promise<JsonObject[]>;
    onToolCall?: (event: Event) => unknown | Promise<unknown>;
    signal?: AbortSignal;
    deadlineMs?: number;
}
export interface QueryOptions {
    workspace?: Workspace;
    timeout_seconds?: number;
    deadlineMs?: number;
}
export declare class Client {
    private readonly options;
    private readonly command;
    private readonly grace;
    private readonly maxRecordBytes;
    constructor(options?: ClientOptions);
    run(request: RunInput, options?: RunOptions): Promise<RunResult>;
    query(operation: QueryOperation, params?: JsonObject, options?: QueryOptions): Promise<QueryResult>;
    private execute;
}

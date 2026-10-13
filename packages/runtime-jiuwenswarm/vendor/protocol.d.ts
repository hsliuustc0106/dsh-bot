export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type JsonObject = {
    [key: string]: Json;
};
export type Mode = "agent.code.normal" | "agent.code.plan" | "agent.work.normal" | "agent.work.plan";
export interface Workspace {
    cwd?: string | null;
    project_dir?: string | null;
    trusted_dirs?: string[];
}
export interface AgentDefinition {
    name: string;
    instructions: string;
    description?: string | null;
    model?: string | null;
    tools?: string[];
    skills?: string[];
    max_iterations?: number | null;
}
export interface RunInput {
    input: string;
    request_id?: string | null;
    session_id?: string | null;
    mode?: Mode | null;
    model?: string | null;
    skills?: string[] | null;
    mcp?: string[] | null;
    permissions?: {
        tools?: {
            [tool: string]: "allow" | "ask" | "deny";
        };
    } | null;
    output_schema?: JsonObject | null;
    max_turns?: number | null;
    max_budget_usd?: number | null;
    host_tools?: HostTool[];
    agent?: AgentDefinition | null;
    workspace?: Workspace | null;
    timeout_seconds?: number | null;
}
export interface HostTool {
    name: string;
    description: string;
    input_schema: JsonObject;
}
export interface TextPayload {
    text: string;
}
export interface ToolObservation {
    call_id: string;
    name: string;
    arguments: JsonObject | null;
    status: "started" | "completed" | "failed";
    result: Json;
}
export interface ToolPayload {
    tool: ToolObservation;
}
export interface InteractionQuestion {
    question_id: string;
    question: string;
    options: {
        value: string;
        label: string;
    }[];
    card_id: string | null;
    allow_custom_input: boolean;
}
export interface InteractionPayload {
    interaction_id: string;
    kind: "permission" | "question" | "confirmation";
    questions: InteractionQuestion[];
    interaction: JsonObject;
}
export interface HostToolPayload {
    call_id: string;
    name: string;
    arguments: JsonObject;
}
export interface ProtocolCapabilities {
    schema_version: string;
    supported_schema_versions: string[];
    protocol_revision: number;
    features: {
        [feature: string]: boolean;
    };
    run_fields: string[];
    query_operations: string[];
    control_types: string[];
    stable_event_types: string[];
    input_encoding: string;
    output_encoding: string;
    output_format: string;
    max_input_bytes: number;
    compatibility: {
        [rule: string]: string;
    };
}
export type QueryOperation = "protocol.capabilities" | "protocol.schema" | "session.get" | "session.list" | "model.list" | "model.resolve" | "mode.list" | "mode.resolve" | "permission.get" | "mcp.validate";
export interface RuntimeErrorInfo {
    code: string;
    message: string;
    retryable?: boolean;
    details?: JsonObject;
}
export interface Envelope {
    schema_version: "0.1";
    request_id: string;
    session_id: string | null;
    sequence: number;
}
export interface Event extends Envelope {
    type: "event";
    event_type: string;
    payload: Json;
}
export interface Terminal extends Envelope {
    status: "completed" | "failed" | "cancelled" | "timed_out";
    exit_code: number;
    error: RuntimeErrorInfo | null;
}
export interface RunResult extends Terminal {
    type: "result";
    output: string | null;
    output_json: JsonObject | null;
    usage: JsonObject;
}
export interface QueryResult extends Terminal {
    type: "query_result";
    operation: QueryOperation | null;
    data: JsonObject | null;
}
export type Record = Event | RunResult | QueryResult;
export declare class ProtocolError extends Error {
}
export declare function encode(value: unknown): Uint8Array;
export declare class Records {
    readonly requestId: string;
    readonly operation?: QueryOperation | undefined;
    private sequence;
    private sessionId;
    result: RunResult | QueryResult | undefined;
    constructor(requestId: string, operation?: QueryOperation | undefined);
    accept(line: Uint8Array): Record;
    private validateTerminal;
    finish(code: number | null): RunResult | QueryResult;
}
